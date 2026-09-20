import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

export const MAX_REMOTE_BODY_BYTES = 8 * 1024 * 1024;

// Resolve once in the URL guard, then use exactly those addresses at connect
// time. Keep the hostname for Host and TLS certificate verification.
export function createPinnedLookup(addresses) {
  if (!addresses?.length) throw new Error('No validated destination addresses.');
  return (_hostname, options, callback) => {
    const family = typeof options === 'number' ? options : options?.family;
    const candidates = addresses.filter(entry => !family || entry.family === family);
    if (!candidates.length) return callback(new Error('No validated address for the requested IP family.'));
    if (options?.all) callback(null, candidates.map(entry => ({ ...entry })));
    else callback(null, candidates[0].address, candidates[0].family);
  };
}

export async function fetchPinned(url, { signal, headers, validatedAddresses }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET', agent: false, signal,
      lookup: createPinnedLookup(validatedAddresses),
      headers: { ...headers, 'Accept-Encoding': 'gzip, deflate, br' },
    }, incoming => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = incoming.statusCode || 502;
      if ([204, 205, 304].includes(status)) {
        incoming.resume();
        return resolve(new Response(null, { status, headers: responseHeaders }));
      }
      const encoding = incoming.headers['content-encoding'];
      let body = incoming;
      if (encoding && encoding !== 'identity') {
        const factory = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
        if (!factory) { incoming.destroy(); reject(new Error('Unsupported response encoding.')); return; }
        body = factory();
        incoming.on('error', error => body.destroy(error));
        body.on('close', () => incoming.destroy());
        incoming.pipe(body);
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
      }
      resolve(new Response(Readable.toWeb(body), { status, headers: responseHeaders }));
    });
    request.once('error', reject);
    request.end();
  });
}

export async function readBoundedText(response, limit = MAX_REMOTE_BODY_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Web page exceeds 8 MB. Download the source and attach the relevant document.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('Web page exceeds 8 MB. Download the source and attach the relevant document.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
