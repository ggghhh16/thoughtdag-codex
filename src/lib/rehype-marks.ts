import type { Element, Parents, Root, Text } from 'hast';

export interface ExploreMarkSpec { text: string; nodeId: string; title: string }
export interface MarkOptions { highlights: Set<string>; exploreMarks?: ExploreMarkSpec[] }

const BLOCKS = new Set(['p', 'div', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'br', 'hr']);

// Mark rendered text, never Markdown source. This preserves fences, inline
// code, tables and syntax highlighting, and keeps copyCode free of markup.
export function rehypeMarks(options: MarkOptions) {
  return (tree: Root) => {
    if (!options.highlights.size && !options.exploreMarks?.length) return;
    const leaves: { node: Text; parent: Parents; start: number; end: number }[] = [];
    let text = '';
    const boundary = () => { if (text && !/\s$/.test(text)) text += '\n'; };
    const walk = (parent: Parents) => {
      for (const node of parent.children) {
        if (node.type === 'text') {
          const start = text.length;
          text += node.value;
          leaves.push({ node, parent, start, end: text.length });
        } else if (node.type === 'element') {
          const classes = String(node.properties.className ?? '').split(/[ ,]+/);
          // Do not alter formula input, hidden content, or author-supplied marks.
          if (['script', 'style', 'mark', 'math'].includes(node.tagName) || classes.some(c => c === 'katex' || c === 'math-inline' || c === 'math-display')) {
            text += '\0';
            continue;
          }
          if (BLOCKS.has(node.tagName)) boundary();
          walk(node);
          if (BLOCKS.has(node.tagName)) boundary();
        }
      }
    };
    walk(tree);

    const spans: { start: number; end: number; properties: Element['properties'] }[] = [];
    const collect = (selection: string, properties: Element['properties']) => {
      const trimmed = selection.trim();
      if (!trimmed) return;
      // Selections use rendered characters; only whitespace can differ between
      // browser Selection.toString() and the HTML tree (e.g. table cell gaps).
      const pattern = trimmed.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
        const span = { start: match.index, end: match.index + match[0].length, properties };
        if (!spans.some(other => span.start < other.end && other.start < span.end)) spans.push(span);
      }
    };
    // The user's highlight takes precedence over exploration traces.
    for (const selection of options.highlights) collect(selection, { className: ['bg-amber-100', 'text-amber-800', 'px-0.5', 'rounded'] });
    for (const mark of options.exploreMarks ?? []) collect(mark.text, {
      className: ['explore-mark'], 'data-explore-target': mark.nodeId, title: mark.title,
    });
    spans.sort((a, b) => a.start - b.start);

    for (const leaf of leaves) {
      const matches = spans.filter(span => span.start < leaf.end && leaf.start < span.end);
      if (!matches.length) continue;
      const replacements: (Text | Element)[] = [];
      let cursor = 0;
      for (const span of matches) {
        const start = Math.max(span.start, leaf.start) - leaf.start;
        const end = Math.min(span.end, leaf.end) - leaf.start;
        if (start > cursor) replacements.push({ type: 'text', value: leaf.node.value.slice(cursor, start) });
        replacements.push({ type: 'element', tagName: 'mark', properties: { ...span.properties }, children: [{ type: 'text', value: leaf.node.value.slice(start, end) }] });
        cursor = end;
      }
      if (cursor < leaf.node.value.length) replacements.push({ type: 'text', value: leaf.node.value.slice(cursor) });
      const index = leaf.parent.children.indexOf(leaf.node);
      leaf.parent.children.splice(index, 1, ...replacements);
    }
  };
}
