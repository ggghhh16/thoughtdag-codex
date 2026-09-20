import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow, useStore as useFlowStore, type EdgeProps } from '@xyflow/react';
import { ArrowLeftRight, Move, RotateCcw, X } from 'lucide-react';
import { useStore } from '../store';
import { routeEdge, type Point } from '../lib/edge-path';
import { isViewerMode } from '../lib/viewer';
import { flushPendingWrites } from '../lib/persistence';
import { walkUpAncestors } from '../lib/graph';
import { referenceBlockContent } from '../store/context-builder';
import { countTokens } from '../utils';
import { useT, fmt } from '../i18n';
import type { ThoughtEdge, ThoughtNode } from '../types';

/**
 * Custom edge registered under the 'smoothstep' type name (overrides the
 * built-in, so edges persisted before this component existed pick it up
 * with no migration). Uses smooth Bezier curves around visible cards.
 * Aligned nodes stay straight; selected edges expose a draggable curve point.
 * Click an edge to select
 * it — a delete button appears at its midpoint, and Delete/Backspace
 * removes it via App's key handler.
 */
export default function ThoughtEdgeView({
  id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, markerStart, selected, interactionWidth, data,
}: EdgeProps<ThoughtEdge>) {
  const deleteEdges = useStore((s) => s.deleteEdges);
  const setEdgeStructural = useStore((s) => s.setEdgeStructural);
  const reverseEdge = useStore((s) => s.reverseEdge);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  // React Flow has the display-time hidden flags and current measurements.
  const routingNodes = useFlowStore((s) => s.nodes) as ThoughtNode[];
  const zoom = useFlowStore((s) => s.transform[2]);
  const rf = useReactFlow();
  const [draftBend, setDraftBend] = useState<Point | null>(null);
  const drag = useRef<{ pointer: number; start: Point; initial: Point; latest: Point; moved: boolean } | null>(null);
  const t = useT();

  // The line kind IS the context weight: dashed = summary reference, solid
  // = full wiring (files included). Selected, the edge wears a chip that
  // prices and performs the conversion. Explore and watch edges keep their
  // own semantics and don't convert.
  const isRef = !!data?.isCrossLink;
  const depth = data?.contextDepth === 'full' ? 'full' : 'quote';
  const src = nodes.find((n) => n.id === source);
  const srcIsMaterial = !src || ['note', 'file', 'link'].includes(src.data.stepKind ?? '');
  const convertible = isRef
    ? !data?.isWatch && !srcIsMaterial
    : !data?.isBranchFromSelection && !data?.isWatch && !srcIsMaterial;
  const refTok = useMemo(() => {
    if (!selected || !convertible) return 0;
    if (!src) return 0;
    if (isRef) {
      const structural = edges.filter((e) => !e.data?.isCrossLink);
      const chain = walkUpAncestors(source, nodes, structural).ordered
        .filter((n) => n.id !== source && !['note', 'file', 'link'].includes(n.data.stepKind ?? ''));
      return countTokens(referenceBlockContent({ source: src, edge: { id, source, target, data } as ThoughtEdge, depth, chain }));
    }
    // solid: price what the SUMMARY would be after demotion
    const structural = edges.filter((e) => !e.data?.isCrossLink && e.id !== id);
    const chain = walkUpAncestors(source, nodes, structural).ordered
      .filter((n) => n.id !== source && !['note', 'file', 'link'].includes(n.data.stepKind ?? ''));
    return countTokens(referenceBlockContent({ source: src, edge: { id, source, target, data } as ThoughtEdge, depth: 'quote', chain }));
  }, [selected, convertible, isRef, depth, source, target, id, nodes, edges, data, src]);
  const route = useMemo(
    () => routeEdge(sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, source, target, routingNodes, data?.routeSide, draftBend ?? data?.routeBend),
    [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, source, target, routingNodes, data?.routeSide, data?.routeBend, draftBend],
  );
  const { path, labelX, labelY } = route;
  const a = route.points[0], b = route.points[route.points.length - 1];
  const currentBend = { x: labelX - (a.x + b.x) / 2, y: labelY - (a.y + b.y) / 2 };
  const commitBend = (routeBend?: Point) => {
    const st = useStore.getState();
    if (!st.edges.some(e => e.id === id)) return;
    st.pushHistory();
    st.setEdges(st.edges.map(e => e.id === id ? { ...e, data: { ...e.data, routeBend, routeSide: undefined } } : e));
    st.pushHistory();
    void flushPendingWrites().catch(error => console.error('[thoughtdag] edge route save failed:', error));
  };
  const cancelDrag = () => { drag.current = null; setDraftBend(null); };
  const startDrag = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, start: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), initial: currentBend, latest: currentBend, moved: false };
  };
  const moveDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const dx = p.x - active.start.x, dy = p.y - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) * zoom < 2) return;
    active.moved = true; active.latest = { x: active.initial.x + dx, y: active.initial.y + dy };
    setDraftBend(active.latest);
  };
  const finishDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    if (active.moved) commitBend(active.latest);
    cancelDrag();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // When selected, force full visibility (overrides the ancestor-dim pass)
  // and thicken the stroke as selection feedback.
  const edgeStyle = selected ? { ...style, strokeWidth: 3, opacity: 1 } : style;

  return (
    <>
      <BaseEdge
        path={path}
        style={edgeStyle}
        markerEnd={markerEnd}
        markerStart={markerStart}
        interactionWidth={Math.max(interactionWidth ?? 20, 24)}
      />
      {data?.focusRole === 'path' && (
        // Context Focus feed line: bright dots gliding INSIDE the solid
        // stroke (narrower than it, so the line never reads as dashed —
        // dashed is taken: references)
        <path d={path} className="tdag-flow-ov" fill="none" />
      )}
      {selected && !isViewerMode && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan w-7 h-7"
            style={{
              position: 'absolute',
              pointerEvents: 'all',
              transformOrigin: '0 0',
              transform: `translate(${labelX}px, ${labelY}px) scale(${1 / zoom}) translate(-50%, -50%)`,
            }}
          >
            <button
              data-edge-bend={id}
              aria-label={t('edge.dragCurve')}
              title={t('edge.dragCurve')}
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={cancelDrag}
              onLostPointerCapture={cancelDrag}
              onClick={e => e.stopPropagation()}
              onDoubleClick={e => { e.stopPropagation(); cancelDrag(); commitBend(); }}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelDrag(); return; }
                const delta = e.shiftKey ? 24 : 8;
                const vectors: Record<string, Point> = { ArrowLeft: { x: -delta, y: 0 }, ArrowRight: { x: delta, y: 0 }, ArrowUp: { x: 0, y: -delta }, ArrowDown: { x: 0, y: delta } };
                const v = vectors[e.key];
                if (v) { e.preventDefault(); e.stopPropagation(); commitBend({ x: currentBend.x + v.x, y: currentBend.y + v.y }); }
              }}
              style={{ touchAction: 'none' }}
              className="nodrag nopan nowheel w-7 h-7 rounded-full bg-card border-2 border-accent text-accent shadow-md flex items-center justify-center cursor-grab active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <Move size={14} />
            </button>
            <div className="absolute top-9 left-1/2 -translate-x-1/2 flex items-center gap-1 p-1 rounded-full bg-card border border-line shadow-md whitespace-nowrap">
              <button
                aria-label={t('edge.reverse')}
                title={t('edge.reverseTitle')}
                onClick={e => { e.stopPropagation(); reverseEdge(id); }}
                className="w-7 h-7 rounded-full flex items-center justify-center text-ink-muted hover:text-accent hover:bg-wash"
              >
                <ArrowLeftRight size={14} />
              </button>
              <button
                aria-label={t('edge.resetCurve')}
                title={t('edge.resetCurve')}
                onClick={e => { e.stopPropagation(); commitBend(); }}
                className="w-7 h-7 rounded-full flex items-center justify-center text-ink-muted hover:text-accent hover:bg-wash"
              ><RotateCcw size={14} /></button>
              {convertible && refTok > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setEdgeStructural(id, isRef); }}
                  className="h-6 px-2 rounded-full bg-card border border-line shadow-md flex items-center text-2xs text-ink-muted hover:text-accent hover:border-accent/40 transition-colors whitespace-nowrap"
                  title={isRef ? t('edge.depthToggleTitle') : t('edge.solidChipTitle')}
                >
                  {isRef
                    ? fmt(t(depth === 'full' ? 'edge.fullChip' : 'edge.quoteChip'), { n: refTok })
                    : fmt(t('edge.solidChip'), { n: refTok })}
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); deleteEdges([id]); }}
                className="w-6 h-6 rounded-full bg-card border border-line shadow-md flex items-center justify-center text-ink-faint hover:text-red-500 hover:border-red-300 transition-colors"
                title={t('canvas.deleteEdgeTitle')}
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
