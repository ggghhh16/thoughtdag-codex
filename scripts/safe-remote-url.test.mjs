import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSafeRemoteUrlGuard,
  isClashFakeIpAddress,
  isPrivateAddress,
} from '../server/safe-remote-url.mjs';

const fake = (last) => [{ address: `198.18.0.${last}`, family: 4 }];
const pub = (last) => [{ address: `203.0.113.${last}`, family: 4 }];

function lookupFrom(entries, calls = []) {
  return async (hostname, options) => {
    calls.push(hostname);
    assert.deepEqual(options, { all: true, verbatim: true });
    const result = entries[hostname];
    if (result instanceof Error) throw result;
    return result ?? [];
  };
}

test('address classification retains 198.18/15 inside the private boundary', () => {
  assert.equal(isClashFakeIpAddress('198.18.0.1'), true);
  assert.equal(isClashFakeIpAddress('198.19.255.254'), true);
  assert.equal(isClashFakeIpAddress('198.20.0.1'), false);
  assert.equal(isPrivateAddress('198.18.0.1'), true);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
});

test('literal IP targets are rejected even when Clash fake-IP mode is confirmed', async () => {
  const guard = createSafeRemoteUrlGuard({
    lookupHostname: lookupFrom({ 'example.com': fake(1), 'iana.org': fake(2) }),
  });
  await assert.rejects(
    guard.assertSafeRemoteUrl('https://198.18.0.99/private'),
    /literal IP addresses/,
  );
  await assert.rejects(
    guard.assertSafeRemoteUrl('https://127.0.0.1/private'),
    /literal IP addresses/,
  );
  await assert.rejects(
    guard.assertSafeRemoteUrl('http://localhost./private'),
    /private addresses/,
  );
});

test('a hostname fake IP is allowed only after two public probes confirm the mode', async () => {
  const calls = [];
  const guard = createSafeRemoteUrlGuard({
    allowFakeIp: true,
    lookupHostname: lookupFrom({
      'github.com': fake(121),
      'example.com': fake(189),
      'iana.org': fake(190),
    }, calls),
  });
  assert.equal((await guard.assertSafeRemoteUrl('https://github.com/openai')).hostname, 'github.com');
  // Positive detection is cached: a second target check does not re-run probes.
  await guard.assertSafeRemoteUrl('https://github.com/openai/codex');
  assert.equal(calls.filter((host) => host === 'example.com').length, 1);
  assert.equal(calls.filter((host) => host === 'iana.org').length, 1);
});

test('one fake-IP probe is insufficient and private DNS remains blocked', async () => {
  const guard = createSafeRemoteUrlGuard({
    lookupHostname: lookupFrom({
      'attacker.example': fake(66),
      'example.com': fake(1),
      'iana.org': pub(2),
    }),
  });
  await assert.rejects(
    guard.assertSafeRemoteUrl('https://attacker.example/'),
    /private addresses/,
  );
});

test('ordinary hostnames resolving to private ranges remain blocked in fake-IP mode', async () => {
  const guard = createSafeRemoteUrlGuard({
    lookupHostname: lookupFrom({
      'internal.example': [{ address: '10.0.0.8', family: 4 }],
      'example.com': fake(1),
      'iana.org': fake(2),
    }),
  });
  await assert.rejects(
    guard.assertSafeRemoteUrl('https://internal.example/'),
    /private addresses/,
  );
});

test('every redirect hop is revalidated before a second request is sent', async () => {
  const fetched = [];
  const guard = createSafeRemoteUrlGuard({
    lookupHostname: lookupFrom({
      'public.example': [{ address: '93.184.216.34', family: 4 }],
      'private.example': [{ address: '192.168.1.10', family: 4 }],
      'example.com': pub(1),
      'iana.org': pub(2),
    }),
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'https://private.example/secret' } });
    },
  });
  await assert.rejects(
    guard.fetchWithSafeRedirects('https://public.example/start'),
    /private addresses/,
  );
  assert.deepEqual(fetched, ['https://public.example/start']);
});


test('fake-IP exception requires explicit operator opt-in', async () => {
  const guard = createSafeRemoteUrlGuard({ allowFakeIp: false, lookupHostname: lookupFrom({ 'public.example': fake(10), 'example.com': fake(1), 'iana.org': fake(2) }) });
  await assert.rejects(guard.assertSafeRemoteUrl('https://public.example'), /private addresses/);
});

test('DNS results are pinned for the HTTP connection rather than looked up again', async () => {
  const { createPinnedLookup } = await import('../server/pinned-http.mjs');
  let resolutions = 0;
  const guard = createSafeRemoteUrlGuard({
    lookupHostname: async () => (++resolutions === 1 ? [{address:'93.184.216.34',family:4}] : [{address:'127.0.0.1',family:4}]),
    fetchImpl: async (_url, options) => {
      const lookup = createPinnedLookup(options.validatedAddresses);
      const connected = await new Promise((resolve, reject) => lookup('public.example', {}, (error,address) => error ? reject(error) : resolve(address)));
      assert.equal(connected, '93.184.216.34');
      return new Response('ok');
    },
  });
  assert.equal(await (await guard.fetchWithSafeRedirects('https://public.example')).text(), 'ok');
  assert.equal(resolutions, 1);
});

test('oversized streaming responses are cancelled before full buffering', async () => {
  const { readBoundedText } = await import('../server/pinned-http.mjs');
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readBoundedText(response, 12), /exceeds 8 MB/);
  assert.equal(cancelled, true);
  assert.equal(await readBoundedText(new Response('你好'), 10), '你好');
});


test('expanded IPv6 and IPv4-mapped private destinations remain blocked', () => {
  for (const address of ['0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:192.168.1.1', '64:ff9b::7f00:1', '2001::7f00:1', '2002:7f00:1::']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('pinned transport preserves Host and decodes compressed bodies within the limit', async () => {
  const http = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const { fetchPinned, readBoundedText } = await import('../server/pinned-http.mjs');
  let host;
  const server = http.createServer((req, res) => {
    host = req.headers.host;
    res.writeHead(200, {'content-type':'text/plain', 'content-encoding':'gzip'});
    res.end(gzipSync('sample text'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const response = await fetchPinned(new URL('http://public.example:' + port), {validatedAddresses:[{address:'127.0.0.1',family:4}]});
    assert.equal(await readBoundedText(response), 'sample text');
    assert.equal(host, 'public.example:' + port);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
