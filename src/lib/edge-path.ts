import type { Position } from '@xyflow/react';
import type { ThoughtNode } from '../types';
import { nodeHeight } from './layout';
import { NODE_CSS_WIDTH } from './constants';

// Routing is presentation only. Moving cards never changes context or handles.
export interface Point { x: number; y: number }
interface Rect { x1: number; y1: number; x2: number; y2: number }
export type EdgeRouteSide = 'auto' | 'left' | 'right';
export type Cubic = [Point, Point, Point, Point];
export interface RoutedPath { path: string; labelX: number; labelY: number; points: Point[]; curves: Cubic[] }
const CLEARANCE = 16;
const TURN_COST = 28;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function bounds(n: ThoughtNode): Rect {
  return { x1: n.position.x, y1: n.position.y,
    x2: n.position.x + (n.measured?.width ?? n.width ?? NODE_CSS_WIDTH),
    y2: n.position.y + (n.measured?.height ?? n.height ?? nodeHeight(n)) };
}
function inflate(r: Rect, amount: number): Rect {
  return { x1: r.x1 - amount, y1: r.y1 - amount, x2: r.x2 + amount, y2: r.y2 + amount };
}
function inside(p: Point, r: Rect): boolean {
  return p.x > r.x1 && p.x < r.x2 && p.y > r.y1 && p.y < r.y2;
}
function clear(a: Point, b: Point, obstacles: Rect[]): boolean {
  if (a.x !== b.x && a.y !== b.y) return false;
  return !obstacles.some(r => a.x === b.x
    ? a.x > r.x1 && a.x < r.x2 && Math.max(a.y, b.y) > r.y1 && Math.min(a.y, b.y) < r.y2
    : a.y > r.y1 && a.y < r.y2 && Math.max(a.x, b.x) > r.x1 && Math.min(a.x, b.x) < r.x2);
}
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length && distance(out[out.length - 1], p) < 0.001) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if ((a.x === b.x && b.x === p.x || a.y === b.y && b.y === p.y)
        && distance(a, b) + distance(b, p) <= distance(a, p) + 0.001) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const length = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
