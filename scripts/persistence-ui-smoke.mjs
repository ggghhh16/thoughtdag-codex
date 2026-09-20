import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = await createServer({ cacheDir: '.vite-test', server: { host: '127.0.0.1', port: 0 } });
let browser;
const profile = await mkdtemp(join(tmpdir(), 'thoughtdag-persistence-qa-'));
const launch = () => chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 } });
try {
  await server.listen();
  browser = await launch();
  let page = browser.pages()[0];
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  await page.evaluate(async () => {
    const { useUiStore } = await import('/src/lib/ui-store.ts');
    window.ui = useUiStore;
    const text = Array.from({ length: 100 }, (_, i) => `Paragraph ${i + 1}: This is a long response for reading progress verification.`).join('\n\n');
    window.__store.setState({ nodes: ['a', 'b'].map((id, i) => ({
      id, type: 'thought', position: { x: i * 700, y: 100 }, dragHandle: '.drag-handle',
      data: { question: `Question ${id}`, response: text, responses: [text], responseIndex: 0, highlights: [], isRoot: true },
    })), edges: [] });
    await (await import('/src/lib/persistence.ts')).flushPendingWrites();
    window.__rf.setViewport({ x: 50, y: 0, zoom: 1 });
  });
  await page.waitForTimeout(600);
  const handle = page.locator('.react-flow__node[data-id="a"] .drag-handle').first();
  const box = await handle.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 100, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 115, { steps: 10 });
  await page.mouse.up();
  const position = await page.evaluate(() => window.__store.getState().nodes.find(n => n.id === 'a').position);
  console.log('DRAG_POSITION', position);
  assert.notDeepEqual(position, { x: 0, y: 100 });
  await page.reload();
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  assert.deepEqual(await page.evaluate(() => window.__store.getState().nodes.find(n => n.id === 'a')?.position), position);
  console.log('IMMEDIATE_RELOAD_LAYOUT_OK');
  await page.evaluate(async () => {
    window.ui = (await import('/src/lib/ui-store.ts')).useUiStore;
    window.ui.getState().setPanelOpen(true);
    window.__store.getState().setSelectedNodeId('a');
  });
  const scroller = page.locator('[data-focus-panel] > .overflow-y-auto');
  await scroller.evaluate(el => { el.scrollTop = 1200; });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__store.getState().setSelectedNodeId('b'));
  await page.waitForTimeout(100);
  assert.equal(await scroller.evaluate(el => el.scrollTop), 0);
  await scroller.evaluate(el => { el.scrollTop = 650; });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__store.getState().setSelectedNodeId('a'));
  await page.waitForTimeout(100);
  assert.equal(await scroller.evaluate(el => el.scrollTop), 1200);
  console.log('PANEL_NODE_SWITCH_OK');
  await page.evaluate(() => window.ui.getState().setResponseViewerNodeId('a'));
  const viewer = page.locator('[data-reading-surface="viewer"]');
  await viewer.evaluate(el => { el.scrollTop = 1700; });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.ui.getState().setResponseViewerNodeId(null));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.ui.getState().setResponseViewerNodeId('a'));
  await page.waitForTimeout(50);
  assert.equal(await viewer.evaluate(el => el.scrollTop), 1700);
  console.log('VIEWER_CLOSE_REOPEN_OK');
  await page.evaluate(async () => {
    window.ui.getState().setResponseViewerNodeId(null);
    const st = window.__store.getState();
    st.setNodes([...st.nodes, { id: 'material', type: 'thought', position: { x: 1400, y: 100 }, data: { ...st.nodes[0].data, stepKind: 'note', question: st.nodes[0].data.response } }]);
    await (await import('/src/lib/persistence.ts')).flushPendingWrites();
    window.ui.getState().setReaderNodeId('material');
  });
  const material = page.locator('[data-reading-surface="material"]');
  await material.evaluate(el => { el.scrollTop = 900; });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.ui.getState().setReaderNodeId(null));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.ui.getState().setReaderNodeId('material'));
  await page.waitForTimeout(50);
  assert.equal(await material.evaluate(el => el.scrollTop), 900);
  console.log('MATERIAL_CLOSE_REOPEN_OK');
  // A real browser-process restart with a private test profile.
  await browser.close();
  browser = await launch();
  page = browser.pages()[0];
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  assert.deepEqual(await page.evaluate(() => window.__store.getState().nodes.find(n => n.id === 'a')?.position), position);
  await page.evaluate(async () => {
    window.ui = (await import('/src/lib/ui-store.ts')).useUiStore;
    window.ui.getState().setPanelOpen(true);
    window.__store.getState().setSelectedNodeId('a');
  });
  assert.equal(await page.locator('[data-reading-surface="panel"]').evaluate(el => el.scrollTop), 1200);
  await page.evaluate(() => window.__store.getState().setSelectedNodeId('b'));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('[data-reading-surface="panel"]').evaluate(el => el.scrollTop), 650);
  await page.evaluate(() => window.ui.getState().setResponseViewerNodeId('a'));
  assert.equal(await page.locator('[data-reading-surface="viewer"]').evaluate(el => el.scrollTop), 1700);
  await page.evaluate(() => { window.ui.getState().setResponseViewerNodeId(null); window.ui.getState().setReaderNodeId('material'); });
  assert.equal(await page.locator('[data-reading-surface="material"]').evaluate(el => el.scrollTop), 900);
  console.log('PROCESS_RESTART_LAYOUT_AND_READING_OK');
  // Identical node IDs in another canvas must have independent offsets.
  await page.evaluate(async () => {
    window.ui.getState().setReaderNodeId(null);
    window.projects = await import('/src/store/projects.ts');
    const original = window.projects.useProjects.getState().activeId;
    window.originalProject = original;
    const nodes = window.__store.getState().nodes;
    const id = crypto.randomUUID();
    const { set } = await import('/node_modules/idb-keyval/dist/index.js');
    await set(window.projects.projectStorageKey(id), { state: { nodes, edges: [] }, version: 1 });
    await window.projects.adoptImportedProject(id, 'QA independent canvas');
    window.__store.getState().setSelectedNodeId('a');
  });
  assert.equal(await page.locator('[data-reading-surface="panel"]').evaluate(el => el.scrollTop), 0);
  await page.evaluate(async () => {
    await window.projects.switchProject(window.originalProject);
    window.__store.getState().setSelectedNodeId('a');
  });
  assert.equal(await page.locator('[data-reading-surface="panel"]').evaluate(el => el.scrollTop), 1200);
  console.log('PROJECT_ISOLATION_OK');
  await page.evaluate(() => {
    window.ui.getState().setPanelOpen(false);
    window.__store.getState().setSelectedNodeId(null);
    window.__rf.setViewport({ x: 10, y: 0, zoom: 1 });
  });
  const card = page.locator('.react-flow__node[data-id="a"] [data-reading-surface="card"]');
  await card.evaluate(el => { el.scrollTop = 800; });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__rf.setViewport({ x: -50000, y: -50000, zoom: 1 }));
  await card.waitFor({ state: 'detached' });
  await page.evaluate(() => window.__rf.setViewport({ x: 10, y: 0, zoom: 1 }));
  assert.equal(await card.evaluate(el => el.scrollTop), 800);
  console.log('CANVAS_CARD_UNMOUNT_RESTORE_OK');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
