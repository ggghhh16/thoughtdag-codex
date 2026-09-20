import type { ThoughtNode, ThoughtEdge } from '../types';
import { NODE_CSS_WIDTH, LAYOUT_H_GAP, LAYOUT_V_GAP } from './constants';

/** A tidy forest for the visual tree, with longest-path layers for DAG merges.
 * A continuation keeps its parent's center; sibling subtrees occupy disjoint
 * intervals on either side. Non-tree edges still constrain vertical ordering.
 * Material cards stay at their user positions. No graph relationships change. */
export function treeLayout(
  allNodes: ThoughtNode[], allEdges: ThoughtEdge[], height: (n: ThoughtNode) => number,
): ThoughtNode[] {
  const material = (n: ThoughtNode) => ['note', 'file', 'link', 'frame'].includes(n.data.stepKind ?? '');
  const nodes = allNodes.filter(n => !material(n));
  if (!nodes.length) return allNodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const allById = new Map(allNodes.map(n => [n.id, n]));
  const width = (n: ThoughtNode) => Math.max(NODE_CSS_WIDTH, n.measured?.width ?? n.width ?? 0);
  const gap = Math.max(80, LAYOUT_H_GAP);
  const solidParents = new Set(allEdges.filter(e => !e.data?.isCrossLink && !e.data?.isWatch).map(e => e.target));
  const candidates = allEdges.filter(e => byId.has(e.source) && byId.has(e.target) && !e.data?.isWatch
    && (!e.data?.isCrossLink || !solidParents.has(e.target)));
  const incoming = new Map(nodes.map(n => [n.id, [] as ThoughtEdge[]]));
  const outgoing = new Map(nodes.map(n => [n.id, [] as ThoughtEdge[]]));
  // References may contain feedback loops. Exclude feedback from the visual
  // tree without deleting it or altering its context semantics.
  for (const edge of candidates) {
    const seen = new Set<string>(), pending = [edge.target];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of outgoing.get(id) ?? []) pending.push(e.target);
    }
    if (seen.has(edge.source) || outgoing.get(edge.source)!.some(e => e.target === edge.target)) continue;
    outgoing.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
  }
  const degree = new Map(nodes.map(n => [n.id, incoming.get(n.id)!.length]));
  const rank = new Map(nodes.map(n => [n.id, 0]));
  const order = nodes.filter(n => !degree.get(n.id)).map(n => n.id);
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    for (const e of outgoing.get(id)!) {
      rank.set(e.target, Math.max(rank.get(e.target)!, rank.get(id)! + 1));
      degree.set(e.target, degree.get(e.target)! - 1);
      if (degree.get(e.target) === 0) order.push(e.target);
    }
  }
  const parent = new Map<string, ThoughtEdge>();
  const children = new Map(nodes.map(n => [n.id, [] as ThoughtEdge[]]));
  for (const id of order) {
    const options = [...incoming.get(id)!].sort((a, b) => rank.get(b.source)! - rank.get(a.source)!
      || Number(!!a.data?.isCrossLink) - Number(!!b.data?.isCrossLink)
      || Number(!!a.data?.isBranchFromSelection) - Number(!!b.data?.isBranchFromSelection));
    if (options[0]) { parent.set(id, options[0]); children.get(options[0].source)!.push(options[0]); }
  }
  interface Span { left: number; right: number; offsets: Map<string, number> }
  const spans = new Map<string, Span>();
  for (const id of [...order].reverse()) {
    const kids = children.get(id)!;
    const offsets = new Map<string, number>();
    const continuation = kids.find(e => !e.data?.isBranchFromSelection) ?? (kids.length === 1 ? kids[0] : undefined);
    if (continuation) {
      offsets.set(continuation.target, 0);
      const center = spans.get(continuation.target)!;
      let left = center.left, right = center.right;
      const others = kids.filter(e => e !== continuation);
      const split = Math.floor(others.length / 2);
      // Place left siblings from the inside out, preserving their order.
      for (const e of others.slice(0, split).reverse()) {
        const span = spans.get(e.target)!, x = left - gap - span.right;
        offsets.set(e.target, x); left = x + span.left;
      }
      for (const e of others.slice(split)) {
        const span = spans.get(e.target)!, x = right + gap - span.left;
        offsets.set(e.target, x); right = x + span.right;
      }
    } else if (kids.length) {
      const total = kids.reduce((sum, e) => { const s = spans.get(e.target)!; return sum + s.right - s.left; }, 0) + gap * (kids.length - 1);
      let cursor = -total / 2;
      for (const e of kids) { const span = spans.get(e.target)!; offsets.set(e.target, cursor - span.left); cursor += span.right - span.left + gap; }
    }
    let left = -width(byId.get(id)!) / 2, right = -left;
    for (const [child, x] of offsets) { const span = spans.get(child)!; left = Math.min(left, x + span.left); right = Math.max(right, x + span.right); }
    spans.set(id, { left, right, offsets });
  }
  const centers = new Map<string, number>();
  let cursor = 0;
  for (const id of order.filter(id => !parent.has(id))) {
    const span = spans.get(id)!;
    const materialParents = allEdges.filter(e => e.target === id && !e.data?.isCrossLink && !e.data?.isWatch)
      .map(e => allById.get(e.source)).filter((n): n is ThoughtNode => !!n && material(n) && n.data.stepKind !== 'frame');
    const preferred = materialParents.length ? materialParents.reduce((sum, n) => sum + n.position.x + width(n) / 2, 0) / materialParents.length : cursor - span.left;
    const x = Math.max(cursor - span.left, preferred);
    centers.set(id, x); cursor = x + span.right + gap * 2;
  }
  for (const id of order) for (const [child, dx] of spans.get(id)!.offsets) centers.set(child, centers.get(id)! + dx);

  const layers = new Map<number, string[]>();
  for (const id of order) { const r = rank.get(id)!; layers.set(r, [...(layers.get(r) ?? []), id]); }
  const positions = new Map<string, { x: number; y: number }>();
  const materials = allNodes.filter(n => material(n) && n.data.stepKind !== 'frame');
  let nextY = 0;
  for (const [, ids] of [...layers].sort(([a], [b]) => a - b)) {
    let y = nextY;
    for (const id of ids) for (const e of allEdges.filter(e => e.target === id && !e.data?.isCrossLink && !e.data?.isWatch)) {
      const p = allById.get(e.source);
      if (p && material(p) && p.data.stepKind !== 'frame') y = Math.max(y, p.position.y + height(p) + LAYOUT_V_GAP);
    }
    const layerHeight = Math.max(...ids.map(id => height(byId.get(id)!)));
    // Push an entire layer below fixed material cards to retain sibling
    // alignment and ensure descendants never move above their parents.
    for (;;) {
      const overlap = materials.find(m => ids.some(id => {
        const n = byId.get(id)!, x = centers.get(id)! - width(n) / 2;
        return x < m.position.x + width(m) + 24 && x + width(n) + 24 > m.position.x
          && y < m.position.y + height(m) + LAYOUT_V_GAP && y + height(n) + LAYOUT_V_GAP > m.position.y;
      }));
      if (!overlap) break;
      y = overlap.position.y + height(overlap) + LAYOUT_V_GAP;
    }
    for (const id of ids) positions.set(id, { x: centers.get(id)! - width(byId.get(id)!) / 2, y });
    const fan = Math.max(...ids.map(id => children.get(id)!.length));
    const branchGap = Math.min(420, 100 * Math.sqrt(Math.max(0, fan - 1)));
    nextY = y + layerHeight + Math.max(96, LAYOUT_V_GAP, branchGap);
  }
  return allNodes.map(n => positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n);
}
