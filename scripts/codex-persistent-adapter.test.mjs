import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCodexAdapter,
  normalizeCodexLink,
  splitCodexTurnMessages,
} from '../server/codex-adapter.mjs';
import {
  CODEX_HISTORY_SOURCE_KINDS,
  codexThreadDetailDto,
  normalizeCodexThreadId,
  normalizeCodexThreadListParams,
} from '../server/codex-history.mjs';

const MODEL_CATALOG = {
  getCatalog: async () => ({
    source: 'app-server',
    defaultModelId: 'test-model',
    warning: null,
    models: [{
      id: 'test-model',
      runtimeModel: 'runtime-test-model',
      name: 'Test',
      description: '',
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
      defaultReasoningEffort: 'high',
      inputModalities: ['text', 'image'],
      vision: true,
      additionalSpeedTiers: ['fast'],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
      defaultServiceTier: null,
      supportsFastMode: true,
      fastServiceTierId: 'priority',
      isDefault: true,
    }],
  }),
};

function createFakeAppServer({
  latestTurnId = 'turn-parent',
  threadList = { data: [], nextCursor: null },
  threadRead = { thread: { id: '00000000-0000-7000-8000-000000000001', turns: [] } },
  threadTurnsList,
  threadItemsList,
} = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/turns/list') {
        return { data: latestTurnId ? [{ id: latestTurnId, status: 'completed' }] : [] };
      }
      return {};
    },
    async listThreads(params) {
      calls.push(['thread/list', params]);
      return threadList;
    },
    async readThread(params) {
      calls.push(['thread/read', params]);
      return threadRead;
    },
    async listThreadTurns(params) {
      calls.push(['thread/turns/list', params]);
      if (typeof threadTurnsList === 'function') return threadTurnsList(params);
      return {
        data: params.cursor ? [] : (threadRead.thread?.turns || []),
        nextCursor: null,
      };
    },
    async listThreadItems(params) {
      calls.push(['thread/items/list', params]);
      if (typeof threadItemsList === 'function') return threadItemsList(params);
      return { data: [], nextCursor: null };
    },
    async startThread(params) {
      calls.push(['thread/start', params]);
      return { thread: { id: 'thread-started' } };
    },
    async resumeThread(params) {
      calls.push(['thread/resume', params]);
      return { thread: { id: params.threadId } };
    },
    async forkThread(params) {
      calls.push(['thread/fork', params]);
      return { thread: { id: 'thread-forked' } };
    },
    async startTurn(params, callbacks) {
      calls.push(['turn/start', params]);
      callbacks.onNotification?.({
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: {
              inputTokens: 12,
              cachedInputTokens: 3,
              cacheWriteInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 2,
            },
          },
        },
      });
      callbacks.onAgentMessageDelta?.('回答');
      return {
        threadId: params.threadId,
        turnId: 'turn-created',
        turn: { id: 'turn-created', status: 'completed', items: [] },
        text: '回答',
      };
    },
    close() {
      calls.push(['close']);
    },
  };
}