function toward(a: Point, b: Point, amount: number): Point {
  const d = length(a, b) || 1;
  return { x: (b.x - a.x) * amount / d, y: (b.y - a.y) * amount / d };
}
function at([a, b, c, d]: Cubic, t: number): Point {
  const u = 1 - t;
  return { x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y };
}
// Recursive Bezier hull checks cannot skip thin obstacles between samples.
function curveClear(curve: Cubic, obstacles: Rect[], depth = 0): boolean {
  const xs = curve.map(p => p.x), ys = curve.map(p => p.y);
  const near = obstacles.filter(r => Math.max(...xs) > r.x1 && Math.min(...xs) < r.x2
    && Math.max(...ys) > r.y1 && Math.min(...ys) < r.y2);
  if (!near.length) return true;
  if (depth >= 10) return false;
  const [a, b, c, d] = curve, ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
  const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), m = midpoint(abc, bcd);
  return curveClear([a, ab, abc, m], near, depth + 1) && curveClear([m, bcd, cd, d], near, depth + 1);
}
function spline(points: Point[], first: Point, last: Point, tension: number, endLimit = Infinity): Cubic[] {
  const tangents = points.map((p, i) => {
    const before = points[i - 1], after = points[i + 1];
    if (!before) { const d = Math.min(endLimit, length(p, after) * tension); return { x: first.x * d, y: first.y * d }; }
    if (!after) { const d = Math.min(endLimit, length(before, p) * tension); return { x: last.x * d, y: last.y * d }; }
    return toward(before, after, Math.min(length(before, p), length(p, after)) * tension);
  });
  return points.slice(1).map((b, i) => {
    const a = points[i], ta = tangents[i], tb = tangents[i + 1];
    return [a, { x: a.x + ta.x, y: a.y + ta.y }, { x: b.x - tb.x, y: b.y - tb.y }, b];
  });
}
function render(raw: Point[], obstacles: Rect[], side: EdgeRouteSide): RoutedPath {
  const points = simplify(raw), start = points[0], end = points[points.length - 1];
  const first = toward(start, points[1] ?? end, 1), last = toward(points[points.length - 2] ?? start, end, 1);
  const forward = first.x === last.x && Math.abs(first.x) === 1 ? (end.x - start.x) * first.x
    : first.y === last.y && Math.abs(first.y) === 1 ? (end.y - start.y) * first.y : -1;
  const offset = Math.min(260, Math.max(40, length(start, end) * 0.45), forward > 0 ? forward / 2 : Infinity);
  const natural: Cubic = [start, { x: start.x + first.x * offset, y: start.y + first.y * offset },
    { x: end.x - last.x * offset, y: end.y - last.y * offset }, end];
  let curves: Cubic[] | undefined;
  if (side === 'auto' && curveClear(natural, obstacles)) curves = [natural];
  if (!curves && points.length > 2) {
    // The orthogonal search is only an invisible guide. Render a broad,
    // tangent-continuous bow on its chosen side, never its square segments.
    const horizontal = Math.abs(first.x) > Math.abs(first.y);
    const center = midpoint(start, end), axis = horizontal ? 'y' : 'x';
    const outer = points.reduce((a, b) => Math.abs(a[axis] - center[axis]) > Math.abs(b[axis] - center[axis]) ? a : b);
    const direction = Math.sign(outer[axis] - center[axis]) || 1;
    for (const extra of [0, 24, 48, 96, 160, 260, 420]) {
      const via = { ...center, [axis]: outer[axis] + direction * extra };
      const candidate = spline([start, via, end], first, last, 0.65, 40);
      if (candidate.every(c => curveClear(c, obstacles))) { curves = candidate; break; }
    }
  }
  if (!curves) {
    // In narrow corridors, fit a smooth spline to the safe guide, reducing
    // its handles only as much as needed to clear the visible card bounds.
    const guides = points.length >= 6 ? [points.filter((_, i) => i !== 1 && i !== points.length - 2), points] : [points];
    for (const guide of guides) {
      for (const tension of [0.4, 0.25, 0.12, 0.05, 0.01]) {
        const candidate = spline(guide, first, last, tension, 40);
        if (candidate.every(c => curveClear(c, obstacles))) { curves = candidate; break; }
      }
      if (curves) break;
    }
  }
  curves ??= spline(points, first, last, 0.01); // temporarily overlapping cards
  let path = `M ${start.x} ${start.y}`;
  for (const [, b, c, d] of curves) path += ` C ${b.x} ${b.y} ${c.x} ${c.y} ${d.x} ${d.y}`;
  // Locate the toolbar on the rendered curve, not on the invisible guide.
  const samples = curves.flatMap(c => Array.from({ length: 25 }, (_, i) => at(c, i / 24)));
  const total = samples.slice(1).reduce((sum, p, i) => sum + length(samples[i], p), 0);
  let traversed = 0, label = start;
  for (let i = 1; i < samples.length; i++) {
    traversed += length(samples[i - 1], samples[i]);
    if (traversed >= total / 2) { label = samples[i]; break; }
  }
  return { path, labelX: label.x, labelY: label.y, points, curves };
}
function extend(p: Point, side: Position | undefined, amount: number): Point {
  switch (side) {
    case 'left': return { x: p.x - amount, y: p.y };
    case 'right': return { x: p.x + amount, y: p.y };
    case 'top': return { x: p.x, y: p.y - amount };
    default: return { x: p.x, y: p.y + amount };
  }
}

