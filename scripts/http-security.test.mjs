import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import { createLocalRequestGuard, requireLoopbackHost } from '../server/http-security.mjs';

test('remote bind addresses are refused', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.2', 'example.com']) assert.throws(() => requireLoopbackHost(host));
  assert.equal(requireLoopbackHost('127.0.0.1'), '127.0.0.1');
});

test('HTTP rejects hostile hosts, origins and simple cross-site forms before routes run', async () => {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  app.use(createLocalRequestGuard({ port }));
  app.post('/api/codex', (_req, res) => res.json({ called: true }));
  try {
    const send = headers => new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${port}/api/codex`, { method: 'POST', headers }, response => {
        response.resume(); response.on('end', () => resolve({ status: response.statusCode }));
      });
      request.on('error', reject); request.end('{}');
    });
    assert.equal((await send({ Host: 'attacker.example', 'Content-Type': 'application/json' })).status, 403);
    for (const Origin of ['https://attacker.example', 'null', 'http://localhost:9999']) {
      assert.equal((await send({ Origin, 'Content-Type': 'application/json' })).status, 403);
    }
    assert.equal((await send({ 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await send({ Origin: 'http://localhost:5173', 'Content-Type': 'text/plain' })).status, 415);
    for (const Origin of [`http://127.0.0.1:${port}`, 'http://localhost:5173']) {
      assert.equal((await send({ Origin, 'Content-Type': 'application/json' })).status, 200);
    }
    assert.equal((await send({ 'Content-Type': 'application/json' })).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
