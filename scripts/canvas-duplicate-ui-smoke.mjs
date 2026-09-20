import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const server = await createServer({ cacheDir: '.vite-duplicate-test', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.stack));
  await page.addInitScript(() => {
    localStorage.setItem('thoughtdag.seeded', 'yes');
    localStorage.setItem('thoughtdag.tutorialDone', 'yes');
    localStorage.setItem('thoughtdag.lang', 'zh');
    localStorage.setItem('thoughtdag.theme', 'dark');
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  await page.evaluate(async () => {
    window.projects = await import('/src/store/projects.ts');
    window.persistence = await import('/src/lib/persistence.ts');
    window.idb = await import('/node_modules/idb-keyval/dist/index.js');
    const ui = (await import('/src/lib/ui-store.ts')).useUiStore;
    ui.setState({ panelOpen: false, tutorialOpen: false });
    window.sourceId = window.projects.useProjects.getState().activeId;
    await window.projects.renameProject(window.sourceId, '测试画布');
    window.sourceNodes = ['a', 'b'].map((id, i) => ({
      id, type: 'thought', dragHandle: '.drag-handle', position: { x: 100, y: 100 + i * 400 },
      data: { question: `问题 ${id}`, response: `回答 ${id}`, responses: [`回答 ${id}`], responseIndex: 0,
        highlights: [], isRoot: i === 0, codexThreadIds: ['original-task'], codexTurnIds: ['original-turn'],
        attachments: i === 0 ? [{ id: 'pdf', name: 'sample.pdf', type: 'application/pdf', content: '', contentInVault: true, extractedText: 'PDF text' }] : [],
      },
    }));
    await window.idb.set('att-content:pdf', 'test-pdf-payload');
    window.__store.setState({ nodes: window.sourceNodes, edges: [{ id: 'ab', source: 'a', target: 'b', type: 'smoothstep' }],
      events: [{ at: '2026-09-18T00:00:00Z', op: 'node.create', id: 'a' }] });
    // Intentionally leave this edit in the debounce queue.
    window.__store.getState().editResponse('a', '复制前的最新修改');
  });
  const openMenu = async name => page.getByRole('button', { name, exact: true }).click();
  const copyRow = async name => {
    const row = page.locator('.group').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: page.getByRole('button', { name: '创建副本', exact: true }) });
    await row.hover();
    await row.getByRole('button', { name: '创建副本', exact: true }).click();
    await page.waitForFunction(() => !window.__projects.getState().switching);
  };
  await openMenu('测试画布');
  const sourceRow = page.locator('.group').filter({ has: page.getByText('测试画布', { exact: true }) }).filter({ has: page.getByRole('button', { name: '创建副本', exact: true }) });
  await sourceRow.hover();
  const renameBox = await sourceRow.getByTitle('重命名', { exact: true }).boundingBox();
  const copyBox = await sourceRow.getByTitle('创建副本', { exact: true }).boundingBox();
  assert.ok(copyBox.x > renameBox.x && Math.abs(copyBox.y - renameBox.y) < 2);
  await mkdir('.test-build', { recursive: true });
  await page.screenshot({ path: '.test-build/canvas-duplicate-menu.png' });
  await copyRow('测试画布');
  const first = await page.evaluate(async () => {
    const state = window.__store.getState();
    const meta = window.__projects.getState();
    window.firstCopyId = meta.activeId;
    const { loadAttachmentContent } = await import('/src/lib/attachment-vault.ts');
    return { id: meta.activeId, sourceId: window.sourceId, name: meta.projects.find(p => p.id === meta.activeId).name,
      response: state.nodes[0].data.response, nodes: state.nodes.length, edges: state.edges.length,
      linked: state.nodes.some(n => n.data.codexThreadIds || n.data.codexTurnIds),
      attachment: await loadAttachmentContent(state.nodes[0].data.attachments[0]), events: state.events.length };
  });
  assert.notEqual(first.id, first.sourceId);
  assert.equal(first.name, '测试画布（副本）');
  assert.equal(first.response, '复制前的最新修改');
  assert.equal(first.nodes, 2); assert.equal(first.edges, 1); assert.equal(first.linked, false);
  assert.equal(first.attachment, 'test-pdf-payload'); assert.ok(first.events > 0);
  console.log('UI_BUTTON_CURRENT_CANVAS_LATEST_EDITS_ATTACHMENTS_OK');
  await page.evaluate(async () => {
    window.__store.getState().editResponse('a', '仅修改副本');
    await window.projects.switchProject(window.sourceId);
  });
  assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.response), '复制前的最新修改');
  assert.deepEqual(await page.evaluate(() => window.__store.getState().nodes[1].data.codexThreadIds), ['original-task']);
  await page.evaluate(async () => {
    await window.projects.switchProject(window.firstCopyId);
    await window.persistence.flushPendingWrites();
  });
  await page.reload();
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.response), '仅修改副本');
  console.log('COPY_EDIT_ISOLATION_AND_RELOAD_OK');
  await page.evaluate(async () => {
    window.projects = await import('/src/store/projects.ts');
    window.persistence = await import('/src/lib/persistence.ts');
    window.idb = await import('/node_modules/idb-keyval/dist/index.js');
    window.sourceId = window.__projects.getState().projects.find(p => p.name === '测试画布').id;
  });
  await openMenu('测试画布（副本）');
  await copyRow('测试画布');
  assert.equal(await page.evaluate(() => window.__projects.getState().projects.find(p => p.id === window.__projects.getState().activeId).name), '测试画布（副本） 2');
  assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.response), '复制前的最新修改');
  console.log('INACTIVE_CANVAS_AND_UNIQUE_NAMES_OK');
  const otherCases = await page.evaluate(async () => {
    const api = window.projects;
    const legacyId = crypto.randomUUID();
    const legacyEnvelope = JSON.stringify({ state: {
      nodes: [{ id: 'legacy', type: 'thought', position: { x: 1, y: 2 }, selected: true, data: { question: 'Legacy', response: '保存的数据', responses: ['保存的数据'], responseIndex: 0, highlights: [], isLoading: true, isEditing: true } }],
      edges: [], events: [],
    }, version: 1 });
    await window.idb.set(api.projectStorageKey(legacyId), legacyEnvelope);
    await api.adoptImportedProject(legacyId, 'Legacy', 'paradigm', { instantiatedFrom: { name: 'Template', at: '2026-09-18' }, importedCodexThreadId: 'source-task' });
    const emptyId = await api.createProject('Empty');
    await window.idb.set(api.projectStorageKey(legacyId), legacyEnvelope);
    const copyId = await api.duplicateProject(legacyId);
    const legacyCopy = api.useProjects.getState().projects.find(p => p.id === copyId);
    const legacyNode = window.__store.getState().nodes[0];
    await api.duplicateProject(emptyId);
    const emptyCount = window.__store.getState().nodes.length;
    const concurrent = await Promise.all([api.duplicateProject(emptyId), api.duplicateProject(emptyId)]);
    const badId = crypto.randomUUID();
    await window.idb.set(api.projectStorageKey(badId), '{bad-json');
    api.useProjects.setState(s => ({ projects: [...s.projects, { id: badId, name: 'Bad', createdAt: 0, updatedAt: 0 }] }));
    const before = api.useProjects.getState();
    let rejected = false;
    try { await api.duplicateProject(badId); } catch { rejected = true; }
    const after = api.useProjects.getState();
    return { kind: legacyCopy.kind, provenance: legacyCopy.instantiatedFrom, imported: legacyCopy.importedCodexThreadId,
      selected: legacyNode.selected, loading: legacyNode.data.isLoading, editing: legacyNode.data.isEditing,
      emptyCount, concurrentCount: concurrent.filter(Boolean).length, rejected,
      failurePreserved: before.activeId === after.activeId && before.projects.length === after.projects.length && !after.switching };
  });
  assert.deepEqual(otherCases, { kind: 'paradigm', provenance: { name: 'Template', at: '2026-09-18' }, imported: undefined,
    selected: false, loading: false, editing: false, emptyCount: 0, concurrentCount: 1, rejected: true, failurePreserved: true });
  console.log('LEGACY_EMPTY_PROVENANCE_TRANSIENTS_CONCURRENCY_FAILURE_OK');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