async function withAdapter(fake, run) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thoughtdag-persistent-test-'));
  let appServerOptions;
  let appServerFactoryCalls = 0;
  const adapter = createCodexAdapter({
    tempRoot,
    authProbe: async () => true,
    modelCatalog: MODEL_CATALOG,
    appServerFactory(options) {
      appServerFactoryCalls += 1;
      appServerOptions = options;
      return fake;
    },
    logger: { warn() {}, error() {} },
  });
  try {
    await run(adapter, () => appServerOptions, () => appServerFactoryCalls);
  } finally {
    adapter.close();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

test('Codex history HTTP routes disable caches and authenticate before any history read', async () => {
  const source = await fs.promises.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const listStart = source.indexOf("app.get('/api/codex/threads'");
  const detailStart = source.indexOf("app.get('/api/codex/threads/:threadId'");
  const historyEnd = source.indexOf('// The CLI owns MCP discovery', detailStart);
  assert.ok(listStart >= 0 && detailStart > listStart && historyEnd > detailStart);

  const blocks = [
    source.slice(listStart, detailStart),
    source.slice(detailStart, historyEnd),
  ];
  for (const block of blocks) {
    assert.match(block, /res\.set\('Cache-Control', 'no-store'\)/);
    const authenticateAt = block.indexOf('projectRegistry.authenticate(req.get(DESKTOP_CONTROL_HEADER))');
    const adapterAt = block.indexOf('codexAdapter.');
    assert.ok(authenticateAt >= 0 && adapterAt > authenticateAt);
  }
  assert.match(blocks[0], /archived: req\.query\.archived/);

  const desktopMain = await fs.promises.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.match(desktopMain, /new Set\(\['search', 'cursor', 'limit', 'archived'\]\)/);
  assert.match(desktopMain, /typeof options\.archived !== 'boolean'/);
  assert.match(desktopMain, /query\.set\('archived', String\(options\.archived\)\)/);
});

test('Codex history inputs are bounded and cover every user-facing non-archived source', () => {
  assert.deepEqual(normalizeCodexThreadListParams({
    cursor: 'next-page',
    limit: '25',
    search: '  DAG notes  ',
  }), {
    cursor: 'next-page',
    limit: 25,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    sourceKinds: [...CODEX_HISTORY_SOURCE_KINDS],
    archived: false,
    searchTerm: 'DAG notes',
  });
  assert.ok(CODEX_HISTORY_SOURCE_KINDS.includes('cli'));
  assert.ok(CODEX_HISTORY_SOURCE_KINDS.includes('vscode'));
  assert.ok(CODEX_HISTORY_SOURCE_KINDS.includes('appServer'));
  assert.ok(!CODEX_HISTORY_SOURCE_KINDS.includes('subAgent'));
  assert.equal(normalizeCodexThreadListParams({ archived: true }).archived, true);
  assert.equal(normalizeCodexThreadListParams({ archived: 'true' }).archived, true);
  assert.equal(normalizeCodexThreadListParams({ archived: false }).archived, false);
  assert.equal(normalizeCodexThreadListParams({ archived: 'false' }).archived, false);

  assert.throws(
    () => normalizeCodexThreadListParams({ limit: '101' }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_CODEX_HISTORY_LIMIT',
  );
  assert.throws(
    () => normalizeCodexThreadListParams({ cursor: ['not', 'scalar'] }),
    (error) => error.statusCode === 400,
  );
  for (const archived of ['1', '', null, 1]) {
    assert.throws(
      () => normalizeCodexThreadListParams({ archived }),
      (error) => error.code === 'INVALID_CODEX_HISTORY_ARCHIVED' && error.statusCode === 400,
    );
  }
  assert.equal(
    normalizeCodexThreadId('01A05292-6468-7262-B9F7-173DF320060A'),
    '01a05292-6468-7262-b9f7-173df320060a',
  );
  assert.throws(
    () => normalizeCodexThreadId('../../archived/thread.jsonl'),
    (error) => error.code === 'INVALID_CODEX_THREAD_ID',
  );
});

test('thread/read DTO keeps chronological user/final-answer turns and drops tool noise', () => {
  const payload = codexThreadDetailDto({
    thread: {
      id: '01a05292-6468-7262-b9f7-173df320060a',
      name: 'Imported conversation',
      preview: 'First question',
      cwd: 'D:\\Code\\project',
      projectId: null,
      source: 'vscode',
      threadSource: 'vscode',
      modelProvider: 'openai',
      createdAt: 10,
      updatedAt: 30,
      recencyAt: 31,
      status: { type: 'notLoaded' },
      ephemeral: false,
      path: 'C:\\Users\\secret\\rollout.jsonl',
      turns: [
        {
          id: 'turn-later',
          status: 'completed',
          startedAt: 20,
          completedAt: 22,
          durationMs: 2000,
          items: [
            { type: 'userMessage', content: [
              { type: 'text', text: 'Second question' },
              { type: 'localImage', path: 'C:\\private.png' },
            ] },
            { type: 'agentMessage', phase: 'commentary', text: 'Working...' },
            { type: 'commandExecution', command: 'do-not-export', aggregatedOutput: 'secret' },
            { type: 'reasoning', summary: ['Short summary'], content: ['hidden reasoning'] },
            { type: 'agentMessage', phase: 'final_answer', text: 'Second answer A' },
            { type: 'agentMessage', phase: 'final_answer', text: 'Second answer B' },
          ],
        },
        {
          id: 'turn-earlier',
          status: 'completed',
          startedAt: 10,
          completedAt: 12,
          durationMs: 2000,
          items: [
            { type: 'userMessage', content: [{ type: 'text', text: 'First question' }] },
            { type: 'agentMessage', phase: null, text: 'Older partial answer' },
            { type: 'agentMessage', phase: null, text: 'First final answer' },
          ],
        },
        {
          id: 'turn-tool-only',
          status: 'completed',
          startedAt: 15,
          completedAt: 16,
          items: [{ type: 'commandExecution', command: 'ignored' }],
        },
        {
          id: 'turn-failed-with-text',
          status: 'failed',
          startedAt: 25,
          completedAt: 26,
          items: [
            { type: 'userMessage', content: [{ type: 'text', text: 'Do not import me' }] },
            { type: 'agentMessage', phase: 'final_answer', text: 'Incomplete answer' },
          ],
        },
      ],
    },
  });

  assert.equal(payload.thread.id, '01a05292-6468-7262-b9f7-173df320060a');
  assert.equal(payload.thread.name, 'Imported conversation');
  assert.equal(payload.thread.turnCount, 2);
  assert.deepEqual(payload.thread.turns.map((turn) => turn.id), ['turn-earlier', 'turn-later']);
  assert.equal(payload.thread.turns[0].assistantText, 'First final answer');
  assert.equal(payload.thread.turns[1].userText, 'Second question');
  assert.equal(payload.thread.turns[1].assistantText, 'Second answer A\n\nSecond answer B');
  assert.equal(payload.thread.turns[1].reasoningSummary, 'Short summary');
  assert.equal(payload.thread.sourceKind, 'vscode');
  assert.equal('threadId' in payload.thread, false);
  assert.equal('title' in payload.thread, false);
  assert.equal('source' in payload.thread, false);
  assert.equal('turnId' in payload.thread.turns[0], false);
  assert.equal('summary' in payload.thread.turns[1], false);
  assert.equal('path' in payload.thread, false);
  assert.equal(JSON.stringify(payload).includes('do-not-export'), false);
  assert.equal(JSON.stringify(payload).includes('hidden reasoning'), false);
  assert.equal(JSON.stringify(payload).includes('private.png'), false);
});

test('adapter history methods reuse one client and page read-only turns with de-duplication', async () => {
  const threadId = '01a05292-6468-7262-b9f7-173df320060a';
  const rawThread = {
    id: threadId,
    name: 'History',
    preview: 'Question',
    ephemeral: false,
    historyMode: 'legacy',
    source: 'cli',
    status: { type: 'notLoaded' },
  };
  const turnOne = {
    id: 'turn-1',
    status: 'completed',
    startedAt: 1,
    completedAt: 2,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
      { type: 'agentMessage', phase: 'final_answer', text: 'Answer' },
    ],
  };
  const turnTwo = {
      id: 'turn-2',
      status: 'completed',
      startedAt: 3,
      completedAt: 4,
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Next question' }] },
        { type: 'agentMessage', phase: 'final_answer', text: 'Next answer' },
      ],
  };
  const fake = createFakeAppServer({
    threadList: { data: [{ ...rawThread, turns: [] }], nextCursor: 'next' },
    threadRead: { thread: rawThread },
    threadTurnsList(params) {
      // The protocol's summary view is insufficient for an exact import.
      if (params.itemsView !== 'full') {
        return { data: [{ ...turnOne, items: [] }], nextCursor: null };
      }
      if (!params.cursor) return { data: [turnOne], nextCursor: 'page-2' };
      return { data: [turnOne, turnTwo], nextCursor: null };
    },
  });
  await withAdapter(fake, async (adapter, _getOptions, getFactoryCalls) => {
    const list = await adapter.listPersistentThreads({ limit: 10, search: 'History', archived: true });
    const detail = await adapter.readPersistentThread(threadId.toUpperCase());

    assert.equal(getFactoryCalls(), 1);
    assert.equal(list.threads[0].id, threadId);
    assert.equal(list.threads[0].name, 'History');
    assert.equal(list.threads[0].sourceKind, 'cli');
    assert.equal(list.nextCursor, 'next');
    assert.equal(detail.thread.turns[0].assistantText, 'Answer');
    assert.deepEqual(detail.thread.turns.map((turn) => turn.id), ['turn-1', 'turn-2']);
    assert.deepEqual(fake.calls.map(([method]) => method), [
      'thread/list',
      'thread/read',
      'thread/turns/list',
      'thread/turns/list',
    ]);
    assert.equal(fake.calls[0][1].archived, true);
    assert.deepEqual(fake.calls[0][1].sourceKinds, [...CODEX_HISTORY_SOURCE_KINDS]);
    assert.deepEqual(fake.calls[1][1], { threadId, includeTurns: false });
    assert.deepEqual(fake.calls[2][1], {
      threadId,
      limit: 25,
      sortDirection: 'asc',
      itemsView: 'full',
    });
    assert.deepEqual(fake.calls[3][1], {
      threadId,
      cursor: 'page-2',
      limit: 25,
      sortDirection: 'asc',
      itemsView: 'full',
    });
  });
});

