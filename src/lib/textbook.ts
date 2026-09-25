import type { Root, RootContent } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export type CitationScope = 'nearby' | 'section' | 'chapter';
export interface TextbookDocument {
  id: string;
  libraryId: string;
  relativePath: string;
  title: string;
  version: string;
  content: string;
  scrollTop?: number;
  lastReadAt?: number;
  marks: SourceMark[];
}
export interface SourceAnchor {
  documentId: string;
  relativePath: string;
  version: string;
  start: number;
  end: number;
  text: string;
  prefix: string;
  suffix: string;
  headingPath: string[];
  snapshot: string;
}
export interface SourceCitation {
  materialId: string;
  anchor: SourceAnchor;
  scope: CitationScope;
  start: number;
  end: number;
  content: string;
}
export interface SourceMark { id: string; anchor: SourceAnchor; number?: number; hidden?: boolean; }
export interface ReaderSnapshot {
  projectId: string;
  documents: { nodeId: string; document: TextbookDocument }[];
  questions: { id: string; question: string; citation: SourceCitation; relocation?: SourceAnchor; failed?: boolean; number?: number; hidden?: boolean }[];
}
export interface ReaderCommand {
  id: string;
  projectId?: string;
  action: 'snapshot' | 'open' | 'ask' | 'highlight' | 'locate' | 'position' | 'reanchor' | 'resend' | 'delete-mark';
  materialId?: string;
  libraryId?: string;
  relativePath?: string;
  question?: string;
  mentions?: string[];
  anchor?: SourceAnchor;
  scope?: CitationScope;
  nodeId?: string;
  scrollTop?: number;
}
export interface ReaderReply { snapshot?: ReaderSnapshot; materialId?: string; error?: string; }

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
type Block = { start: number; end: number; type: string; depth?: number; title: string };
export function markdownBlocks(content: string): Block[] {
  const tree = parser.parse(content);
  return tree.children.filter(n => n.position).map(n => ({
    start: n.position!.start.offset!, end: n.position!.end.offset!, type: n.type,
    depth: 'depth' in n ? Number(n.depth) : undefined,
    title: content.slice(n.position!.start.offset, n.position!.end.offset).replace(/^#+\s*/, '').replace(/\s*#+\s*$/, ''),
  }));
}
export interface MarkdownHeading {
  id: string;
  start: number;
  end: number;
  depth: number;
  title: string;
  parentId?: string;
}
/** Parse real Markdown headings, including setext, without treating fenced code as headings. */
export function markdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [], stack: MarkdownHeading[] = [];
  const text = (node: RootContent): string => {
    if ('value' in node) return node.value;
    if ('alt' in node) return node.alt ?? '';
    if ('children' in node) return node.children.map(text).join('');
    return node.type === 'break' ? ' ' : '';
  };
  const visit = (node: Root | RootContent) => {
    if (node.type === 'heading' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      while (stack.length && stack.at(-1)!.depth >= node.depth) stack.pop();
      const start = node.position.start.offset;
      const heading = { id: `heading-${start}`, start, end: node.position.end.offset, depth: node.depth,
        title: node.children.map(text).join('').trim(), parentId: stack.at(-1)?.id };
      headings.push(heading); stack.push(heading);
    } else if ('children' in node) node.children.forEach(visit);
  };
  visit(parser.parse(content));
  return headings;
}
function sectionAt(content: string, start: number) {
  const blocks = markdownBlocks(content);
  const headings: Block[] = [];
  for (const block of blocks) {
    if (block.start > start) break;
    if (block.type !== 'heading') continue;
    while (headings.length && headings.at(-1)!.depth! >= block.depth!) headings.pop();
    headings.push(block);
  }
  const heading = headings.at(-1);
  const end = blocks.find(b => b.start > start && b.type === 'heading' && b.depth! <= (heading?.depth ?? 6))?.start ?? content.length;
  return { blocks, start: heading?.start ?? 0, end, path: headings.map(h => h.title) };
}
export function createAnchor(doc: TextbookDocument, start: number, end: number): SourceAnchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > doc.content.length || start >= end) throw new Error('选区无效，请重新框选。');
  return { documentId: doc.id, relativePath: doc.relativePath, version: doc.version, start, end,
    text: doc.content.slice(start, end), prefix: doc.content.slice(Math.max(0, start - 80), start),
    suffix: doc.content.slice(end, end + 80), headingPath: sectionAt(doc.content, start).path, snapshot: doc.content };
}
export function createCitation(materialId: string, anchor: SourceAnchor, scope: CitationScope): SourceCitation {
  const content = anchor.snapshot;
  const section = sectionAt(content, anchor.start);
  let start = anchor.start, end = anchor.end;
  if (scope === 'chapter') { start = 0; end = content.length; }
  else if (scope === 'section') { start = section.start; end = Math.max(section.end, anchor.end); }
  else {
    const touched = section.blocks.filter(b => b.end > start && b.start < end);
    if (touched.length) {
      start = touched[0].start; end = touched.at(-1)!.end;
      const first = section.blocks.indexOf(touched[0]), last = section.blocks.indexOf(touched.at(-1)!);
      const before = section.blocks[first - 1], after = section.blocks[last + 1];
      if (before && before.type !== 'heading' && before.start >= section.start) start = before.start;
      if (after && after.type !== 'heading' && after.end <= section.end) end = after.end;
    }
  }
  return { materialId, anchor, scope, start, end, content: content.slice(start, end) };
}
export const scopeLabels: Record<CitationScope, string> = { nearby: '选区及附近内容', section: '本小节', chapter: '整章' };
export function citationMessage(c: SourceCitation): string {
  return `[Textbook reference: ${c.anchor.relativePath}; version=${c.anchor.version}; range=${c.start}:${c.end}; scope=${c.scope}]\nHeading: ${c.anchor.headingPath.join(' > ')}\nActual selection (${c.anchor.start}:${c.anchor.end}):\n${c.anchor.text}\nReferenced source:\n${c.content}\n[/Textbook reference]`;
}

/** Conservative relocation: exact version offsets, or uniquely verified surrounding
 * text. A lone matching quote is insufficient after edits: repeated text may have
 * been deleted or moved. Never use fuzzy matching or nearest-screen coordinates. */
export function resolveAnchor(anchor: SourceAnchor, content: string, version: string): { start: number; end: number } | null {
  if (version === anchor.version && content === anchor.snapshot) {
    return content.slice(anchor.start, anchor.end) === anchor.text ? { start: anchor.start, end: anchor.end } : null;
  }
  if (!anchor.text) return null;
  const candidates: number[] = [];
  let pos = -1;
  while ((pos = content.indexOf(anchor.text, pos + 1)) !== -1) {
    const prefix = content.slice(Math.max(0, pos - anchor.prefix.length), pos);
    const suffix = content.slice(pos + anchor.text.length, pos + anchor.text.length + anchor.suffix.length);
    if ((anchor.prefix || anchor.suffix) && prefix === anchor.prefix && suffix === anchor.suffix) candidates.push(pos);
  }
  return candidates.length === 1 ? { start: candidates[0], end: candidates[0] + anchor.text.length } : null;
}
