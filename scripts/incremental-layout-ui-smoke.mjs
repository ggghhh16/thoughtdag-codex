import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const server = await createServer({
  ...(process.env.THOUGHTDAG_BASELINE_ROOT ? { root: process.env.THOUGHTDAG_BASELINE_ROOT } : {}),
  cacheDir: resolve('.vite-layout-test'), server: { host: '127.0.0.1', port: 0 },
});
let browser;
let hold = false;
const releases = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (route.request().url().endsWith('/api/models')) {
      await route.fulfill({ headers, json: { models: [{ id: 'test', name: 'Test', isDefault: true }], default: 'test', codex: { status: 'ready' } } });
    } else if (route.request().url().endsWith('/api/stream')) {
      if (hold) await new Promise(r => releases.push(r));
      await route.fulfill({ headers, contentType: 'text/event-stream', body: 'data: {"text":"Test answer"}\n\ndata: {"snapshot":{"text":"Test answer"},"status":"completed"}\n\ndata: [DONE]\n\n' });
    } else await route.fulfill({ headers, json: { text: 'Test', models: [] } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  await page.evaluate(() => {
    const make = (id, x, y) => ({ id, type: 'thought', dragHandle: '.drag-handle', position: { x, y },
      data: { question: `Question ${id}`, response: 'Original answer', responses: ['Original answer'], responseIndex: 0, highlights: [], isRoot: true } });
    window.__store.setState({ nodes: [make('a', 50, 80), make('b', 1400, -320)], edges: [] });
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__rf.setViewport({ x: 0, y: 0, zoom: 1 }));
  const box = await page.locator('.react-flow__node[data-id="a"] .drag-handle').first().boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 100, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 160, { steps: 8 });
  await page.mouse.up();
  const positions = () => page.evaluate(() => Object.fromEntries(window.__store.getState().nodes.map(n => [n.id, n.position])));
  const original = await positions();
  assert.notDeepEqual(original.a, { x: 50, y: 80 });
  const preserved = async expected => {
    const current = await positions();
    for (const [id, position] of Object.entries(expected)) assert.deepEqual(current[id], position, `Node ${id} moved unexpectedly`);
  };
  hold = true;
  await page.evaluate(() => { window.generation = window.__store.getState().addQuestion('New child', { parentId: 'a' }); });
  await preserved(original);
  const child = await page.evaluate(() => window.__store.getState().nodes.at(-1));
  assert.equal(child.position.x, original.a.x);
  assert.ok(child.position.y > original.a.y);
  await page.waitForFunction(() => window.__store.getState().nodes.at(-1).data.isLoading);
  // A drag during generation must survive the completion callback too.
  await page.evaluate(id => window.__store.getState().setNodes(window.__store.getState().nodes.map(n => n.id === id ? { ...n, position: { x: -750, y: 980 } } : n)), child.id);
  const duringGeneration = await positions();
  hold = false;
  while (releases.length) releases.pop()();
  await page.evaluate(() => window.generation);
  await preserved(duringGeneration);
  assert.equal(await page.evaluate(() => window.__store.getState().nodes.at(-1).data.response), 'Test answer');
  console.log('MANUAL_DRAG_ADD_AND_GENERATION_OK');

  for (const action of ['root', 'branch', 'duplicate', 'regenerate', 'fanout', 'merge']) {
    const before = await positions();
    await page.evaluate(async action => {
      const s = window.__store.getState();
      if (action === 'root') await s.addQuestion('New root');
      if (action === 'branch') await s.addQuestion('Explore branch', { parentId: 'a', branchContext: 'Original answer' });
      if (action === 'duplicate') s.duplicateNode('a');
      if (action === 'regenerate') await s.regenerate('a');
      if (action === 'fanout') await s.fanOut('a', 'Compare', [{ name: 'One', prompt: 'One' }, { name: 'Two', prompt: 'Two' }]);
      if (action === 'merge') await s.batchMergeSummarize(['a', 'b']);
    }, action);
    await preserved(before);
    console.log(`${action.toUpperCase()}_PRESERVES_EXISTING_OK`);
  }
  const saved = await positions();
  await page.evaluate(async () => (await import('/src/lib/persistence.ts')).flushPendingWrites());
  await page.reload();
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  await preserved(saved);
  console.log('RELOAD_AFTER_GENERATION_OK');
  await page.evaluate(() => window.__store.getState().relayout());
  assert.notDeepEqual(await positions(), saved);
  await page.evaluate(() => window.__store.getState().undo());
  await preserved(saved);
  console.log('EXPLICIT_RELAYOUT_AND_UNDO_OK');
  const placement = await page.evaluate(async () => {
    const { layoutNewNodes, nodeHeight } = await import('/src/lib/layout.ts');
    const template = window.__store.getState().nodes[0];
    const make = (id, x, y) => ({ ...template, id, position: { x, y }, measured: undefined,
      data: { ...template.data, isCollapsed: false } });
    const existing = [make('parent', 2000, 1000), make('obstacle', 2000, 1350),
      { ...make('material', -1000, 50), data: { ...template.data, stepKind: 'file' } }];
    const added = [make('grandchild', 0, 0), make('child', 0, 0), make('digest', 0, 0)];
    const edges = [['parent', 'child'], ['child', 'grandchild'], ['material', 'digest']]
      .map(([source, target]) => ({ id: `${source}-${target}`, source, target }));
    const result = layoutNewNodes([...existing, ...added], edges, existing);
    return {
      unchanged: existing.every((node, i) => result[i] === node),
      nodes: Object.fromEntries(result.map(n => [n.id, { ...n.position, height: nodeHeight(n) }])),
    };
  });
  assert.ok(placement.unchanged);
  const p = placement.nodes;
  assert.equal(p.child.x, p.parent.x);
  assert.ok(p.child.y >= p.obstacle.y + p.obstacle.height);
  assert.equal(p.grandchild.x, p.child.x);
  assert.ok(p.grandchild.y >= p.child.y + p.child.height);
  assert.equal(p.digest.x, p.material.x);
  assert.ok(p.digest.y >= p.material.y + p.material.height);
  console.log('COLLISION_BATCH_ORDER_AND_MATERIAL_PARENT_OK');
  assert.deepEqual(errors, []);
} finally {
  while (releases.length) releases.pop()();
  await browser?.close();
  await server.close();
}
