import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  CodexAppServerAbortError,
  CodexAppServerClient,
  CodexAppServerRpcError,
  resolveCodexAppServerLaunch,
  sanitizeCodexAppServerEnv,
} from '../server/codex-app-server-client.mjs';
import {
  WINDOWS_HIDDEN_LAUNCHER_PATH,
} from '../server/codex-windows-launch.mjs';

class FakeAppServerProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.received = [];
    let input = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        input += chunk.toString('utf8');
        while (input.includes('\n')) {
          const newline = input.indexOf('\n');
          const line = input.slice(0, newline).replace(/\r$/, '');
          input = input.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          this.received.push(message);
          queueMicrotask(() => handler?.(message, this));
        }
        callback();
      },
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendBuffers(buffers) {
    for (const buffer of buffers) this.stdout.write(buffer);
  }

  kill() {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

function createHarness(handler, options = {}) {
  const children = [];
  const spawns = [];
  const client = new CodexAppServerClient({
    launch: {
      command: 'fake-codex',
      args: ['app-server', '--stdio'],
      env: { TEST: '1' },
    },
    spawnImpl(command, args, spawnOptions) {
      spawns.push({ command, args, options: spawnOptions });
      const child = new FakeAppServerProcess(handler);
      children.push(child);
      return child;
    },
    clientInfo: { name: 'thoughtdag_test', title: 'ThoughtDAG Test', version: '1.2.3' },
    requestTimeoutMs: 1_000,
    logger: { warn() {} },
    ...options,
  });
  return { client, children, spawns };
}

function basicHandler(message, child) {
  if (message.method === 'initialize') {
    child.send({
      id: message.id,
      result: { userAgent: 'codex-test', codexHome: 'C:\\Codex', platformFamily: 'windows', platformOs: 'windows' },
    });
  }
}

test('connect negotiates initialize/initialized and wrappers preserve official method names', async (t) => {
  const methods = [];
  const { client, children, spawns } = createHarness((message, child) => {
    methods.push(message.method);
    basicHandler(message, child);
    if (message.id !== undefined && message.method !== 'initialize') {
      const threadId = message.params?.threadId || 'thread-new';
      child.send({ id: message.id, result: { thread: { id: threadId } } });
    }
  });
  t.after(() => client.close());

  const initialized = await client.connect();
  assert.equal(initialized.userAgent, 'codex-test');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0], {
    command: 'fake-codex',
    args: ['app-server', '--stdio'],
    options: {
      env: { TEST: '1' },
      cwd: undefined,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  });
  assert.deepEqual(children[0].received[0], {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: { name: 'thoughtdag_test', title: 'ThoughtDAG Test', version: '1.2.3' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    },
  });
  assert.deepEqual(children[0].received[1], { method: 'initialized' });

  await client.startThread({ cwd: 'D:\\Code' });
  await client.resumeThread({ threadId: 'thread-a', excludeTurns: true });
  await client.forkThread({ threadId: 'thread-a', lastTurnId: 'turn-a' });
  await client.listThreads({ limit: 25, archived: false });
  await client.readThread({ threadId: 'thread-a', includeTurns: true });
  await client.listThreadTurns({ threadId: 'thread-a', limit: 25, itemsView: 'full' });
  await client.listThreadItems({ threadId: 'thread-a', limit: 50, sortDirection: 'asc' });
  await client.injectItems({ threadId: 'thread-a', items: [] });
  assert.deepEqual(methods.slice(2), [
    'thread/start',
    'thread/resume',
    'thread/fork',
    'thread/list',
    'thread/read',
    'thread/turns/list',
    'thread/items/list',
    'thread/inject_items',
  ]);
});

test('startTurn collects fragmented UTF-8 agent and reasoning deltas through turn/completed', async (t) => {
  const notifications = [];
  const callbackText = [];
  const callbackReasoning = [];
  const { client } = createHarness((message, child) => {
    basicHandler(message, child);
    if (message.method !== 'turn/start') return;
    child.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    const first = Buffer.from(`${JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '你好' },
    })}\n`, 'utf8');
    const splitAt = first.indexOf(Buffer.from('你')) + 1;
    child.sendBuffers([first.subarray(0, splitAt), first.subarray(splitAt)]);
    child.send({
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', delta: '摘要', summaryIndex: 0 },
    });
    child.send({
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', delta: '推理', contentIndex: 0 },
    });
    child.send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      },
    });
  });
  t.after(() => client.close());

  const result = await client.startTurn({
    threadId: 'thread-1',
    input: [{ type: 'text', text: '问题' }],
  }, {
    onAgentMessageDelta(delta) { callbackText.push(delta); },
    onReasoningDelta(delta, event) { callbackReasoning.push([event.kind, delta]); },
    onNotification(message) { notifications.push(message.method); },
  });

  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.turn.status, 'completed');
  assert.equal(result.text, '你好');
  assert.equal(result.reasoningSummary, '摘要');
  assert.equal(result.reasoning, '摘要'); // Public display prefers the summary over raw content.
  assert.deepEqual(callbackText, ['你好']);
  assert.deepEqual(callbackReasoning, [['summary', '摘要'], ['content', '推理']]);
  assert.deepEqual(notifications, [
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    'turn/completed',
  ]);
});

