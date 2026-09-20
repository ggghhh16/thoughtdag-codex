import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Check, Copy } from 'lucide-react';
import { rehypeMarks, type MarkOptions, type ExploreMarkSpec } from '../lib/rehype-marks';
import { useT } from '../i18n';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/ui-store';

const REMARK_PLUGINS = [remarkGfm, remarkMath];

// Models freely emit \( \) and \[ \] math delimiters; remark-math only
// parses $-style. Normalize outside code fences/spans so formulas render
// everywhere (cards, panel, rail, reader) instead of leaking raw.
function normalizeMath(src: string): string {
  if (!src || (!src.includes('\\(') && !src.includes('\\['))) return src;
  const parts = src.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((seg, i) => (i % 2 === 1 ? seg : seg
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
      .replace(/\\\((.+?)\\\)/g, (_, m) => `$${m.trim()}$`)))
    .join('');
}
const REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize, rehypeHighlight, rehypeKatex];

// Code blocks get a hover copy button (no toast: too frequent an action —
// the icon flashes a check instead).
function Pre(props: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copying = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const t = useT();
  return (
    <div className="relative group/pre">
      <pre {...props} ref={ref} />
      <button
        type="button"
        onClick={async (e) => {
          e.stopPropagation();
          if (copying.current || !ref.current) return;
          copying.current = true;
          clearTimeout(resetTimer.current);
          setCopied(false);
          try {
            await copyText(ref.current.textContent ?? '');
            setCopied(true);
            resetTimer.current = setTimeout(() => setCopied(false), 1600);
          } catch {
            toast('error', t('common.copyCodeFailed'));
          } finally {
            copying.current = false;
          }
        }}
        title={t('common.copyCode')}
        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md bg-card/90 border border-line text-ink-faint hover:text-accent flex items-center justify-center opacity-0 group-hover/pre:opacity-100 transition-opacity nodrag nopan"
      >
        {copied ? <Check size={12} strokeWidth={2} className="text-green-600" /> : <Copy size={12} strokeWidth={1.75} />}
      </button>
    </div>
  );
}

// Wide tables scroll inside their own container instead of blowing the card
function Table(props: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table {...props} />
    </div>
  );
}

const COMPONENTS = { pre: Pre, table: Table };

// Standard markdown rendering (GFM + math + syntax highlighting).
// memo: the unified parse + KaTeX layout is the most expensive render on a
// card, and cards re-render far more often than their text changes (every
// streamed chunk anywhere re-renders every card). Same string → skip.
export const Markdown = memo(function Markdown({ children, marks }: { children: string; marks?: MarkOptions }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={marks ? [...REHYPE_PLUGINS, [rehypeMarks, marks]] : REHYPE_PLUGINS} components={COMPONENTS}>
      {normalizeMath(children)}
    </ReactMarkdown>
  );
});

export type { ExploreMarkSpec };

// Add annotation elements after Markdown and syntax highlighting are parsed.
// Compare by content because callers rebuild the Set/array on each render.
export const HighlightedMarkdown = memo(function HighlightedMarkdown({ content, highlights, exploreMarks }: { content: string; highlights: Set<string>; exploreMarks?: ExploreMarkSpec[] }) {
  return <Markdown marks={{ highlights, exploreMarks }}>{content}</Markdown>;
}, areMarkPropsEqual);
type HMProps = { content: string; highlights: Set<string>; exploreMarks?: ExploreMarkSpec[] };
function areMarkPropsEqual(prev: HMProps, next: HMProps): boolean {
  if (prev.content !== next.content) return false;
  if (prev.highlights.size !== next.highlights.size) return false;
  for (const h of prev.highlights) if (!next.highlights.has(h)) return false;
  const a = prev.exploreMarks ?? [];
  const b = next.exploreMarks ?? [];
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.text === b[i].text && m.nodeId === b[i].nodeId && m.title === b[i].title);
}

