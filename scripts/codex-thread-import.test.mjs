import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

globalThis.localStorage = {
  getItem: () => 'en',
  setItem: () => {},
  removeItem: () => {},
};
globalThis.window = {
  desktop: {},
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { hash: '', origin: 'http://localhost' },
  setTimeout,
  clearTimeout,
};
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
};
const vite = await createServer({ server: { middlewareMode: true, hmr: { port: 24679 } }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
after(async () => vite.close());
const {
  asImportableCodexConversation,
  buildCodexThreadGraph,
  codexThreadImportAvailable,
  detachCodexConversationLinks,
  getCodexThread,
  listCodexThreads,
} = await vite.ssrLoadModule('/src/lib/codex-thread-import.ts');
const { withCodexThreadImportLock } = await vite.ssrLoadModule('/src/lib/export.ts');

const summary = {
  id: '01a05292-6468-7262-b9f7-173df320060a',
  name: 'Review the import flow',
  preview: 'Please review the importer and make it idempotent.',
  cwd: 'D:\\Code\\thoughtdag-codex',
  projectId: null,
  sourceKind: 'vscode',
  threadSource: 'vscode',
  createdAt: 1788055200,
  updatedAt: 1788057000,
};

test('accepts the real backend list DTO, archive filter, and Unix-second timestamps', async () => {
  const requests = [];
  globalThis.window.desktop = {
    listCodexThreads: async (options) => {
      requests.push(options);
      return { threads: [summary], nextCursor: 'page-2' };
    },
  };
  const page = await listCodexThreads({ search: 'import', limit: 30, archived: true });
  await listCodexThreads({ limit: 10, archived: false });
  assert.deepEqual(requests, [
    { search: 'import', limit: 30, archived: true },
    { limit: 10, archived: false },
  ]);
  assert.equal(page.threads.length, 1);
  assert.equal(page.threads[0].id, summary.id);
  assert.equal(page.threads[0].createdAt, '2026-08-30T02:00:00.000Z');
  assert.equal(page.threads[0].updatedAt, '2026-08-30T02:30:00.000Z');
  assert.equal(page.nextCursor, 'page-2');
});

test('builds completed turns as a vertical resumable chain with reasoning provenance', async () => {
  globalThis.window.desktop = {
    listCodexThreads: async () => ({ threads: [] }),
    readCodexThread: async () => ({
      thread: {
        ...summary,
        latestTurnId: 'turn-2',
        turns: [
          {
            id: 'turn-1',
            userText: 'First question',
            assistantText: 'First answer',
            reasoningSummary: 'Checked the repository structure.',
            status: 'completed',
            startedAt: 1788055210,
            completedAt: 1788055220,
          },
          {
            id: 'turn-2',
            userText: 'Second question',
            assistantText: 'Second answer',
            status: 'completed',
            startedAt: 1788055300,
            completedAt: 1788055360,
          },
          // Frontend safeguard: a partial DTO is ignored even though the
          // backend normally filters it before returning the detail payload.
          { id: 'turn-partial', userText: 'unfinished', assistantText: '', status: 'inProgress' },
        ],
      },
    }),
  };
  assert.equal(codexThreadImportAvailable(), true);
  const thread = await getCodexThread(summary.id);
  assert.equal(thread.turns.length, 2);
  assert.equal(thread.turns[0].completedAt, '2026-08-30T02:00:20.000Z');

  const ids = ['node-1', 'node-2'];
  const graph = buildCodexThreadGraph(thread, () => ids.shift());
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.nodes[0].position.x, graph.nodes[1].position.x);
  assert.ok(graph.nodes[1].position.y > graph.nodes[0].position.y);
  assert.deepEqual(graph.nodes[0].data.codexThreadIds, [summary.id]);
  assert.deepEqual(graph.nodes[0].data.codexTurnIds, ['turn-1']);
  assert.deepEqual(graph.nodes[1].data.codexTurnIds, ['turn-2']);
  assert.deepEqual(graph.nodes[0].data.reasonings, ['Checked the repository structure.']);
  assert.equal(graph.edges[0].source, 'node-1');
  assert.equal(graph.edges[0].target, 'node-2');
});

test('imports archived tasks as deduplicated snapshots without resumable node links', async () => {
  const archivedThread = {
    id: summary.id,
    name: summary.name,
    archived: true,
    turns: [
      {
        id: 'archived-turn-1',
        userText: 'Archived question',
        assistantText: 'Archived answer',
      },
    ],
  };
  const graph = buildCodexThreadGraph(archivedThread, () => 'archived-node-1');
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].data.codexThreadIds, undefined);
  assert.equal(graph.nodes[0].data.codexTurnIds, undefined);

  // Project-level provenance remains so importing the same official task is
  // idempotent, even though its cards cannot resume an archived task.
  const conversation = asImportableCodexConversation(archivedThread);
  assert.equal(conversation.codexThreadId, summary.id);
});

test('does not expose import when the secure desktop bridge is unavailable', async () => {
  globalThis.window.desktop = {};
  assert.equal(codexThreadImportAvailable(), false);
  await assert.rejects(listCodexThreads(), /desktop app/);
});

test('detaches forged local task identities at the JSON interchange boundary', () => {
  const node = {
    id: 'node-1',
    data: {
      codexThreadIds: ['forged-thread'],
      codexTurnIds: ['forged-turn'],
    },
  };
  const [detached] = detachCodexConversationLinks([node]);
  assert.equal(detached.data.codexThreadIds, undefined);
  assert.equal(detached.data.codexTurnIds, undefined);
  assert.deepEqual(node.data.codexThreadIds, ['forged-thread']);
});

test('serializes concurrent imports of the same official Codex task', async () => {
  let running = 0;
  let maximumRunning = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withCodexThreadImportLock('thread-a', async () => {
    running += 1;
    maximumRunning = Math.max(maximumRunning, running);
    await firstGate;
    running -= 1;
    return 'first';
  });
  const second = withCodexThreadImportLock('thread-a', async () => {
    running += 1;
    maximumRunning = Math.max(maximumRunning, running);
    running -= 1;
    return 'second';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(running, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(maximumRunning, 1);
});