test('paginated history loads turn metadata then hydrates official item entries', async () => {
  const threadId = '01a05292-6468-7262-b9f7-173df320060a';
  const turnOne = {
    id: 'turn-page-1',
    status: 'completed',
    startedAt: 1,
    completedAt: 2,
  };
  const turnTwo = {
    id: 'turn-page-2',
    status: 'completed',
    startedAt: 3,
    completedAt: 4,
  };
  const firstUser = {
    type: 'userMessage',
    id: 'item-user-1',
    content: [{ type: 'text', text: 'Paginated question' }],
  };
  const firstAnswer = {
    type: 'agentMessage',
    id: 'item-answer-1',
    phase: 'final_answer',
    text: 'Paginated answer',
  };
  const secondUser = {
    type: 'userMessage',
    id: 'item-user-2',
    content: [{ type: 'text', text: 'Second paginated question' }],
  };
  const secondAnswer = {
    type: 'agentMessage',
    id: 'item-answer-2',
    phase: 'final_answer',
    text: 'Second paginated answer',
  };

  const fake = createFakeAppServer({
    threadRead: {
      thread: {
        id: threadId,
        name: 'Paginated history',
        historyMode: 'paginated',
        source: 'vscode',
      },
    },
    threadTurnsList(params) {
      if (params.itemsView === 'full') throw new Error('full items are invalid for paginated history');
      assert.equal(params.itemsView, 'notLoaded');
      if (!params.cursor) return { data: [turnOne], nextCursor: 'turn-page-2' };
      return { data: [turnTwo], nextCursor: null };
    },
    threadItemsList(params) {
      if (!params.cursor) {
        return {
          data: [
            { turnId: turnOne.id, item: firstUser },
            { turnId: turnOne.id, item: firstAnswer },
          ],
          nextCursor: 'item-page-2',
        };
      }
      return {
        data: [
          // Cursor boundaries may repeat their anchor; it must not duplicate text.
          { turnId: turnOne.id, item: firstAnswer },
          { turnId: turnTwo.id, item: secondUser },
          { turnId: turnTwo.id, item: secondAnswer },
        ],
        nextCursor: null,
      };
    },
  });

  await withAdapter(fake, async (adapter) => {
    const detail = await adapter.readPersistentThread(threadId);
    assert.deepEqual(detail.thread.turns.map((turn) => ({
      id: turn.id,
      userText: turn.userText,
      assistantText: turn.assistantText,
    })), [
      { id: turnOne.id, userText: 'Paginated question', assistantText: 'Paginated answer' },
      { id: turnTwo.id, userText: 'Second paginated question', assistantText: 'Second paginated answer' },
    ]);

    const turnCalls = fake.calls.filter(([method]) => method === 'thread/turns/list');
    assert.equal(turnCalls.length, 2);
    assert.ok(turnCalls.every(([, params]) => params.itemsView === 'notLoaded'));
    const itemCalls = fake.calls.filter(([method]) => method === 'thread/items/list');
    assert.deepEqual(itemCalls.map(([, params]) => params), [
      { threadId, limit: 50, sortDirection: 'asc' },
      { threadId, cursor: 'item-page-2', limit: 50, sortDirection: 'asc' },
    ]);
  });
});

