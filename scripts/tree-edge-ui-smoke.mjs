import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const server = await createServer({ cacheDir: '.vite-tree-test', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.text().includes('[React Flow]:')) errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('thoughtdag.seeded', 'yes'); localStorage.setItem('thoughtdag.tutorialDone', 'yes');
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  await page.evaluate(async () => {
    window.ui = (await import('/src/lib/ui-store.ts')).useUiStore;
    window.ui.setState({ panelOpen: false, tutorialOpen: false });
    window.makeNode = (id, x, y, title = id) => ({ id, type: 'thought', dragHandle: '.drag-handle', position: { x, y },
      data: { question: title, response: '这张卡片用于验证连线编辑和树状排版。', responses: ['这张卡片用于验证连线编辑和树状排版。'], responseIndex: 0, highlights: [], isRoot: true } });
    window.makeEdge = (id, source, target, ref = false, branch = false) => ({ id, source, target,
      type: 'smoothstep', sourceHandle: branch ? 'branch' : 'continue', targetHandle: branch ? 'left' : 'top',
      markerEnd: { type: 'arrowclosed', color: branch ? '#eab308' : '#8b8df8' },
      style: { stroke: branch ? '#eab308' : '#8b8df8', strokeWidth: 2, ...(ref ? { strokeDasharray: '8 4' } : {}) },
      data: { isCrossLink: ref, isBranchFromSelection: branch } });
    const ns = [window.makeNode('a', 50, 50, '实线起点'), window.makeNode('b', 50, 600, '实线终点'),
      window.makeNode('c', 1100, 50, '虚线起点'), window.makeNode('d', 1100, 600, '虚线终点')];
    const es = [window.makeEdge('solid', 'a', 'b'), window.makeEdge('dashed', 'c', 'd', true)];
    window.__store.setState({ nodes: ns, edges: es, selectedNodeId: null, selectedNodeIds: [] });
    window.__store.getState().pushHistory();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__rf.setViewport({ x: 100, y: 80, zoom: 0.7 }));
  await page.waitForTimeout(350);
  await mkdir('.test-build', { recursive: true });
  const stateEdge = id => page.evaluate(id => window.__store.getState().edges.find(e => e.id === id), id);
  const select = async id => {
    const path = page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`);
    const p = await path.evaluate(el => { const p = el.getPointAtLength(el.getTotalLength() / 2).matrixTransform(el.getScreenCTM()); return { x: p.x, y: p.y }; });
    await page.mouse.click(p.x, p.y);
    await page.locator(`[data-edge-bend="${id}"]`).waitFor();
    return path;
  };
  for (const id of ['solid', 'dashed']) {
    const path = await select(id), grip = page.locator(`[data-edge-bend="${id}"]`);
    const initialPath = await path.getAttribute('d'), initialEdge = await stateEdge(id);
    const fixed = await page.evaluate(() => ({ nodes: window.__store.getState().nodes.map(n => n.position), viewport: window.__rf.getViewport(), history: window.__store.getState().history.length }));
    const box = await grip.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 140, y + 35, { steps: 15 });
    assert.equal((await stateEdge(id)).data.routeBend, undefined, 'drag is a preview until release');
    const moving = await grip.boundingBox();
    assert.ok(Math.abs(moving.x + moving.width / 2 - (x + 140)) < 2, 'control point follows pointer');
    assert.notEqual(await path.getAttribute('d'), initialPath);
    await page.mouse.up();
    const bent = await stateEdge(id); assert.ok(bent.data.routeBend);
    const oldEnds = await path.evaluate(el => { const a = el.getPointAtLength(0), b = el.getPointAtLength(el.getTotalLength()); return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]; });
    assert.deepEqual(await page.evaluate(() => window.__store.getState().nodes.map(n => n.position)), fixed.nodes);
    assert.deepEqual(await page.evaluate(() => window.__rf.getViewport()), fixed.viewport);
    await page.evaluate(() => window.__store.getState().undo());
    assert.equal((await stateEdge(id)).data.routeBend, undefined);
    await page.evaluate(() => window.__store.getState().redo());
    assert.deepEqual((await stateEdge(id)).data.routeBend, bent.data.routeBend);
    await page.getByRole('button', { name: '反向连线', exact: true }).click();
    const reversed = await stateEdge(id);
    assert.equal(reversed.source, initialEdge.target); assert.equal(reversed.target, initialEdge.source);
    assert.deepEqual(reversed.style, initialEdge.style); assert.equal(reversed.data.isCrossLink, initialEdge.data.isCrossLink);
    const contextCheck = await page.evaluate(({ source, target }) => {
      const { nodes, edges } = window.__store.getState();
      const sourceTitle = nodes.find(n => n.id === source).data.question;
      const targetTitle = nodes.find(n => n.id === target).data.question;
      const text = id => window.__buildContext(id, nodes, edges).messages.map(m => m.content).join('\n');
      return { downstreamReceivesSource: text(target).includes(sourceTitle), upstreamExcludesTarget: !text(source).includes(targetTitle) };
    }, reversed);
    assert.deepEqual(contextCheck, { downstreamReceivesSource: true, upstreamExcludesTarget: true });
    await path.waitFor(); assert.ok((await path.getAttribute('d')).includes(' C '));
    await page.waitForTimeout(60);
    const newEnds = await path.evaluate(el => { const a = el.getPointAtLength(0), b = el.getPointAtLength(el.getTotalLength()); return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]; });
    assert.ok(Math.hypot(newEnds[0].x - oldEnds[1].x, newEnds[0].y - oldEnds[1].y) < 3, JSON.stringify({ id, oldEnds, newEnds }));
    assert.ok(Math.hypot(newEnds[1].x - oldEnds[0].x, newEnds[1].y - oldEnds[0].y) < 3);
    await page.evaluate(() => window.__store.getState().undo());
    assert.equal((await stateEdge(id)).source, initialEdge.source);
    await page.evaluate(() => window.__store.getState().redo());
    assert.equal((await stateEdge(id)).source, initialEdge.target);
    // Escape cancels the next pointer gesture without changing the saved bend.
    const cancelBox = await grip.boundingBox();
    await page.mouse.move(cancelBox.x + 14, cancelBox.y + 14); await page.mouse.down();
    await page.mouse.move(cancelBox.x + 70, cancelBox.y + 80, { steps: 5 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual((await stateEdge(id)).data.routeBend, bent.data.routeBend);
    await page.screenshot({ path: `.test-build/${id}-curve-drag.png` });
    console.log(`${id.toUpperCase()}_DRAG_REVERSE_UNDO_CANCEL_OK`);
  }
  // At overview scale the control remains 28 screen pixels and follows drag.
  await page.evaluate(() => window.__rf.setViewport({ x: 250, y: 150, zoom: 0.25 }));
  await page.waitForTimeout(350);
  assert.ok(Math.abs((await page.locator('[data-edge-bend="dashed"]').boundingBox()).width - 28) < 1);
  const saved = await page.evaluate(() => window.__store.getState().edges);
  await page.evaluate(async () => (await import('/src/lib/persistence.ts')).flushPendingWrites());
  await page.reload(); await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  for (const e of saved) { const actual = await stateEdge(e.id); assert.equal(actual.source, e.source); assert.deepEqual(actual.data.routeBend, e.data.routeBend); }
  console.log('OVERVIEW_SIZE_AND_RELOAD_OK');

  // Reversed material edges must still have a valid target port.
  await page.evaluate(() => {
    const st = window.__store.getState();
    const material = { ...st.nodes[0], id: 'material', position: { x: 550, y: 850 }, data: { ...st.nodes[0].data, stepKind: 'note' } };
    st.setNodes([...st.nodes, material]);
    st.setEdges([...st.edges, { id: 'material-edge', source: 'material', target: 'a', sourceHandle: 'continue', targetHandle: 'top', type: 'smoothstep', data: {} }]);
    if (!st.reverseEdge('material-edge')) throw new Error('Material reversal failed');
  });
  await page.waitForTimeout(250);
  assert.equal((await stateEdge('material-edge')).target, 'material');
  await page.locator('.react-flow__edge[data-id="material-edge"] .react-flow__edge-path').waitFor();

  // Reproduce the wide exploration fan from the reported layout.
  await page.evaluate(() => {
    const make = (id, title) => ({ id, type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
      data: { question: title, response: '父节点在上，子分支向下展开。', responses: ['父节点在上，子分支向下展开。'], responseIndex: 0, highlights: [], isRoot: true } });
    const nodes = [make('root', '研究问题'), make('main', '主对话'), make('main2', '继续推进')];
    const edges = [{ id: 'main', source: 'root', target: 'main' }, { id: 'main2', source: 'main', target: 'main2' }];
    for (let i = 0; i < 8; i++) {
      nodes.push(make(`branch${i}`, `分支 ${i + 1}`));
      edges.push({ id: `branch${i}`, source: 'root', target: `branch${i}`, data: { isBranchFromSelection: true } });
      if (i % 2 === 0) { nodes.push(make(`child${i}`, '继续该分支')); edges.push({ id: `child${i}`, source: `branch${i}`, target: `child${i}` }); }
    }
    window.__store.setState({ nodes, edges: edges.map(e => ({ ...e, type: 'smoothstep', sourceHandle: e.data?.isBranchFromSelection ? 'branch' : 'continue', targetHandle: e.data?.isBranchFromSelection ? 'left' : 'top',
      style: { stroke: e.data?.isBranchFromSelection ? '#eab308' : '#8b8df8', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: e.data?.isBranchFromSelection ? '#eab308' : '#8b8df8' } })), selectedNodeId: null, selectedNodeIds: [] });
    window.__store.getState().relayout();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__rf.fitView({ padding: 0.12, maxZoom: 0.8 }));
  await page.waitForTimeout(450);
  const tree = await page.evaluate(() => {
    const { nodes, edges } = window.__store.getState();
    return { nodes: nodes.map(n => ({ id: n.id, position: n.position })), edges };
  });
  for (const e of tree.edges) {
    assert.ok(tree.nodes.find(n => n.id === e.target).position.y > tree.nodes.find(n => n.id === e.source).position.y);
    assert.equal(e.sourceHandle, 'continue'); assert.equal(e.targetHandle, 'top');
  }
  await page.screenshot({ path: '.test-build/tree-layout-overview.png' });
  // Restoring automatic routing is exposed directly beside the drag point.
  await page.evaluate(() => {
    const st = window.__store.getState();
    st.setEdges(st.edges.map(e => e.id === 'main' ? { ...e, selected: true, data: { ...e.data, routeBend: { x: 50, y: 20 } } } : e));
  });
  await page.getByRole('button', { name: '恢复自动曲线', exact: true }).click();
  assert.equal((await stateEdge('main')).data.routeBend, undefined);
  console.log('TREE_LAYOUT_AND_DOWNWARD_PORTS_OK');
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.close(); }
