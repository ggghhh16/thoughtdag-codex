import type { ThoughtEdge, ThoughtNode } from '../types';

export type ReverseResult = { edge: ThoughtEdge } | { error: 'cycle' | 'duplicate' | 'missing' };
/** Reverse actual context wiring. Render style and reference depth survive. */
export function reversedEdge(id: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): ReverseResult {
  const edge = edges.find(e => e.id === id);
  if (!edge || !nodes.some(n => n.id === edge.source && n.data.stepKind !== 'frame')
    || !nodes.some(n => n.id === edge.target && n.data.stepKind !== 'frame')) return { error: 'missing' };
  if (edges.some(e => e.id !== id && e.source === edge.target && e.target === edge.source)) return { error: 'duplicate' };
  if (!edge.data?.isCrossLink) {
    const seen = new Set<string>(), pending = [edge.source];
    while (pending.length) {
      const at = pending.pop()!;
      if (at === edge.target) return { error: 'cycle' };
      if (seen.has(at)) continue;
      seen.add(at);
      for (const e of edges) if (e.id !== id && !e.data?.isCrossLink && e.source === at) pending.push(e.target);
    }
  }
  const data = { ...edge.data };
  // These describe the original directional relationship, not line styling.
  delete data.followsTip; delete data.isWatch; delete data.branchYRatio;
  const handles = edge.sourceHandle === 'reverse-top' ? ['continue', 'top']
    : edge.sourceHandle === 'reverse-left' ? ['branch', 'left']
    : edge.sourceHandle === 'branch' || edge.targetHandle === 'left' ? ['reverse-left', 'reverse-right']
    : ['reverse-top', 'reverse-bottom'];
  return { edge: { ...edge, source: edge.target, target: edge.source,
    sourceHandle: handles[0], targetHandle: handles[1], data } };
}