test('paginated item history fails closed on a repeated cursor', async () => {
  const threadId = '01a05292-6468-7262-b9f7-173df320060a';
  const fake = createFakeAppServer({
    threadRead: {
      thread: { id: threadId, name: 'Item loop', historyMode: 'paginated', source: 'vscode' },
    },
    threadTurnsList() {
      return {
        data: [{ id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2 }],
        nextCursor: null,
      };
    },
    threadItemsList() {
      return { data: [], nextCursor: 'same-item-cursor' };
    },
  });
  await withAdapter(fake, async (adapter) => {
    await assert.rejects(
      adapter.readPersistentThread(threadId),
      (error) => error.code === 'CODEX_HISTORY_ITEM_PAGINATION_LOOP' && error.statusCode === 502,
    );
    assert.equal(fake.calls.filter(([method]) => method === 'thread/items/list').length, 2);
  });
});

test('paginated item history has explicit page and item safety limits', async () => {
  const threadId = '01a05292-6468-7262-b9f7-173df320060a';
  const turn = { id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2 };
  let page = 0;
  const pageLimited = createFakeAppServer({
    threadRead: {
      thread: { id: threadId, name: 'Huge pages', historyMode: 'paginated', source: 'vscode' },
    },
    threadTurnsList() {
      return { data: [turn], nextCursor: null };
    },
    threadItemsList() {
      page += 1;
      return { data: [], nextCursor: `item-cursor-${page}` };
    },
  });
  await withAdapter(pageLimited, async (adapter) => {
    await assert.rejects(
      adapter.readPersistentThread(threadId),
      (error) => error.code === 'CODEX_HISTORY_ITEM_PAGE_LIMIT' && error.statusCode === 502,
    );
    assert.equal(pageLimited.calls.filter(([method]) => method === 'thread/items/list').length, 400);
  });

  const tooManyEntries = Array.from({ length: 20_001 }, (_, index) => ({
    turnId: turn.id,
    item: {
      type: 'userMessage',
      id: `item-${index}`,
      content: [{ type: 'text', text: 'bounded' }],
    },
  }));
  const itemLimited = createFakeAppServer({
    threadRead: {
      thread: { id: threadId, name: 'Huge items', historyMode: 'paginated', source: 'vscode' },
    },
    threadTurnsList() {
      return { data: [turn], nextCursor: null };
    },
    threadItemsList() {
      return { data: tooManyEntries, nextCursor: null };
    },
  });
  await withAdapter(itemLimited, async (adapter) => {
    await assert.rejects(
      adapter.readPersistentThread(threadId),
      (error) => error.code === 'CODEX_HISTORY_ITEM_LIMIT' && error.statusCode === 502,
    );
  });
});

