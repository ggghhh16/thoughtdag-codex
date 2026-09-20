import assert from 'node:assert/strict';
import test from 'node:test';
import type { Position } from '@xyflow/react';
import { routeEdge, type RoutedPath, type EdgeRouteSide } from '../src/lib/edge-path';
import type { ThoughtNode } from '../src/types';

const node = (id: string, x: number, y: number, width = 100, height = 60): ThoughtNode => ({
  id, type: 'thought', position: { x, y }, measured: { width, height },
  data: { question: 'A question', response: '', highlights: [] },
});
const vertical = (nodes: ThoughtNode[], side: EdgeRouteSide = 'auto') => {
  const [s, t] = nodes;
  return routeEdge(s.position.x + s.measured!.width! / 2, s.position.y + s.measured!.height!, 'bottom' as Position,
    t.position.x + t.measured!.width! / 2, t.position.y, 'top' as Position, s.id, t.id, nodes, side);
};
function avoids(route: RoutedPath, nodes: ThoughtNode[]) {
  assert.ok(!/NaN|Infinity/.test(route.path));
  assert.ok(!/[LQ]/.test(route.path), 'visible edges must remain Bezier curves');
  for (const [a, b, c, d] of route.curves) {
    for (let i = 1; i < 500; i++) {
      const t = i / 500, u = 1 - t;
      const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x;
      const y = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y;
      for (const n of nodes.filter(n => !n.hidden && n.data.stepKind !== 'frame')) {
        assert.ok(!(x > n.position.x && x < n.position.x + n.measured!.width!
          && y > n.position.y && y < n.position.y + n.measured!.height!), `curve crosses ${n.id}`);
      }
    }
  }
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i];
    assert.ok(a.x === b.x || a.y === b.y, 'segments must be orthogonal');
    for (const n of nodes.filter(n => !n.hidden && n.data.stepKind !== 'frame')) {
      const x1 = n.position.x, y1 = n.position.y, x2 = x1 + n.measured!.width!, y2 = y1 + n.measured!.height!;
      const hit = a.x === b.x
        ? a.x > x1 && a.x < x2 && Math.max(a.y, b.y) > y1 && Math.min(a.y, b.y) < y2
        : a.y > y1 && a.y < y2 && Math.max(a.x, b.x) > x1 && Math.min(a.x, b.x) < x2;
      assert.ok(!hit, `path intersects ${n.id}: ${route.path}`);
    }
  }
}
test('aligned chain is one straight line, even across a narrow gap', () => {
  for (const y of [65, 80, 160, 600]) {
    const nodes = [node('s', 0, 0), node('t', 0, y)];
    const result = vertical(nodes);
    assert.equal(result.points.length, 2);
    avoids(result, nodes);
  }
});
test('offset chain uses one natural Bezier curve', () => {
  const nodes = [node('s', 0, 0), node('t', 300, 240)];
  const result = vertical(nodes);
  assert.ok(result.path.includes(' C '));
  assert.equal(result.curves.length, 1);
  assert.ok(result.points.length <= 4);
  avoids(result, nodes);
});
test('avoids a thin card and both endpoint cards exactly', () => {
  const nodes = [node('s', 0, 0), node('t', 0, 700), node('block', -150, 350, 400, 2)];
  avoids(vertical(nodes), nodes);
});
test('frames and hidden cards do not change a route', () => {
  const nodes = [node('s', 0, 0), node('t', 0, 700)];
  const hidden = { ...node('hidden', -50, 300, 300, 80), hidden: true };
  const frame = node('frame', -500, -500, 2000, 2000); frame.data.stepKind = 'frame';
  assert.equal(vertical([...nodes, hidden, frame]).path, vertical(nodes).path);
});
test('actual measured height overrides large text layout estimate', () => {
  const nodes = [node('s', 0, 0), node('t', 350, 300), node('block', 170, 70, 80, 30)];
  nodes[2].data.response = 'long response '.repeat(1000);
  const before = vertical(nodes).path;
  nodes[2].data.response = '';
  assert.equal(vertical(nodes).path, before);
});
test('backward continuation goes around its own cards', () => {
  const nodes = [node('s', 0, 400), node('t', 0, 0), node('block', 120, 140, 150, 200)];
  avoids(vertical(nodes), nodes);
});
test('side branch mirrors endpoints when dragged left', () => {
  const nodes = [node('s', 400, 0), node('t', 0, 0)];
  const result = routeEdge(500, 30, 'right' as Position, 0, 24, 'left' as Position, 's', 't', nodes);
  assert.deepEqual(result.points[0], { x: 400, y: 30 });
  assert.deepEqual(result.points.at(-1), { x: 100, y: 24 });
  avoids(result, nodes);
});
test('small movement keeps a symmetric obstacle detour on the same side', () => {
  for (let x = -10; x <= 10; x++) {
    const nodes = [node('s', 0, 0), node('t', x, 700), node('block', -50, 300, 200, 80)];
    const result = vertical(nodes);
    assert.ok(result.points.some(p => p.x >= 166));
    avoids(result, nodes);
  }
});
test('manual direction changes only the route; auto restores deterministic path', () => {
  const nodes = [node('s', 0, 0), node('t', 0, 700), node('block', -50, 300, 200, 80)];
  const saved = structuredClone(nodes), automatic = vertical(nodes).path;
  const left = vertical(nodes, 'left'), right = vertical(nodes, 'right');
  assert.ok(left.points.some(p => p.x < -66));
  assert.ok(right.points.some(p => p.x > 166));
  avoids(left, nodes); avoids(right, nodes);
  assert.deepEqual(nodes, saved);
  assert.equal(vertical(nodes).path, automatic);
});
test('side links support above and below detours', () => {
  const nodes = [node('s', 0, 0), node('t', 600, 0), node('block', 250, -40, 100, 160)];
  for (const side of ['left', 'right'] as const) {
    const result = routeEdge(100, 30, 'right' as Position, 600, 24, 'left' as Position, 's', 't', nodes, side);
    assert.ok(result.points.some(p => side === 'left' ? p.y < -56 : p.y > 136));
    avoids(result, nodes);
  }
});
test('staggered obstacles and distant cards do not get crossed', () => {
  let seed = 42;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 60; trial++) {
    const nodes = [node('s', 0, 0), node('t', 300, 1200)];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
      if (random() < 0.5) nodes.push(node(`n${row}-${col}`, -400 + col * 200 + random() * 30, 170 + row * 180, 130, 90));
    }
    avoids(vertical(nodes), nodes);
  }
});
test('visibility search escapes a corridor requiring more than two turns', () => {
  const nodes = [node('s', 0, 0), node('t', 0, 600),
    node('left-wall', -140, 80, 160, 140), node('right-wall', 80, 80, 100, 140),
    node('lower-wall', -100, 300, 300, 60)];
  const route = vertical(nodes);
  avoids(route, nodes);
  assert.ok(route.points.length >= 5);
});
test('overlapping endpoint fallback stays finite', () => {
  const result = vertical([node('s', 0, 0), node('t', 5, 0)]);
  assert.ok(!/NaN|Infinity/.test(result.path));
});
test('100-card routing stays interactive in common layouts', () => {
  const nodes = Array.from({ length: 100 }, (_, i) => node(`n${i}`, (i % 10) * 200, Math.floor(i / 10) * 180));
  const start = performance.now();
  for (let i = 0; i < 90; i++) vertical([nodes[i], nodes[i + 10], ...nodes.filter((_, k) => k !== i && k !== i + 10)]);
  const elapsed = performance.now() - start;
  console.log(`90 edges / 100 cards: ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 1000, `routing took ${elapsed}ms`);
});