// The common case uses simple lanes. Only staggered obstacles need A* on an
// orthogonal visibility grid. State includes the incoming axis to price turns.
function search(start: Point, end: Point, obstacles: Rect[]): Point[] | null {
  if (obstacles.some(r => inside(start, r) || inside(end, r))) return null;
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(r => [r.x1, r.x2])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(r => [r.y1, r.y2])])].sort((a, b) => a - b);
  const width = xs.length, count = width * ys.length;
  const blocked = new Uint8Array(count);
  for (const r of obstacles) {
    for (let y = 0; y < ys.length; y++) if (ys[y] > r.y1 && ys[y] < r.y2) {
      for (let x = 0; x < width; x++) if (xs[x] > r.x1 && xs[x] < r.x2) blocked[y * width + x] = 1;
    }
  }
  const index = (p: Point) => ys.indexOf(p.y) * width + xs.indexOf(p.x);
  const point = (i: number): Point => ({ x: xs[i % width], y: ys[Math.floor(i / width)] });
  const target = index(end), origin = index(start) * 2;
  const scores = new Float64Array(count * 2).fill(Infinity);
  const previous = new Int32Array(count * 2).fill(-1);
  const heap: { state: number; cost: number; rank: number }[] = [];
  const push = (state: number, cost: number) => {
    const item = { state, cost, rank: cost + distance(point(Math.floor(state / 2)), end) };
    let i = heap.length; heap.push(item);
    while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].rank <= item.rank) break; heap[i] = heap[parent]; i = parent; }
    heap[i] = item;
  };
  const pop = () => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].rank < heap[child].rank) child++;
        if (heap[child].rank >= last.rank) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  scores[origin] = 0; scores[origin + 1] = 0;
  push(origin, 0); push(origin + 1, 0);
  while (heap.length) {
    const { state, cost } = pop();
    if (cost !== scores[state]) continue;
    const at = Math.floor(state / 2), axis = state % 2;
    if (at === target) {
      const result: Point[] = [];
      for (let cur = state; cur !== -1; cur = previous[cur]) result.push(point(Math.floor(cur / 2)));
      return simplify(result.reverse());
    }
    const x = at % width, y = Math.floor(at / width), a = point(at);
    for (const [nx, ny, nextAxis] of [[x - 1, y, 0], [x + 1, y, 0], [x, y - 1, 1], [x, y + 1, 1]]) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
      const next = ny * width + nx, nextState = next * 2 + nextAxis, b = point(next);
      if (blocked[next] || !clear(a, b, obstacles)) continue;
      const score = cost + distance(a, b) + (axis === nextAxis ? 0 : TURN_COST);
      if (score >= scores[nextState]) continue;
      scores[nextState] = score; previous[nextState] = state; push(nextState, score);
    }
  }
  return null;
}

