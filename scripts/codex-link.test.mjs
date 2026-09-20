import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

// streaming.ts is a browser module. These tiny storage/window shims are
// sufficient for importing its pure DAG→Codex mapping helpers under Vite SSR.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.window = {
  desktop: undefined,
  location: { hash: '', origin: 'http://localhost' },
  setTimeout,
  clearTimeout,
};

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
after(async () => vite.close());
const { activeCodexLink, codexLinkForGeneration } = await vite.ssrLoadModule('/src/store/streaming.ts');
const { llmCallStream } = await vite.ssrLoadModule('/src/lib/api.ts');
const { buildContext } = await vite.ssrLoadModule('/src/store/context-builder.ts');
const { runNodeGeneration } = await vite.ssrLoadModule('/src/store/streaming.ts');

const data = (patch = {}) => ({
  question: 'question',
  response: '',
  responses: [],
  responseIndex: -1,
  isBranch: false,
  ...patch,
});
const node = (id, patch = {}) => ({ id, data: data(patch) });
const edge = (source, target, patch = {}) => ({ source, target, data: patch });

test('active Codex identity follows the selected answer version', () => {
  assert.deepEqual(activeCodexLink(data({
    responses: ['one', 'two'],
    responseIndex: 1,
    codexThreadIds: ['thread-old', 'thread-current'],
    codexTurnIds: ['turn-old', 'turn-current'],
  })), { threadId: 'thread-current', turnId: 'turn-current' });
});

test('a root or a child of a legacy unmapped card starts a fresh thread', () => {
  assert.deepEqual(codexLinkForGeneration('root', [node('root')], []), { mode: 'start' });
  assert.deepEqual(
    codexLinkForGeneration('child', [node('legacy'), node('child')], [edge('legacy', 'child')]),
    { mode: 'start' },
  );
});

test('the first ordinary child resumes its parent thread', () => {
  const parent = node('parent', {
    responses: ['answer'], responseIndex: 0,
    codexThreadIds: ['thread-1'], codexTurnIds: ['turn-1'],
  });
  assert.deepEqual(
    codexLinkForGeneration('child', [parent, node('child')], [edge('parent', 'child')]),
    { mode: 'resume', threadId: 'thread-1', turnId: 'turn-1' },
  );
});

test('a sibling alternative or selected-text branch forks at the parent turn', () => {
  const parent = node('parent', {
    responses: ['answer'], responseIndex: 0,
    codexThreadIds: ['thread-1'], codexTurnIds: ['turn-1'],
  });
  const first = node('first', { responses: ['first answer'], responseIndex: 0 });
  assert.deepEqual(
    codexLinkForGeneration(
      'sibling',
      [parent, first, node('sibling')],
      [edge('parent', 'first'), edge('parent', 'sibling')],
    ),
    { mode: 'fork', threadId: 'thread-1', turnId: 'turn-1' },
  );
  assert.deepEqual(
    codexLinkForGeneration(
      'branch',
      [parent, node('branch', { branchContext: 'quoted text', isBranch: true })],
      [edge('parent', 'branch', { isBranchFromSelection: true })],
    ),
    { mode: 'fork', threadId: 'thread-1', turnId: 'turn-1' },
  );
});

test('regenerating an answered card forks from its structural parent', () => {
  const parent = node('parent', {
    responses: ['answer'], responseIndex: 0,
    codexThreadIds: ['thread-1'], codexTurnIds: ['turn-1'],
  });
  const child = node('child', {
    response: 'old answer', responses: ['old answer'], responseIndex: 0,
    codexThreadIds: ['thread-1'], codexTurnIds: ['turn-2'],
  });
  assert.deepEqual(
    codexLinkForGeneration('child', [parent, child], [edge('parent', 'child')]),
    { mode: 'fork', threadId: 'thread-1', turnId: 'turn-1' },
  );
});

test('stream requests carry the Codex link and expose final thread metadata', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/models')) {
      return new Response(JSON.stringify({ models: [], default: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    requestBody = JSON.parse(String(init?.body));
    return new Response([
      'data: {"snapshot":{"text":"hello"}}',
      '',
      'data: {"threadId":"thread-2","turnId":"turn-2","threadMode":"fork","status":"completed"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    let metadata;
    const text = await llmCallStream(
      [{ role: 'user', content: 'next' }],
      () => {},
      undefined,
      undefined,
      { onFinal: (value) => { metadata = value; } },
      undefined,
      undefined,
      { mode: 'fork', threadId: 'thread-1', turnId: 'turn-1' },
    );
    assert.equal(text, 'hello');
    assert.deepEqual(requestBody.codexLink, {
      mode: 'fork', threadId: 'thread-1', turnId: 'turn-1',
    });
    assert.deepEqual(metadata, {
      threadId: 'thread-2', turnId: 'turn-2', threadMode: 'fork', status: 'completed',
      model: undefined, reasoningEffort: undefined, modelSpeed: undefined, serviceTier: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PDF full mode passes all page images while explicit text-only mode excludes them', () => {
  const attachment={id:'pdf',name:'paper.pdf',type:'application/pdf',content:'',extractedText:'text',pageImages:['page1','page2'],renderMode:'full'};
  const pdf=node('pdf',{attachments:[attachment],highlights:[]});
  const full=buildContext('pdf',[pdf],[]);
  assert.deepEqual(full.images.map(image=>image.data),['page1','page2']);
  assert.ok(full.messages.some(message=>message.content.includes('text')));
  attachment.renderMode='text-only';
  assert.equal(buildContext('pdf',[pdf],[]).images.length,0);
});

test('an incomplete stream flushes the latest pending answer and reasoning into a failed version', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('data: {"text":"head"}\n\ndata: {"snapshot":{"text":"head plus final received tail","reasoning":"all received reasoning"}}\n\ndata: {"status":"completed"}\n\n');
  let state={nodes:[node('n',{highlights:[],attachments:[],stepKind:'human',isLoading:true})],edges:[],logEvent(){},pushHistory(){}};
  const get=()=>state;
  const set=patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};};
  try {
    await runNodeGeneration(set,get,'n',{question:'question',messages:[{role:'user',content:'question'}]});
    const result=state.nodes[0].data;
    assert.equal(result.response,'head plus final received tail');
    assert.equal(result.reasonings[0],'all received reasoning');
    assert.equal(result.generationFailed,true);
    assert.equal(result.generationMetadata.status,'incomplete');
    assert.equal(result.isLoading,false);
  } finally {globalThis.fetch=originalFetch;}
});