test('turn pagination fails closed on a repeated cursor', async () => {
  const threadId = '01a05292-6468-7262-b9f7-173df320060a';
  const fake = createFakeAppServer({
    threadRead: { thread: { id: threadId, name: 'Loop', source: 'vscode' } },
    threadTurnsList() {
      return { data: [], nextCursor: 'same-cursor' };
    },
  });
  await withAdapter(fake, async (adapter) => {
    await assert.rejects(
      adapter.readPersistentThread(threadId),
      (error) => error.code === 'CODEX_HISTORY_PAGINATION_LOOP' && error.statusCode === 502,
    );
    assert.equal(fake.calls.filter(([method]) => method === 'thread/turns/list').length, 2);
  });
});

test('turn pagination fails explicitly instead of silently truncating after 200 pages', async () => {
  const threadId = '01a05292-6468-7262-b9f7-173df320060a';
  let page = 0;
  const fake = createFakeAppServer({
    threadRead: { thread: { id: threadId, name: 'Huge', source: 'vscode' } },
    threadTurnsList() {
      page += 1;
      return { data: [], nextCursor: `cursor-${page}` };
    },
  });
  await withAdapter(fake, async (adapter) => {
    await assert.rejects(
      adapter.readPersistentThread(threadId),
      (error) => error.code === 'CODEX_HISTORY_PAGE_LIMIT' && error.statusCode === 502,
    );
    assert.equal(fake.calls.filter(([method]) => method === 'thread/turns/list').length, 200);
  });
});

