import assert from 'node:assert/strict';
import test from 'node:test';
import type { Position } from '@xyflow/react';
import type { ThoughtNode, ThoughtEdge } from '../src/types';
import { autoLayout, layoutNewNodes, nodeHeight } from '../src/lib/layout';
import { reversedEdge } from '../src/lib/edge-edit';
import { routeEdge } from '../src/lib/edge-path';

const node = (id: string, x = 0, y = 0): ThoughtNode => ({ id, type: 'thought', position: { x, y },
  measured: { width: 520, height: 280 }, data: { question: id, response: 'Answer', highlights: [] } });
const edge = (source: string, target: string, data: ThoughtEdge['data'] = {}): ThoughtEdge => ({ id: `${source}-${target}`, source, target,
  sourceHandle: data.isBranchFromSelection ? 'branch' : 'continue', targetHandle: data.isBranchFromSelection ? 'left' : 'top', type: 'smoothstep', data });
function checkTree(nodes: ThoughtNode[], edges: ThoughtEdge[]) {
  for (const n of nodes) assert.ok(Number.isFinite(n.position.x) && Number.isFinite(n.position.y));
  for (const e of edges.filter(e => !e.data?.isCrossLink)) {
    const a = nodes.find(n => n.id === e.source)!, b = nodes.find(n => n.id === e.target)!;
    assert.ok(b.position.y >= a.position.y + nodeHeight(a) + 72, `parent order ${e.id}`);
  }
  for (let i = 0; i < nodes.length; i++) for (const b of nodes.slice(i + 1)) {
    const a = nodes[i];
    if (a.data.stepKind === 'frame' || b.data.stepKind === 'frame') continue;
    const overlap = a.position.x < b.position.x + 520 && a.position.x + 520 > b.position.x
      && a.position.y < b.position.y + nodeHeight(b) && a.position.y + nodeHeight(a) > b.position.y;
    assert.ok(!overlap, `overlap ${a.id} / ${b.id}`);
  }
}
test('wide exploration fan becomes a downward tree centered around its main chain', () => {
  const nodes = ['root', 'main', 'main2', ...Array.from({ length: 12 }, (_, i) => `b${i}`)].map(id => node(id));
  const edges = [edge('root', 'main'), edge('main', 'main2'), ...nodes.slice(3).map(n => edge('root', n.id, { isBranchFromSelection: true }))];
  const result = autoLayout(nodes, edges);
  checkTree(result, edges);
  const [root, main, main2] = result;
  assert.equal(root.position.x, main.position.x); assert.equal(main.position.x, main2.position.x);
  assert.ok(result.slice(3).some(n => n.position.x < root.position.x));
  assert.ok(result.slice(3).some(n => n.position.x > root.position.x));
  assert.equal(new Set(result.slice(3).map(n => n.position.y)).size, 1);
  assert.deepEqual(autoLayout(result, edges), result);
});
test('pure branch parent sits over the middle of its children', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(id => node(id));
  const edges = nodes.slice(1).map(n => edge('a', n.id, { isBranchFromSelection: true }));
  const r = autoLayout(nodes, edges); checkTree(r, edges);
  assert.equal(r[0].position.x, (r[1].position.x + r[3].position.x) / 2);
});
test('nested asymmetric subtrees reserve enough width', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => node(`${i}`));
  const edges = nodes.slice(1).map((n, i) => edge(`${Math.floor(i / 3)}`, n.id, { isBranchFromSelection: i % 3 !== 0 }));
  checkTree(autoLayout(nodes, edges), edges);
});
test('merge node is below every incoming parent, including the deeper branch', () => {
  const nodes = ['root', 'a', 'b', 'c', 'merge'].map(id => node(id));
  const edges = [edge('root', 'a'), edge('root', 'b', { isBranchFromSelection: true }), edge('b', 'c'), edge('a', 'merge'), edge('c', 'merge')];
  checkTree(autoLayout(nodes, edges), edges);
});
test('materials stay fixed, conversations avoid them and start beneath material parents', () => {
  const nodes = ['material', 'a', 'b', 'obstacle'].map(id => node(id));
  nodes[0].data.stepKind = 'file'; nodes[0].position = { x: 1500, y: 600 };
  nodes[3].data.stepKind = 'note'; nodes[3].position = { x: 1500, y: 1050 };
  const edges = [edge('material', 'a'), edge('a', 'b')];
  const result = autoLayout(nodes, edges); checkTree(result, edges);
  assert.equal(result[0], nodes[0]); assert.equal(result[3], nodes[3]);
});
test('multiple roots remain independent, long cards do not overlap', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(id => node(id)); nodes[1].data.response = 'x'.repeat(10000);
  const edges = [edge('a', 'b'), edge('c', 'd')];
  checkTree(autoLayout(nodes, edges), edges);
});
test('reference feedback cycles terminate without changing graph facts', () => {
  const nodes = ['a', 'b', 'c'].map(id => node(id));
  const edges = [edge('a', 'b', { isCrossLink: true }), edge('b', 'c', { isCrossLink: true }), edge('c', 'a', { isCrossLink: true })];
  const before = structuredClone({ nodes, edges });
  checkTree(autoLayout(nodes, edges), []);
  assert.deepEqual({ nodes, edges }, before);
});
test('incremental additions still preserve every existing position', () => {
  const old = [node('a', -600, 1000), node('b', 250, 400)];
  const r = layoutNewNodes([...old, node('c')], [edge('a', 'c')], old);
  assert.equal(r[0], old[0]); assert.equal(r[1], old[1]);
  assert.equal(r[2].position.x, old[0].position.x);
});
test('solid and dashed reversal swap context direction and preserve style/depth', () => {
  for (const isCrossLink of [false, true]) {
    const nodes = [node('a'), node('b')], e = edge('a', 'b', { isCrossLink, contextDepth: 'full', routeBend: { x: 20, y: 80 } });
    e.style = { stroke: 'orange', strokeDasharray: isCrossLink ? '8 4' : undefined };
    const result = reversedEdge(e.id, nodes, [e]);
    assert.ok('edge' in result);
    assert.equal(result.edge.source, 'b'); assert.equal(result.edge.target, 'a');
    assert.deepEqual(result.edge.style, e.style); assert.deepEqual(result.edge.data, e.data);
    assert.equal(result.edge.sourceHandle, 'reverse-top'); assert.equal(result.edge.targetHandle, 'reverse-bottom');
    const restored = reversedEdge(e.id, nodes, [result.edge]);
    assert.ok('edge' in restored); assert.deepEqual(restored.edge, e);
  }
});
test('side reversal retains corresponding ports and resets correctly', () => {
  const nodes = [node('a'), node('b')], e = edge('a', 'b', { isBranchFromSelection: true });
  const r = reversedEdge(e.id, nodes, [e]); assert.ok('edge' in r);
  assert.equal(r.edge.sourceHandle, 'reverse-left'); assert.equal(r.edge.targetHandle, 'reverse-right');
  const restored = reversedEdge(e.id, nodes, [r.edge]); assert.ok('edge' in restored); assert.deepEqual(restored.edge, e);
});
test('solid alternate path blocks reversal; dashed reversal permits references', () => {
  const nodes = ['a', 'b', 'c'].map(id => node(id));
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('c', 'b')];
  assert.deepEqual(reversedEdge('a-b', nodes, edges), { error: 'cycle' });
  edges[0].data = { isCrossLink: true };
  assert.ok('edge' in reversedEdge('a-b', nodes, edges));
  assert.deepEqual(reversedEdge('a-b', nodes, [...edges, edge('b', 'a')]), { error: 'duplicate' });
});
test('manual point follows requested location and moves with its nodes', () => {
  const nodes = [node('a'), node('b', 600, 600)];
  const r = routeEdge(260, 280, 'bottom' as Position, 860, 600, 'top' as Position, 'a', 'b', nodes, 'auto', { x: 150, y: -90 });
  assert.equal(r.labelX, 710); assert.equal(r.labelY, 350);
  assert.deepEqual(r.curves[0][3], { x: 710, y: 350 }); assert.deepEqual(r.curves[1][0], r.curves[0][3]);
  assert.ok(!/[LQ]/.test(r.path));
  const shift = routeEdge(360, 480, 'bottom' as Position, 960, 800, 'top' as Position, 'a', 'b', [], 'auto', { x: 150, y: -90 });
  assert.equal(shift.labelX, r.labelX + 100); assert.equal(shift.labelY, r.labelY + 200);
});
