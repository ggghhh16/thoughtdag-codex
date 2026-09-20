import type { ThoughtNode, ThoughtEdge } from '../types';
import { treeLayout } from './tree-layout';
import { COLLAPSED_NODE_HEIGHT, LAYOUT_COL_WIDTH, LAYOUT_H_GAP, LAYOUT_V_GAP } from './constants';

// Estimated rendered height of a node — fallback when React Flow hasn't
// measured the DOM yet (fresh nodes) and for collapse shifting. Every
// variable region of the card is height-capped in CSS (question scrolls at
// 180px, the answer at 400px), so the estimate caps each part the same way
// — an uncapped formula here would keep spreading nodes for content the
// card no longer grows for.
export function estimateNodeHeight(node: ThoughtNode): number {
  if (node.data.isCollapsed) return COLLAPSED_NODE_HEIGHT;
  // Calibrated against measured DOM heights (2026-08): CJK markdown renders
  // ~1px per char at card width before the 400px CSS cap, chrome (header +
  // takeaway line + follow-up input + paddings) runs ~215px, and each
  // highlight row adds its own line. Under-estimating here is what made
  // map-mode relayout overlap once zoomed back in.
  const questionH = Math.min(180, 40 + (node.data.question || '').length / 1.2);
  const responseH = Math.min(400, (node.data.response || '').length / 1.05);
  const highlightsH = (node.data.highlights?.length ?? 0) * 26;
  const estimated = 215 + questionH + responseH + highlightsH;
  return Math.max(260, Math.min(900, estimated));
}

// Height used for layout: the larger of the measured DOM height (React
// Flow's ResizeObserver writes `measured` back through onNodesChange) and
// the estimate. The max matters: while zoomed out, semantic zoom renders
// small thumbnail cards, so `measured` under-reports the full-size height —
// laying out with it would overlap once the user zooms back in. Slightly
// generous spacing beats overlapping cards.
export function nodeHeight(node: ThoughtNode): number {
  return Math.max(node.measured?.height ?? 0, estimateNodeHeight(node));
}

/** Place only newly added nodes. Existing coordinates are user-owned;
 * ordinary graph edits must never run a full-canvas layout over them. */
export function layoutNewNodes(
  allNodes: ThoughtNode[],
  allEdges: ThoughtEdge[],
  previousNodes: readonly ThoughtNode[],
): ThoughtNode[] {
  const existing = new Set(previousNodes.map(n => n.id));
  const material = (n: ThoughtNode) => ['note', 'file', 'link', 'frame'].includes(n.data.stepKind ?? '');
  const placed = new Map(allNodes.filter(n => existing.has(n.id) || material(n)).map(n => [n.id, n]));
  const pending = allNodes.filter(n => !placed.has(n.id));
  const structural = allEdges.filter(e => !e.data?.isCrossLink);
  const incoming = new Map<string, ThoughtEdge[]>();
  const outgoing = new Map<string, ThoughtEdge[]>();
  for (const edge of structural) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  const width = (n: ThoughtNode) => Math.max(n.measured?.width ?? 0, n.width ?? 0, LAYOUT_COL_WIDTH);
  // Reserve the expanded card's footprint even if asking collapsed its parent.
  const height = (n: ThoughtNode) => Math.max(nodeHeight(n), n.height ?? 0,
    estimateNodeHeight({ ...n, data: { ...n.data, isCollapsed: false } }));
  const pitch = LAYOUT_COL_WIDTH + LAYOUT_H_GAP;
  while (pending.length) {
    // Parents in the same insertion batch must be placed before their children.
    // The fallback also terminates on malformed cyclic/dangling input.
    const ready = pending.findIndex(n => !(incoming.get(n.id) ?? [])
      .some(e => pending.some(p => p.id === e.source)));
    const node = pending.splice(Math.max(0, ready), 1)[0];
    const parentEdges = (incoming.get(node.id) ?? []).filter(e => placed.has(e.source));
    const primary = parentEdges[0];
    const parent = primary ? placed.get(primary.source)! : undefined;
    const obstacles = [...placed.values()].filter(n => n.data.stepKind !== 'frame');
    let x: number;
    let y: number;
    if (parent && primary) {
      const siblings = outgoing.get(parent.id) ?? [];
      const continuation = siblings.find(e => !e.data?.isBranchFromSelection);
      const branches = siblings.filter(e => e !== continuation);
      x = parent.position.x + (primary === continuation ? 0 : (branches.indexOf(primary) + 1) * pitch);
      y = Math.max(...parentEdges.map(e => {
        const p = placed.get(e.source)!;
        return p.position.y + height(p) + LAYOUT_V_GAP;
      }));
    } else {
      x = obstacles.length ? Math.max(...obstacles.map(n => n.position.x + width(n))) + LAYOUT_H_GAP : node.position.x;
      y = node.position.y;
    }
    // Resolve collisions by moving the NEW node down only. Never move an
    // obstacle, and keep continuation children in their actual parent's column.
    for (;;) {
      const overlap = obstacles.find(n => x < n.position.x + width(n) + 24
        && x + width(node) + 24 > n.position.x
        && y < n.position.y + height(n) + LAYOUT_V_GAP
        && y + height(node) + LAYOUT_V_GAP > n.position.y);
      if (!overlap) break;
      y = overlap.position.y + height(overlap) + LAYOUT_V_GAP;
    }
    placed.set(node.id, { ...node, position: { x, y } });
  }
  return allNodes.map(n => placed.get(n.id)!);
}

/** Explicit tree layout; routine graph edits still use layoutNewNodes. */
export function autoLayout(allNodes: ThoughtNode[], allEdges: ThoughtEdge[]): ThoughtNode[] {
  return treeLayout(allNodes, allEdges, nodeHeight);
}

