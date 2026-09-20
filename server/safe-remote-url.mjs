import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fetchPinned } from './pinned-http.mjs';

export const CLASH_FAKE_IP_PROBES = Object.freeze(['example.com', 'iana.org']);
const DEFAULT_PROBE_CACHE_MS = 5 * 60 * 1000;

export function isClashFakeIpAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isClashFakeIpAddress(mapped);
  if (isIP(normalized) !== 4) return false;
  const [first, second] = normalized.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}

export function isPrivateAddress(address) {
  let normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(normalized) === 6) normalized = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const version = isIP(normalized);
  if (version === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || isClashFakeIpAddress(normalized)
      || a >= 224;
  }
  if (version === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return (first & 0xe000) !== 0x2000
      || first === 0x2002
      || normalized.startsWith('2001:db8:')
      || (first === 0x2001 && Number.parseInt(normalized.split(':')[1] || '0', 16) < 0x200)
      || (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00;
  }
  return false;
}

function normalizeLookupResults(results) {
  if (!Array.isArray(results)) return [];
  return results
    .map((entry) => typeof entry === 'string' ? entry : entry?.address)
    .filter((address) => typeof address === 'string' && isIP(address) !== 0);
}

/**
 * A URL guard that keeps literal/private destinations blocked while
 * tolerating Clash-style system DNS fake IPs. The exception is intentionally
 * environment-level, not hostname-level: at least two fixed public probes
 * must independently resolve only into 198.18.0.0/15 before that reserved
 * range is accepted for a hostname lookup.
 */
export function createSafeRemoteUrlGuard({
  lookupHostname = systemLookup,
  fetchImpl = fetchPinned,
  allowFakeIp = process.env.THOUGHTDAG_ALLOW_FAKE_IP === 'true',
  probeHostnames = CLASH_FAKE_IP_PROBES,
  probeCacheMs = DEFAULT_PROBE_CACHE_MS,
  now = Date.now,
} = {}) {
  if (!Array.isArray(probeHostnames) || probeHostnames.length < 2) {
    throw new TypeError('At least two fixed public fake-IP probes are required');
  }
  let probeCache = { value: false, expiresAt: 0 };
  let probeInFlight = null;

  const resolveAll = async (hostname) => normalizeLookupResults(
    await lookupHostname(hostname, { all: true, verbatim: true }),
  );

  const systemUsesClashFakeIp = async () => {
    const current = now();
    if (probeCache.expiresAt > current) return probeCache.value;
    if (probeInFlight) return probeInFlight;
    probeInFlight = Promise.all(probeHostnames.map(async (hostname) => {
      try {
        const addresses = await resolveAll(hostname);
        return addresses.length > 0 && addresses.every(isClashFakeIpAddress);
      } catch {
        return false;
      }
    })).then((results) => {
      const value = results.filter(Boolean).length >= 2;
      probeCache = { value, expiresAt: now() + probeCacheMs };
      return value;
    }).finally(() => { probeInFlight = null; });
    return probeInFlight;
  };

  const validateDestination = async (value) => {
    const parsed = value instanceof URL ? value : new URL(String(value));
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported');
    if (parsed.username || parsed.password) throw new Error('Credentialed URLs are not supported');
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('Refusing to fetch private addresses');
    }
    // Never apply the fake-IP exception to a literal. This also catches URL
    // parser-normalized decimal/octal IPv4 spellings and bracketed IPv6.
    if (isIP(hostname) !== 0) throw new Error('Refusing to fetch literal IP addresses');

    // Redirect destinations pass through this same lookup on every hop.
    const addresses = await resolveAll(hostname);
    if (addresses.length === 0) throw new Error('Refusing to fetch unresolved addresses');
    const hasClashFakeIp = addresses.some(isClashFakeIpAddress);
    const allowClashFakeIp = allowFakeIp && hasClashFakeIp && await systemUsesClashFakeIp();
    if (addresses.some((address) =>
      isPrivateAddress(address) && !(allowClashFakeIp && isClashFakeIpAddress(address))
    )) {
      throw new Error('Refusing to fetch private addresses');
    }
    return { parsed, addresses: addresses.map(address => ({ address, family: isIP(address) })) };
  };
  const assertSafeRemoteUrl = async value => (await validateDestination(value)).parsed;

  const fetchWithSafeRedirects = async (value, signal, maxRedirects = 5) => {
    let current = new URL(String(value));
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const destination = await validateDestination(current);
      current = destination.parsed;
      const response = await fetchImpl(current, {
        validatedAddresses: destination.addresses,
        signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThoughtDAG/0.2.6; link snapshot)' },
      });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`Redirect HTTP ${response.status} did not include a location`);
      if (redirects === maxRedirects) throw new Error('Too many redirects');
      current = new URL(location, current);
    }
    throw new Error('Too many redirects');
  };

  return {
    assertSafeRemoteUrl,
    fetchWithSafeRedirects,
    systemUsesClashFakeIp,
  };
}
