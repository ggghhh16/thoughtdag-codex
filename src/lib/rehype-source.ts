import { readerText as rt } from '../i18n/reader';
import type { Root, Element, Text, RootContent } from 'hast';
import type { Plugin } from 'unified';
import { decodeString } from 'micromark-util-decode-string';

/** Map rendered text boundaries back through Markdown escapes/entities. */
export function sourceTextMap(raw: string, rendered: string): number[] | null {
  let decoded = '';
  const offsets = [0];
  for (const token of raw.matchAll(/\\[!-/:-@[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});|\r\n|[\s\S]/gi)) {
    const value = decodeString(token[0]).replace(/\r\n/g, '\n');
    decoded += value;
    for (let i = 0; i < value.length; i++) offsets.push(token.index + (i === value.length - 1 ? token[0].length : 0));
  }
  return decoded === rendered ? offsets : null;
}

/** Source ranges are attached after sanitizing user HTML, before highlighting.
 * They refer to the actual Markdown bytes (UTF-16 offsets), never layout pixels. */
export interface SourceOptions { source: string; ranges?: { start: number; end: number; id: string; question: boolean; number?: number }[] }
export const rehypeSource: Plugin<[SourceOptions], Root> = ({ source, ranges = [] }) => tree => {
  const numbered = new Set<string>();
  const textValue = (n: RootContent): string => n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(textValue).join('') : '';
  function visit(parent: Root | Element) {
    parent.children = parent.children.flatMap(child => {
      if (child.type === 'element') {
        if (/^h[1-6]$/.test(child.tagName) && child.position?.start.offset !== undefined) {
          child.properties['data-heading-start'] = child.position.start.offset;
        }
        if (child.tagName === 'code') {
          const pos = child.position ?? parent.position;
          if (pos?.start.offset !== undefined && pos.end.offset !== undefined) {
            const value = source.slice(pos.start.offset, pos.end.offset);
            const normalized = value.replace(/\r\n/g, '\n');
            const rawOffsets = [...value.matchAll(/[^\r]|\r(?!\n)/g)].map(m => m.index);
            rawOffsets.push(value.length);
            const idx = normalized.indexOf(textValue(child).replace(/\r\n/g, '\n').replace(/\n$/, ''));
            if (idx >= 0) {
              let cursor = idx;
              const mapCode = (n: RootContent) => {
                if (n.type === 'text') { n.value = n.value.replace(/\r\n/g, '\n'); n.position = { start: { ...pos.start, offset: pos.start.offset! + (rawOffsets[cursor] ?? value.length) }, end: { ...pos.end, offset: pos.start.offset! + (rawOffsets[cursor + n.value.length] ?? value.length) } }; cursor += n.value.length; }
                else if (n.type === 'element') n.children.forEach(mapCode);
              };
              child.children.forEach(mapCode);
            }
          }
        }
        visit(child); return child;
      }
      if (child.type !== 'text') return child;
      const text = child as Text;
      const start = text.position?.start.offset, end = text.position?.end.offset;
      if (start === undefined || end === undefined || !text.value.trim()) return child;
      const raw = source.slice(start, end);
      // Preserve safe mapping of escaped characters and entities too. Boundaries
      // inside such tokens select the complete source token, never another quote.
      const normalizedRaw = raw.replace(/\r\n/g, '\n');
      const exact = normalizedRaw === text.value || normalizedRaw === text.value.replace(/\n$/, '');
      const mapping = !exact ? sourceTextMap(raw, text.value) : null;
      const cuts = exact || mapping ? [...new Set([start, end, ...ranges.flatMap(r => [r.start, r.end]).filter(p => p > start && p < end)])].sort((a, b) => a - b) : [start, end];
      return cuts.slice(0, -1).map((a, i) => {
        const b = cuts[i + 1];
        const hits = ranges.filter(r => r.start < b && r.end > a);
        const labels = hits.filter(h => h.number && !numbered.has(h.id));
        labels.forEach(h => numbered.add(h.id));
        const part = source.slice(a, b);
        const mappedStart = mapping?.findIndex(n => n >= a - start) ?? 0;
        const mappedEnd = mapping?.findIndex(n => n >= b - start) ?? 0;
        return { type: 'element', tagName: 'span', properties: { 'data-md-start': a, 'data-md-end': b, 'data-md-exact': exact || mapping ? '1' : '0', 'data-md-breaks': [...part.matchAll(/\r\n/g)].map(m => m.index).join(','),
          ...(mapping ? { 'data-md-map': mapping.slice(mappedStart, mappedEnd + 1).map(n => n - (a - start)).join(',') } : {}),
          ...(labels.length ? { 'data-mark-number': labels.map(h => h.number).join('·'), 'aria-label': `${rt('标记 ')}${labels.map(h => h.number).join('、')}`, title: rt('点击定位问题 · 右键编辑或删除') } : {}),
          ...(hits.length ? { className: [hits.some(h => h.question) ? 'textbook-question-mark' : 'textbook-reading-mark', ...(hits.some(h => h.id === '__flash__') ? ['textbook-flash'] : []), ...(hits.some(h => h.id === '__selection__') ? ['textbook-selection'] : [])], 'data-mark-ids': hits.map(h => h.id).join(' ') } : {}) },
          children: [{ type: 'text', value: exact ? part.replace(/\r\n/g, '\n') : mapping ? text.value.slice(mappedStart, mappedEnd) : text.value }] } as Element;
      });
    }) as RootContent[] & Element['children'];
  }
  visit(tree);
};

export function sourceSelection(root: HTMLElement, selection: Selection | null): { start: number; end: number } | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  function boundary(node: Node, offset: number, end: boolean): number | null {
    const el = (node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement)?.closest<HTMLElement>('[data-md-start]');
    if (!el || !root.contains(el)) return null;
    const base = Number(el.dataset.mdStart), limit = Number(el.dataset.mdEnd);
    if (el.dataset.mdExact !== '1') return end ? limit : base;
    const prefix = document.createRange(); prefix.selectNodeContents(el); prefix.setEnd(node, offset);
    if (el.dataset.mdMap) return Math.min(limit, base + el.dataset.mdMap.split(',').map(Number)[prefix.toString().length]);
    let rawOffset = prefix.toString().length;
    for (const pos of (el.dataset.mdBreaks || '').split(',').filter(Boolean).map(Number)) if (pos < rawOffset) rawOffset++;
    return Math.min(limit, base + rawOffset);
  }
  const start = boundary(range.startContainer, range.startOffset, false);
  const end = boundary(range.endContainer, range.endOffset, true);
  if (start !== null && end !== null && start < end) return { start, end };
  // Browser paragraph selections may end on the parent element boundary.
  const spans = [...root.querySelectorAll<HTMLElement>('[data-md-start]')].filter(el => range.intersectsNode(el));
  if (!spans.length) return null;
  return { start: start ?? Number(spans[0].dataset.mdStart), end: end ?? Number(spans.at(-1)!.dataset.mdEnd) };
}