export function routeEdge(
  sourceX: number, sourceY: number, sourcePosition: Position | undefined,
  targetX: number, targetY: number, targetPosition: Position | undefined,
  sourceId: string, targetId: string, nodes: ThoughtNode[], side: EdgeRouteSide = 'auto',
  bend?: Point,
): RoutedPath {
  const src = nodes.find(n => n.id === sourceId), tgt = nodes.find(n => n.id === targetId);
  if (((sourcePosition === 'right' && targetPosition === 'left') || (sourcePosition === 'left' && targetPosition === 'right')) && src && tgt) {
    const s = bounds(src), t = bounds(tgt);
    if (sourcePosition === 'right' ? t.x1 + t.x2 < s.x1 + s.x2 : t.x1 + t.x2 > s.x1 + s.x2) {
      sourceX = s.x1 + s.x2 - sourceX; targetX = t.x1 + t.x2 - targetX;
      sourcePosition = (sourcePosition === 'right' ? 'left' : 'right') as Position;
      targetPosition = (targetPosition === 'left' ? 'right' : 'left') as Position;
    }
  }
  const p0 = { x: sourceX, y: sourceY }, p3 = { x: targetX, y: targetY };
  if (bend && Number.isFinite(bend.x) && Number.isFinite(bend.y)) {
    const mid = midpoint(p0, p3), via = { x: mid.x + bend.x, y: mid.y + bend.y };
    const first = toward(p0, extend(p0, sourcePosition, 1), 1);
    const last = toward(extend(p3, targetPosition, 1), p3, 1);
    const curves = spline([p0, via, p3], first, last, 0.55, 260);
    const path = `M ${p0.x} ${p0.y}` + curves.map(([, b, c, d]) => ` C ${b.x} ${b.y} ${c.x} ${c.y} ${d.x} ${d.y}`).join('');
    // Manual shaping follows the pointer exactly. Reset restores avoidance.
    return { path, labelX: via.x, labelY: via.y, points: [p0, via, p3], curves };
  }
  const horizontal = sourcePosition === 'left' || sourcePosition === 'right';
  const forwardGap = sourcePosition === 'bottom' && targetPosition === 'top' ? targetY - sourceY
    : sourcePosition === 'right' && targetPosition === 'left' ? targetX - sourceX
    : sourcePosition === 'left' && targetPosition === 'right' ? sourceX - targetX : -1;
  const lead = forwardGap > 0 ? Math.min(28, forwardGap / 3) : 28;
  const start = extend(p0, sourcePosition, lead), end = extend(p3, targetPosition, lead);
  const visibleCards: Rect[] = [];
  const obstacles = nodes.filter(n => !n.hidden && n.data.stepKind !== 'frame').map(n => {
    const r = bounds(n), isSource = n.id === sourceId, isTarget = n.id === targetId;
    // Glyph side handles sit inside a wider invisible wrapper.
    const p = isSource ? p0 : p3, direction = isSource ? sourcePosition : targetPosition;
    if (isSource || isTarget) {
      if (direction === 'right' && p.x < r.x2) { r.x1 = r.x1 + r.x2 - p.x; r.x2 = p.x; }
      if (direction === 'left' && p.x > r.x1) { r.x2 = r.x1 + r.x2 - p.x; r.x1 = p.x; }
    }
    // React Flow handles may sit half a border pixel inside their wrapper.
    visibleCards.push(inflate(r, isSource || isTarget ? -1 : 2));
    return inflate(r, isSource || isTarget ? Math.min(CLEARANCE, lead / 2) : CLEARANCE);
  });
  const nearby = obstacles.filter(r => r.x2 >= Math.min(start.x, end.x) - 120 && r.x1 <= Math.max(start.x, end.x) + 120
    && r.y2 >= Math.min(start.y, end.y) - 120 && r.y1 <= Math.max(start.y, end.y) + 120);
  const midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2;
  const xs = [...new Set([midX, ...nearby.flatMap(r => [r.x1, r.x2])])];
  const ys = [...new Set([midY, ...nearby.flatMap(r => [r.y1, r.y2])])];
  const candidates: Point[][] = [
    [start, end],
    ...xs.map(x => [start, { x, y: start.y }, { x, y: end.y }, end]),
    ...ys.map(y => [start, { x: start.x, y }, { x: end.x, y }, end]),
    [start, { x: start.x, y: end.y }, end],
    [start, { x: end.x, y: start.y }, end],
  ];
  // For vertical links left/right means west/east; for side links it means
  // above/below (the UI labels follow the edge axis).
  if (side !== 'auto') {
    const lane = horizontal
      ? side === 'left' ? Math.min(start.y, end.y, ...ys) - 32 : Math.max(start.y, end.y, ...ys) + 32
      : side === 'left' ? Math.min(start.x, end.x, ...xs) - 32 : Math.max(start.x, end.x, ...xs) + 32;
    const a = horizontal ? { x: start.x, y: lane } : { x: lane, y: start.y };
    const b = horizontal ? { x: end.x, y: lane } : { x: lane, y: end.y };
    const segments = [[start, a], [a, b], [b, end]].map(([s, t]) => clear(s, t, obstacles) ? [s, t] : search(s, t, obstacles));
    if (segments.every(p => p !== null)) return render([p0, ...segments.flatMap(p => p!), p3], visibleCards, side);
  }
  let best: Point[] | null = null, score = Infinity;
  for (const candidate of candidates) {
    const p = simplify(candidate);
    if (!p.slice(1).every((v, i) => clear(p[i], v, obstacles))) continue;
    const full = simplify([p0, ...p, p3]);
    // Keep near-equal detours on a consistent side; tiny movements should
    // not flip a wire across the canvas. User preference overrides this.
    const bias = horizontal ? (p.some(v => v.y < Math.min(start.y, end.y)) ? 64 : 0)
      : (p.some(v => v.x < Math.min(start.x, end.x)) ? 64 : 0);
    const cost = full.slice(1).reduce((sum, v, i) => sum + distance(full[i], v), 0)
      + Math.max(0, full.length - 2) * TURN_COST + bias;
    if (cost < score) { score = cost; best = p; }
  }
  if (!best) {
    // Candidate generation is local; every result is checked against all
    // cards, adding off-corridor obstacles if a searched route meets them.
    let relevant = nearby;
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = search(start, end, relevant);
      if (!found) break;
      const crossed = obstacles.filter(r => found.slice(1).some((p, i) => !clear(found[i], p, [r])));
      if (!crossed.length) { best = found; break; }
      relevant = [...new Set([...relevant, ...crossed])];
    }
    if (!best && relevant.length < obstacles.length) best = search(start, end, obstacles);
  }
  // Overlapping cards can enclose a handle. Stay attached and finite while
  // dragging; obstacle avoidance resumes as soon as the cards separate.
  return render([p0, ...(best ?? [start, { x: start.x, y: end.y }, end]), p3], visibleCards, side);
}
