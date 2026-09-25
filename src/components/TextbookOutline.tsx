import { readerText as rt, useReaderT } from '../i18n/reader';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { markdownHeadings } from '../lib/textbook';

interface OutlineProps {
  source: string;
  body: RefObject<HTMLDivElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  onNavigate: () => void;
}

export function TextbookOutline({ source, body, scroller, onNavigate }: OutlineProps) {
  useReaderT();
  const headings = useMemo(() => markdownHeadings(source), [source]);
  const headingTitle = (h: (typeof headings)[number]) => h.title || rt('未命名标题');
  const chapters = useMemo(() => {
    const seconds = headings.filter(h => h.depth === 2);
    return seconds.length ? seconds : headings.filter(h => h.depth === Math.min(...headings.map(h => h.depth)));
  }, [headings]);
  const [hovered, setHovered] = useState<{ id: string; title: string; x: number; y: number } | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [activeStart, setActiveStart] = useState(-1);
  const trigger = useRef<HTMLButtonElement>(null);
  const map = useRef<HTMLDivElement>(null);
  const activeChapter = chapters.filter(h => h.start <= activeStart).at(-1)?.id;
  const positions = useMemo(() => new Map(headings.map((h, i) => [h.id, { x: 18 + (h.depth - 1) * 27, y: 22 + i * 36 }])), [headings]);
  const graphWidth = Math.max(280, ...headings.map(h => (h.depth - 1) * 27 + 48 + Math.min(210, headingTitle(h).length * 12)));
  const graphHeight = Math.max(60, headings.length * 36 + 8);

  useEffect(() => {
    const viewport = scroller.current, content = body.current;
    if (!viewport || !content) return;
    let frame = 0;
    const update = () => {
      const top = viewport.getBoundingClientRect().top + 40;
      const elements = [...content.querySelectorAll<HTMLElement>('[data-heading-start]')];
      const current = elements.filter(el => el.getBoundingClientRect().top <= top).at(-1);
      setActiveStart(current ? Number(current.dataset.headingStart) : -1);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule); observer.observe(content);
    viewport.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); viewport.removeEventListener('scroll', schedule); };
  }, [headings, body, scroller]);

  useEffect(() => {
    if (!mapOpen) return;
    const close = (event: PointerEvent) => {
      if (!map.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMapOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMapOpen(false); trigger.current?.focus({ preventScroll: true }); }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    map.current?.focus({ preventScroll: true });
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [mapOpen]);

  function navigate(start: number) {
    const viewport = scroller.current;
    const heading = body.current?.querySelector<HTMLElement>(`[data-heading-start="${start}"]`);
    if (!viewport || !heading) return;
    onNavigate(); setHovered(null); setMapOpen(false);
    const top = viewport.scrollTop + heading.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 18;
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
    viewport.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  function preview(button: HTMLButtonElement, id: string, title: string) {
    const rect = button.getBoundingClientRect();
    setHovered({ id, title, x: rect.right + 8, y: Math.max(8, Math.min(rect.top, window.innerHeight - 64)) });
  }

  return <>
    <aside className="textbook-outline" aria-label={rt('文章章节导航')} data-preview={!!hovered}>
      <div className="textbook-outline-rail">
        {chapters.map(h => <button key={h.id} type="button" className="textbook-outline-dot" aria-label={`${rt('章节：')}${headingTitle(h)}`} aria-current={activeChapter === h.id ? 'location' : undefined}
          onMouseEnter={e => preview(e.currentTarget, h.id, headingTitle(h))} onMouseLeave={() => setHovered(null)}
          onFocus={e => preview(e.currentTarget, h.id, headingTitle(h))} onBlur={() => setHovered(null)} onClick={() => navigate(h.start)}><span /></button>)}
        {!chapters.length && <span className="textbook-outline-empty" title={rt('当前文章没有 Markdown 标题')}>—</span>}
      </div>
      <button ref={trigger} type="button" className="textbook-map-toggle" aria-label={mapOpen ? rt('收起章节地图') : rt('展开章节地图')} aria-expanded={mapOpen} aria-controls="textbook-heading-map" title={rt('章节地图')}
        onClick={() => { setHovered(null); setMapOpen(v => !v); }}><span /></button>
      {hovered && <div className="textbook-chapter-tooltip" role="tooltip" style={{ left: hovered.x, top: hovered.y, maxWidth: `min(260px, calc(100vw - ${hovered.x + 12}px))` }}>{hovered.title}</div>}
    </aside>
    {mapOpen && <div ref={map} tabIndex={-1} id="textbook-heading-map" className="textbook-outline-map" role="dialog" aria-label={rt('文章标题分级地图')}>
      <div className="textbook-map-header"><strong>{rt('章节地图')}</strong><span>{headings.length} {rt('个标题')}</span><button type="button" aria-label={rt('关闭章节地图')} onClick={() => { setMapOpen(false); trigger.current?.focus({ preventScroll: true }); }}>×</button></div>
      <div className="textbook-map-scroll">
        {headings.length ? <div className="textbook-map-graph" style={{ width: graphWidth, height: graphHeight }}>
          <svg width={graphWidth} height={graphHeight} aria-hidden="true">
            {headings.map(h => {
              const pos = positions.get(h.id)!, parent = h.parentId ? positions.get(h.parentId) : undefined;
              return parent ? <path key={h.id} d={`M ${parent.x} ${parent.y} V ${pos.y} H ${pos.x}`} /> : null;
            })}
          </svg>
          {headings.map(h => {
            const pos = positions.get(h.id)!;
            return <button key={h.id} className="textbook-map-node" type="button" data-heading-offset={h.start} data-depth={h.depth} aria-current={activeStart === h.start ? 'location' : undefined}
              style={{ left: pos.x - 5, top: pos.y - 13 }} title={headingTitle(h)} aria-label={`H${h.depth} ${headingTitle(h)}`} onClick={() => navigate(h.start)}>
              <span className="textbook-map-node-dot" /><small>H{h.depth}</small><span className="textbook-map-node-title">{headingTitle(h)}</span>
            </button>;
          })}
        </div> : <p className="textbook-map-empty">{rt('当前文章没有标题。添加 # 至 ###### 标题后会自动生成地图。')}</p>}
      </div>
    </div>}
  </>;
}