test('Codex link validation and mapped suffix splitting are strict', () => {
  assert.deepEqual(normalizeCodexLink({ mode: 'fork', threadId: 'thread-1', turnId: 'turn-1' }), {
    mode: 'fork', threadId: 'thread-1', turnId: 'turn-1',
  });
  assert.throws(() => normalizeCodexLink({ mode: 'resume', threadId: 'thread-1' }), /both a threadId and turnId/);
  assert.throws(() => normalizeCodexLink({ mode: 'other' }), /start, resume, or fork/);

  const split = splitCodexTurnMessages([
    { role: 'system', content: '角色' },
    { role: 'user', content: '[Note]\n材料' },
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
    { role: 'user', content: '[Regarding this passage: "片段"]' },
    { role: 'user', content: '当前问题' },
  ], 'fork');
  assert.equal(split.currentText, '当前问题');
  assert.deepEqual(split.supplemental, [
    { role: 'system', content: '角色' },
    { role: 'user', content: '[Note]\n材料' },
    { role: 'user', content: '[Regarding this passage: "片段"]' },
  ]);
});

test('a new canvas root creates a durable official-client-visible thread and clean turn', async () => {
  const fake = createFakeAppServer();
  await withAdapter(fake, async (adapter, getOptions) => {
    const events = [];
    const result = await adapter.runStream({
      messages: [{ role: 'user', content: '解释一下 DAG' }],
      model: 'test-model',
      reasoningEffort: 'high',
      modelSpeed: 'fast',
      permissionMode: 'readonly',
      codexLink: { mode: 'start' },
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.threadId, 'thread-started');
    assert.equal(result.turnId, 'turn-created');
    assert.equal(result.threadMode, 'start');
    assert.equal(result.usage.reasoningTokens, 2);
    assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', text: '回答' }]);
    assert.equal(events.at(-1).snapshot.text, '回答');

    const start = fake.calls.find(([method]) => method === 'thread/start')[1];
    assert.equal(start.ephemeral, false);
    assert.equal(start.threadSource, 'vscode');
    assert.equal(start.serviceName, 'thoughtdag-codex');
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.serviceTier, 'priority');

    const turn = fake.calls.find(([method]) => method === 'turn/start')[1];
    assert.deepEqual(turn.input, [{ type: 'text', text: '解释一下 DAG' }]);
    assert.equal(turn.additionalContext.thoughtdag_canvas.value.includes('解释一下 DAG'), false);
    assert.equal(turn.sandboxPolicy.type, 'readOnly');
    assert.equal(turn.serviceTierForTurn, 'priority');

    const config = getOptions().configOverrides;
    assert.ok(config.includes('history.persistence="save-all"'));
    assert.ok(config.includes('features.shell_tool=false'));
  });
});

test('resume stays on the thread at its latest anchor', async () => {
  const fake = createFakeAppServer({ latestTurnId: 'turn-parent' });
  await withAdapter(fake, async (adapter) => {
    const result = await adapter.runStream({
      messages: [
        { role: 'user', content: '上一问' },
        { role: 'assistant', content: '上一答' },
        { role: 'user', content: '继续' },
      ],
      model: 'test-model',
      codexLink: { mode: 'resume', threadId: 'thread-parent', turnId: 'turn-parent' },
    });
    assert.equal(result.threadId, 'thread-parent');
    assert.equal(result.threadMode, 'resume');
    assert.ok(fake.calls.some(([method]) => method === 'thread/resume'));
    assert.ok(!fake.calls.some(([method]) => method === 'thread/fork'));
    const turn = fake.calls.find(([method]) => method === 'turn/start')[1];
    assert.deepEqual(turn.input, [{ type: 'text', text: '继续' }]);
  });
});

test('resume automatically forks when the official client advanced past the canvas turn', async () => {
  const fake = createFakeAppServer({ latestTurnId: 'turn-from-official-client' });
  await withAdapter(fake, async (adapter) => {
    const result = await adapter.runStream({
      messages: [
        { role: 'user', content: '上一问' },
        { role: 'assistant', content: '上一答' },
        { role: 'user', content: '画布继续' },
      ],
      model: 'test-model',
      codexLink: { mode: 'resume', threadId: 'thread-parent', turnId: 'turn-parent' },
    });
    assert.equal(result.threadId, 'thread-forked');
    assert.equal(result.threadMode, 'fork');
    const fork = fake.calls.find(([method]) => method === 'thread/fork')[1];
    assert.equal(fork.threadId, 'thread-parent');
    assert.equal(fork.lastTurnId, 'turn-parent');
  });
});