test('server-initiated approvals are declined and unsupported requests fail closed', async (t) => {
  const { client, children } = createHarness(basicHandler);
  t.after(() => client.close());
  await client.connect();
  const child = children[0];

  child.send({
    id: 91,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  });
  child.send({
    id: 92,
    method: 'account/chatgptAuthTokens/refresh',
    params: { reason: 'expired' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(child.received.find((message) => message.id === 91), {
    id: 91,
    result: { decision: 'decline' },
  });
  const rejected = child.received.find((message) => message.id === 92);
  assert.equal(rejected.error.code, -32601);
  assert.equal(rejected.error.data.method, 'account/chatgptAuthTokens/refresh');
});

test('active turn routes a user question to its UI handler and returns the answer', async (t) => {
  const { client, children } = createHarness((message, child) => {
    basicHandler(message, child);
    if (message.method === 'turn/start') {
      child.send({id:message.id,result:{turn:{id:'turn-interactive',status:'inProgress'}}});
      child.send({id:191,method:'item/tool/requestUserInput',params:{threadId:'thread-interactive',turnId:'turn-interactive',questions:[{id:'q',question:'Which format?'}]}});
    }
    if (message.id === 191 && message.result) child.send({method:'turn/completed',params:{threadId:'thread-interactive',turn:{id:'turn-interactive',status:'completed',items:[]}}});
  });
  t.after(()=>client.close());
  let seen;
  await client.startTurn({threadId:'thread-interactive'}, {onServerRequest:async request=>{seen=request;return {answers:{q:{answers:['complete']}}};}});
  assert.equal(seen.method,'item/tool/requestUserInput');
  assert.deepEqual(children[0].received.find(message=>message.id===191).result,{answers:{q:{answers:['complete']}}});
  assert.equal(client.turnRequestHandlers.size,0);
});

test('RPC errors retain method/code/data and process exit rejects pending calls', async (t) => {
  const { client, children } = createHarness((message, child) => {
    basicHandler(message, child);
    if (message.method === 'model/list') {
      child.send({ id: message.id, error: { code: -32602, message: 'bad params', data: { field: 'x' } } });
    }
  });
  t.after(() => client.close());

  await assert.rejects(client.request('model/list', {}), (error) => {
    assert.ok(error instanceof CodexAppServerRpcError);
    assert.equal(error.method, 'model/list');
    assert.equal(error.rpcCode, -32602);
    assert.deepEqual(error.rpcData, { field: 'x' });
    return true;
  });

  const pending = client.request('thread/read', { threadId: 'thread-1' });
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stderr.write('native crash details');
  children[0].emit('exit', 9, null);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'CODEX_APP_SERVER_CLOSED');
    assert.match(error.message, /native crash details/);
    return true;
  });
});

test('aborting a running turn sends turn/interrupt and rejects with AbortError', async (t) => {
  let interruptSeen;
  const { client } = createHarness((message, child) => {
    basicHandler(message, child);
    if (message.method === 'turn/start') {
      child.send({ id: message.id, result: { turn: { id: 'turn-abort', status: 'inProgress', items: [] } } });
    } else if (message.method === 'turn/interrupt') {
      interruptSeen = message.params;
      child.send({ id: message.id, result: {} });
    }
  });
  t.after(() => client.close());

  const controller = new AbortController();
  const turn = client.startTurn({
    threadId: 'thread-abort',
    input: [{ type: 'text', text: 'stop' }],
  }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(turn, (error) => {
    assert.ok(error instanceof CodexAppServerAbortError);
    assert.equal(error.name, 'AbortError');
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interruptSeen, { threadId: 'thread-abort', turnId: 'turn-abort' });
});

test('default Windows launch goes through the hidden-console launcher and strips parent session keys', {
  skip: process.platform !== 'win32',
}, () => {
  const launch = resolveCodexAppServerLaunch({
    env: {
      ...process.env,
      CODEX_THREAD_ID: 'parent',
      CODEX_SESSION_ID: 'parent-session',
      THOUGHTDAG_DESKTOP_CONTROL_TOKEN: 'must-not-reach-codex',
    },
    configOverrides: ['service_tier="priority"'],
  });
  assert.equal(launch.command, WINDOWS_HIDDEN_LAUNCHER_PATH);
  assert.deepEqual(launch.args.slice(0, 4), [
    'app-server', '--stdio', '-c', 'service_tier="priority"',
  ]);
  assert.equal(launch.env.CODEX_THREAD_ID, undefined);
  assert.equal(launch.env.CODEX_SESSION_ID, undefined);
  assert.equal(launch.env.THOUGHTDAG_DESKTOP_CONTROL_TOKEN, undefined);
  assert.ok(launch.env.THOUGHTDAG_CODEX_EXECUTABLE);

  assert.deepEqual(sanitizeCodexAppServerEnv({
    A: 1,
    CODEX_CI: '1',
    CODEX_THREAD_ID: 'x',
    THOUGHTDAG_DESKTOP_CONTROL_TOKEN: 'must-not-reach-codex',
  }), {
    A: '1',
  });
});
