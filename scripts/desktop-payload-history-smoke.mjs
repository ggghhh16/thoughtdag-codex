import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const unpackedRoot = path.resolve(process.argv[2] || 'desktop/out/win-unpacked');
const payloadRoot = path.join(unpackedRoot, 'resources', 'payload');
const serverPath = path.join(payloadRoot, 'server.mjs');
const distPath = path.join(payloadRoot, 'dist');
assert.ok(fs.statSync(serverPath).isFile(), 'packaged payload server is missing');
assert.ok(fs.statSync(path.join(distPath, 'index.html')).isFile(), 'packaged renderer is missing');

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

const port = await freePort();
const token = crypto.randomBytes(32).toString('hex');
let stderrTail = '';
const child = spawn(process.execPath, [serverPath], {
  cwd: payloadRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    SERVE_DIST: distPath,
    THOUGHTDAG_DESKTOP_CONTROL_TOKEN: token,
  },
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-8_000); });

const origin = `http://127.0.0.1:${port}`;
async function waitReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packaged server exited early: ${stderrTail}`);
    try {
      const response = await fetch(`${origin}/api/models`);
      if (response.ok) return;
    } catch { /* startup in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`packaged server did not become ready: ${stderrTail}`);
}

async function historyJson(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { 'x-thoughtdag-desktop-token': token },
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, body.error || `HTTP ${response.status}`);
  return body;
}

try {
  await waitReady();
  const unauthorized = await fetch(`${origin}/api/codex/threads?limit=1`);
  assert.equal(unauthorized.status, 401);

  const active = await historyJson('/api/codex/threads?limit=5&archived=false');
  assert.ok(Array.isArray(active.threads) && active.threads.length > 0);
  let imported;
  for (const thread of active.threads) {
    const detail = await historyJson(`/api/codex/threads/${encodeURIComponent(thread.id)}`);
    if (detail.thread?.turnCount > 0) {
      imported = detail.thread;
      break;
    }
  }
  assert.ok(imported, 'packaged payload found no task with complete text turns');
  assert.equal(imported.turnCount, imported.turns.length);
  assert.ok(imported.turns.every((turn) => turn.userText && turn.assistantText));

  const archived = await historyJson('/api/codex/threads?limit=5&archived=true');
  assert.ok(Array.isArray(archived.threads));
  console.log(JSON.stringify({
    packagedPayload: payloadRoot,
    unauthorizedStatus: unauthorized.status,
    activeListed: active.threads.length,
    activeHasNext: Boolean(active.nextCursor),
    archivedListed: archived.threads.length,
    archivedHasNext: Boolean(archived.nextCursor),
    importedThreadId: imported.id,
    importedTurns: imported.turnCount,
  }, null, 2));
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
}
