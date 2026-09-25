import { useI18n } from '../i18n';
import { readerText as rt, useReaderT } from '../i18n/reader';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import { Markdown } from './Markdown';
import { TextbookOutline } from './TextbookOutline';
import { createAnchor, createCitation, resolveAnchor } from '../lib/textbook';
import type { ReaderCommand, ReaderSnapshot, SourceAnchor } from '../lib/textbook';
import { sourceSelection } from '../lib/rehype-source';
import '../index.css';
import './textbook.css';

function relativeTarget(base: string, href: string) {
  const url = new URL(href, `https://textbook.invalid/${base}`);
  return { path: decodeURIComponent(url.pathname.slice(1)), hash: decodeURIComponent(url.hash.slice(1)) };
}
function LocalImage({ src, alt, libraryId, file }: { src?: string; alt?: string; libraryId: string; file: string }) {
  useReaderT();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let dead = false;
    if (!src) return;
    if (/^[a-z]+:/i.test(src)) return;
    void window.desktop?.textbookFiles?.({ action: 'image', libraryId, relativePath: relativeTarget(file, src).path }).then(value => { if (!dead) setUrl(String(value)); }).catch(e => { if (!dead) setError(String(e)); });
    return () => { dead = true; };
  }, [src, libraryId, file]);
  const displayUrl = src && /^https?:\/\//i.test(src) ? src : url;
  return displayUrl ? <img src={displayUrl} alt={alt ?? ''} onError={() => setError('图片加载失败')} /> : <span role="img" aria-label={alt}>{alt} {rt(error) || rt('图片加载中…')}</span>;
}
const editorText = (text: string) => text.replace(/\r\n/g, '\n');
function editorSourceOffset(source: string, offset: number) {
  let visible = 0, raw = 0;
  while (raw < source.length && visible < offset) { if (source[raw] === '\r' && source[raw + 1] === '\n') raw++; raw++; visible++; }
  return raw;
}
const empty: ReaderSnapshot = { projectId: '', documents: [], questions: [] };

export default function TextbookReader() {
  useReaderT();
  const lang = useI18n(s => s.lang);
  useEffect(() => { document.title = rt('Markdown 阅读'); document.documentElement.lang = lang; }, [lang]);
  const [snapshot, setSnapshot] = useState<ReaderSnapshot>(empty);
  const [materialId, setMaterialId] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [docked, setDocked] = useState(true);
  const [selection, setSelection] = useState<SourceAnchor | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [popup, setPopup] = useState<{ x: number; y: number; mode: 'compose' | 'menu' | 'choose'; ids: string[]; nodeId?: string } | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftVersion, setDraftVersion] = useState('');
  const [old, setOld] = useState<SourceAnchor | null>(null);
  const [jump, setJump] = useState<{ nodeId?: string; hash?: string } | null>(null);
  const [flash, setFlash] = useState<{start: number; end: number} | null>(null);
  const [fontSize, setFontSize] = useState(16);
  const restoring = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ snapshot, materialId, edit, draft, draftVersion });
  stateRef.current = { snapshot, materialId, edit, draft, draftVersion };
  const current = snapshot.documents.find(d => d.nodeId === materialId);
  const doc = current?.document;
  const citation = useMemo(() => selection ? createCitation(materialId, selection, 'nearby') : null, [materialId, selection]);
  const questions = useMemo(() => snapshot.questions.filter(q => q.citation.materialId === materialId && !q.hidden), [snapshot.questions, materialId]);
  const source = old?.snapshot ?? doc?.content ?? '';
  const ranges = useMemo(() => {
    if (!doc || old) return [];
    const selectedRange = popup?.mode === 'compose' && selection ? resolveAnchor(selection, doc.content, doc.version) : null;
    return [
      ...(selectedRange ? [{ ...selectedRange, id: '__selection__', question: false }] : []),
      ...(flash ? [{ ...flash, id: '__flash__', question: false }] : []),
      ...questions.flatMap(q => { const pos = resolveAnchor(q.relocation ?? q.citation.anchor, doc.content, doc.version); return pos ? [{ ...pos, id: q.id, question: true, number: q.number }] : []; }),
      ...doc.marks.filter(m => !m.hidden).flatMap(m => { const pos = resolveAnchor(m.anchor, doc.content, doc.version); return pos ? [{ ...pos, id: m.id, question: false, number: m.number }] : []; }),
    ];
  }, [doc, questions, old, flash, popup?.mode, selection]);
  const request = useCallback(async (command: Omit<ReaderCommand, 'id' | 'projectId'>) => {
    const reply = await window.desktop!.textbookCommand!({ ...command, id: crypto.randomUUID(), projectId: stateRef.current.snapshot.projectId });
    if (reply.error) throw new Error(reply.error);
    if (reply.snapshot) setSnapshot(reply.snapshot);
    return reply;
  }, []);
  const attempt = useCallback(async (work: () => Promise<unknown>) => {
    setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const hasDraft = () => {
    const s = stateRef.current;
    return s.edit && editorText(s.draft) !== editorText(s.snapshot.documents.find(d => d.nodeId === s.materialId)?.document.content ?? '');
  };
  const openFile = useCallback(async (lib: string, relativePath: string) => {
    if (hasDraft()) throw new Error('有未保存的源码，请先保存或复制草稿后退出编辑。');
    const reply = await request({ action: 'open', libraryId: lib, relativePath });
    setMaterialId(reply.materialId!); setLibraryId(lib); setFilesOpen(false); setOld(null); setSelection(null); setPopup(null); setEdit(false);
  }, [request]);

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
    const receive = (value: unknown) => {
      if (!value) return;
      const incoming = value as ReaderSnapshot;
      const previous = stateRef.current.snapshot;
      if (previous.projectId && previous.projectId !== incoming.projectId) {
        if (hasDraft()) { localStorage.setItem(`textbook-draft:${stateRef.current.materialId}`, stateRef.current.draft); setNotice('已切换画布；未保存源码已暂存，可在原资料的编辑模式中恢复。'); }
        setMaterialId(''); setPopup(null); setSelection(null); setEdit(false); setOld(null); setLibraryId(''); setFiles([]);
      }
      setSnapshot(incoming);
    };
    const off = window.desktop!.onTextbookEvent!('snapshot', receive);
    const reveal = window.desktop!.onTextbookEvent!('reveal', value => {
      const target = value as { materialId: string; nodeId?: string };
      if (hasDraft()) { setError('请先保存或复制源码草稿，再返回原文。'); return; }
      setPopup(null); setMaterialId(target.materialId); setOld(null); setEdit(false); setSelection(null); setJump({ nodeId: target.nodeId });
    });
    void request({ action: 'snapshot' }).catch(e => setError(String(e)));
    return () => { off(); reveal(); };
  }, [request]);
  useEffect(() => {
    if (materialId || !snapshot.documents.length) return;
    const latest = [...snapshot.documents].sort((a, b) => (b.document.lastReadAt ?? 0) - (a.document.lastReadAt ?? 0))[0];
    setMaterialId(latest.nodeId);
  }, [materialId, snapshot.documents]);
  useEffect(() => {
    if (!doc) return;
    setLibraryId(doc.libraryId);
    void window.desktop!.textbookFiles!({ action: 'list', libraryId: doc.libraryId }).then(value => setFiles(value as string[])).catch(e => setError(`找不到原文件，正在显示保存的原文。${String(e)}`));
  }, [doc?.libraryId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const viewport = scroller.current, content = body.current;
    if (!viewport || !content || edit) return;
    const top = old ? 0 : doc?.scrollTop ?? 0;
    restoring.current = true;
    // Fonts and local images finish after React mounts. Keep the saved offset
    // through those layout changes, until the reader deliberately interacts.
    const restore = () => { if (restoring.current) viewport.scrollTop = top; };
    restore();
    const observer = new ResizeObserver(restore); observer.observe(content);
    content.addEventListener('load', restore, true);
    void document.fonts.ready.then(restore);
    return () => { observer.disconnect(); content.removeEventListener('load', restore, true); restoring.current = false; };
  }, [materialId, edit, old?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!doc || !jump || !body.current) return;
    restoring.current = false;
    const q = snapshot.questions.find(q => q.id === jump.nodeId);
    if (q) {
      const pos = resolveAnchor(q.relocation ?? q.citation.anchor, doc.content, doc.version);
      if (!pos) { setError('原文已变化，无法唯一确定原选区。可查看旧版本，或框选新位置后手动重新关联。'); setFilesOpen(true); }
      else {
        const el = [...body.current.querySelectorAll<HTMLElement>('[data-md-start]')].find(el => Number(el.dataset.mdEnd) > pos.start && Number(el.dataset.mdStart) < pos.end);
        el?.scrollIntoView({ block: 'center' }); setFlash(pos); setTimeout(() => setFlash(null), 2200);

      }
    } else if (jump.hash) {
      const key = jump.hash.toLowerCase().replace(/\s+/g, '-');
      const heading = [...body.current.querySelectorAll('h1,h2,h3,h4,h5,h6,[id]')].find(el => el.id === jump.hash || el.textContent?.toLowerCase().replace(/\s+/g, '-') === key);
      heading?.scrollIntoView({ block: 'start' });
    }
    setJump(null);
  }, [jump, doc, snapshot.questions]);
  // Check disk on focus. Unsaved editor drafts stay intact, with an explicit conflict.
  useEffect(() => {
    const check = () => {
      const s = stateRef.current, d = s.snapshot.documents.find(d => d.nodeId === s.materialId)?.document;
      if (!d) return;
      void window.desktop!.textbookFiles!({ action: 'read', libraryId: d.libraryId, relativePath: d.relativePath }).then(async value => {
        const disk = value as { version: string };
        if (disk.version !== d.version) {
          if (s.edit) setError('文件已被外部修改。草稿已保留，请复制草稿，重新读取后合并。');
          else await request({ action: 'open', libraryId: d.libraryId, relativePath: d.relativePath });
        }
      }).catch(() => setError('找不到原文件，正在显示保存的原文。可重新选择文件位置。'));
    };
    window.addEventListener('focus', check); check();
    return () => window.removeEventListener('focus', check);
  }, [materialId, request]);
  useEffect(() => {
    const saveDraft = () => { const s = stateRef.current; if (hasDraft()) localStorage.setItem(`textbook-draft:${s.materialId}`, s.draft); };
    window.addEventListener('beforeunload', saveDraft);
    return () => window.removeEventListener('beforeunload', saveDraft);
  }, []);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('.textbook-popover')) setPopup(null);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPopup(null); window.getSelection()?.removeAllRanges(); } };
    const resize = () => setPopup(null);
    window.addEventListener('resize', resize);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', resize); document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, []);
  const popupPosition = (x: number, y: number) => ({ x: Math.max(10, Math.min(x, window.innerWidth - Math.min(460, window.innerWidth - 20) - 10)), y: Math.max(10, Math.min(y, window.innerHeight - 210)) });
  const imageLibraryId = doc?.libraryId ?? '', documentPath = doc?.relativePath ?? '';
  const components = useMemo<Components>(() => ({
    img: ({ src, alt }) => <LocalImage src={typeof src === 'string' ? src : undefined} alt={alt} libraryId={imageLibraryId} file={documentPath} />,
    a: ({ href, children }) => <a href={href} onClick={e => {
      if (!href || /^https?:/i.test(href)) return;
      e.preventDefault();
      if (!documentPath || /^[a-z]+:/i.test(href)) return;
      const target = relativeTarget(documentPath, href);
      void attempt(async () => {
        if (target.path !== documentPath) await openFile(imageLibraryId, target.path);
        setJump({ hash: target.hash });
      });
    }}>{children}</a>,
  }), [imageLibraryId, documentPath, openFile, attempt]);
  async function selectFolder(replace = false) {
    const result = await window.desktop!.textbookFiles!({ action: 'select', lang: useI18n.getState().lang, ...(replace && doc ? { replaceId: doc.libraryId } : {}) }) as { id: string } | null;
    if (!result) return;
    const listed = await window.desktop!.textbookFiles!({ action: 'list', libraryId: result.id }) as string[];
    setLibraryId(result.id); setFiles(listed);
    if (replace && doc) await openFile(result.id, doc.relativePath);
    else if (listed[0]) await openFile(result.id, listed[0]);
  }
  const capture = () => {
    if (!doc || old || edit) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed) return;
    const position = sourceSelection(body.current!, selected);
    if (position) {
      const rect = selected.getRangeAt(0).getBoundingClientRect();
      setSelection(createAnchor(doc, position.start, position.end)); setQuestion('');
      setPopup({ ...popupPosition(rect.left, rect.top > 95 ? rect.top - 80 : rect.bottom + 10), mode: 'compose', ids: [] });
    } else setError('无法确定这个选区的源码范围，请框选正文文字或在源码模式中选取。');
  };
  async function ask() {
    if (!selection || busy || !popup) return;
    setBusy(true);
    try {
      if (popup.nodeId) await request({ action: 'resend', materialId, nodeId: popup.nodeId, question: question.trim() || rt('请解释这段内容。') });
      else await request({ action: 'ask', materialId, question: question.trim() || rt('请解释这段内容。'), anchor: selection, scope: 'nearby' });
      setQuestion(''); setPopup(null); setSelection(null); window.getSelection()?.removeAllRanges();
    } finally { setBusy(false); }
  }
  const markClick = (event: React.MouseEvent<HTMLElement>, context: boolean) => {
    const mark = (event.target as HTMLElement).closest<HTMLElement>('[data-mark-ids]');
    if (!mark || old) return;
    if (!context && !window.getSelection()?.isCollapsed) return;
    const ids = (mark.dataset.markIds ?? '').split(' ').filter(id => questions.some(q => q.id === id) || doc?.marks.some(m => m.id === id && !m.hidden));
    if (!ids.length) return;
    event.preventDefault(); event.stopPropagation();
    if (!context && ids.length === 1 && questions.some(q => q.id === ids[0])) {
      setPopup(null); void attempt(() => request({ action: 'locate', nodeId: ids[0] }));
    } else setPopup({ ...popupPosition(event.clientX, event.clientY + 10), mode: context ? 'menu' : 'choose', ids });
  };
  return <main className="textbook-reader">
    <header>
      <strong>{rt('Markdown 阅读')}</strong>
      <details className="textbook-view-settings">
        <summary>{rt('窗口与字号')}</summary>
        <div>
      <button onClick={() => void attempt(async () => setDocked(await window.desktop!.textbookDock!(!docked)))}>{docked ? rt('解除贴靠') : rt('恢复贴靠')}</button>
      <button title={rt('减少字号')} onClick={() => setFontSize(v => Math.max(12, v - 1))}>A−</button>
      <button title={rt('增加字号')} onClick={() => setFontSize(v => Math.min(26, v + 1))}>A+</button>
        </div>
      </details>
    </header>
    <details className="textbook-files" open={filesOpen || !doc} onToggle={e => setFilesOpen(e.currentTarget.open)}>
      <summary>{rt('文件与标记')}<span>{doc?.relativePath ?? rt('选择文章文件夹')}</span></summary>
      <div className="textbook-actions"><button onClick={() => void attempt(() => selectFolder())}>{rt('打开文件夹')}</button></div>
    <nav>
      <select aria-label={rt('已保存文章章节')} value={materialId} onChange={e => { if (hasDraft()) { setError('请先保存或复制源码草稿。'); return; } const id = e.target.value; void attempt(async () => { await request({ action: 'snapshot' }); setPopup(null); setFilesOpen(false); setMaterialId(id); setOld(null); setSelection(null); setEdit(false); }); }}>
        <option value="">{rt('已保存章节')}</option>{snapshot.documents.map(d => <option key={d.nodeId} value={d.nodeId}>{d.document.title} · {d.document.relativePath}</option>)}
      </select>
      <select aria-label={rt('文章 Markdown 文件')} value={files.includes(doc?.relativePath ?? '') ? doc!.relativePath : ''} onChange={e => void attempt(() => openFile(libraryId, e.target.value))}>
        <option value="">{rt('浏览文件夹…')}</option>{files.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
    </nav>
    {doc && <>
      <div className="textbook-actions">
        <span title={doc.version}>{doc.relativePath} · {doc.version.slice(0, 8)}</span>
        <button onClick={() => {
          if (edit) { if (editorText(draft) !== editorText(doc.content)) { setError('源码尚未保存；请保存，或点击“保留草稿并重新读取”。'); return; } setEdit(false); }
          else { setDraft(editorText(localStorage.getItem(`textbook-draft:${materialId}`) ?? doc.content)); setDraftVersion(doc.version); setPopup(null); setEdit(true); setOld(null); }
        }}>{edit ? rt('阅读模式') : rt('源码编辑')}</button>
        <button onClick={() => void attempt(() => selectFolder(true))}>{rt('重新选择文件位置')}</button>
        <button onClick={() => void attempt(() => openFile(doc.libraryId, doc.relativePath))}>{rt('刷新原文件')}</button>
      </div>
      <details className="textbook-marks">
        <summary>{rt('标记管理')} · {questions.length} {rt('个问题')}</summary>
        {questions.map(q => {
          const valid = !!resolveAnchor(q.relocation ?? q.citation.anchor, doc.content, doc.version);
          return <div key={q.id}>
            <button onClick={() => void attempt(() => request({ action: 'locate', nodeId: q.id }))}>#{q.number} {q.question}{q.failed ? rt(' · 可在主窗口重试') : ''}</button>
            {!valid && <span>{rt('原文已变化')}</span>}
            <button onClick={() => { setOld(q.citation.anchor); setEdit(false); }}>{rt('提问时原文')}</button>
            <button onClick={() => { setOld(null); setJump({ nodeId: q.id }); }}>{rt('定位')}</button>
            <button disabled={!selection} onClick={() => void attempt(() => request({ action: 'reanchor', materialId, nodeId: q.id, anchor: selection! }))}>{rt('关联到当前选区')}</button>
          </div>;
        })}
        {doc.marks.filter(m => !m.hidden && !resolveAnchor(m.anchor, doc.content, doc.version)).map(m => <div key={m.id}>{rt('阅读高亮：原文已变化')}<button onClick={() => setOld(m.anchor)}>{rt('查看旧版本')}</button></div>)}
      </details>
    </>}
    </details>
    {error && <div className="textbook-error" role="alert">{rt(error)}<button onClick={() => setError('')}>{rt('关闭提示')}</button></div>}
    {notice && <div className="textbook-notice" role="status">{rt(notice)}</div>}
    {doc ? <>
      {old && <div className="textbook-notice">{rt('提问时原文快照')} · {old.version.slice(0, 8)}<button onClick={() => setOld(null)}>{rt('返回当前文件')}</button></div>}
      {edit ? <>
        <textarea className="textbook-editor" aria-label={rt('Markdown 源码')} value={draft} onChange={e => { setPopup(null); setDraft(e.target.value); localStorage.setItem(`textbook-draft:${materialId}`, e.target.value); }} onSelect={e => {
          if (editorText(draft) !== editorText(doc.content)) return;
          const el = e.currentTarget;
          if (el.selectionEnd > el.selectionStart) {
            setSelection(createAnchor(doc, editorSourceOffset(doc.content, el.selectionStart), editorSourceOffset(doc.content, el.selectionEnd)));
            setQuestion(''); setPopup({ ...popupPosition(24, el.getBoundingClientRect().top + 16), mode: 'compose', ids: [] });
          }
        }} />
        <div className="textbook-actions">
          <button onClick={() => void attempt(async () => {
            await window.desktop!.textbookFiles!({ action: 'save', libraryId: doc.libraryId, relativePath: doc.relativePath, version: draftVersion, content: doc.content.includes('\r\n') && !/(?<!\r)\n/.test(doc.content) ? editorText(draft).replace(/\n/g, '\r\n') : draft });
            localStorage.removeItem(`textbook-draft:${materialId}`);
            await request({ action: 'open', libraryId: doc.libraryId, relativePath: doc.relativePath });
            setEdit(false); setSelection(null); setNotice('已保存到当前本地 Markdown 文件，并检查已有标记。');
          })}>{rt('保存到原文件')}</button>
          <button onClick={() => void attempt(async () => {
            localStorage.setItem(`textbook-draft:${materialId}`, draft);
            await request({ action: 'open', libraryId: doc.libraryId, relativePath: doc.relativePath });
            setEdit(false); setNotice('已重新读取文件；草稿保留，下次进入编辑可恢复。');
          })}>{rt('保留草稿并重新读取')}</button>
        </div>
      </> : <div className="textbook-reading-area">
        <TextbookOutline key={`${materialId}:${old?.version ?? 'current'}`} source={source} body={body} scroller={scroller} onNavigate={() => { restoring.current = false; setPopup(null); }} />
        <div ref={scroller} className="textbook-scroll" onWheelCapture={() => { restoring.current = false; setPopup(null); }} onPointerDownCapture={() => { restoring.current = false; }} onKeyDownCapture={() => { restoring.current = false; setPopup(null); }} onScroll={e => {
        if (old || restoring.current) return;
        void request({ action: 'position', materialId, scrollTop: e.currentTarget.scrollTop }).catch(() => {});
      }}>
        <article ref={body} className="markdown-body textbook-body" style={{ fontSize }} onMouseUp={capture} onKeyUp={capture} onClick={e => markClick(e, false)} onContextMenu={e => markClick(e, true)}><Markdown sourceMode={{ source, ranges }} components={components}>{source}</Markdown></article>
      </div></div>}
    </> : <div className="textbook-empty">{rt('打开本地文件夹，选择 Markdown 章节开始阅读。资料无需模型生成，问题会出现在主窗口画布。')}</div>}
    {popup && doc && <div className={`textbook-popover textbook-popover-${popup.mode}`} style={{ left: popup.x, top: popup.y, maxHeight: window.innerHeight - popup.y - 10 }} role="dialog" aria-label={popup.mode === 'compose' ? rt('选区评论') : rt('标记操作')}>
      {popup.mode === 'compose' ? <>
        <form onSubmit={e => { e.preventDefault(); void attempt(ask); }}>
          <textarea autoFocus={!edit} aria-label={rt('添加可选评论')} placeholder={rt('添加可选评论…')} value={question} rows={1} onChange={e => setQuestion(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void attempt(ask); }
          }} />
          <button type="submit" className="textbook-send" aria-label={popup.nodeId ? rt('重新发送') : rt('发送')} title={rt('发送；不填评论时解释选区')} disabled={busy || !selection || (edit && editorText(draft) !== editorText(doc.content))}>
            {busy ? '…' : <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}
          </button>
        </form>
        {citation && citation.content.length > 16000 && <p className="textbook-long-reference">{rt('引用较长：')}{citation.content.length.toLocaleString()} {rt(' 字符，将完整发送选区及附近内容。')}</p>}
      </> : popup.ids.map(id => {
        const q = questions.find(q => q.id === id), mark = doc.marks.find(m => m.id === id && !m.hidden);
        if (!q && !mark) return null;
        return <div className="textbook-mark-menu" key={id}>
          <button className="textbook-mark-title" disabled={!q} onClick={() => void attempt(async () => { await request({ action: 'locate', nodeId: id }); setPopup(null); })}><span>#{q?.number ?? mark?.number}</span> {q?.question ?? rt('阅读高亮')}</button>
          {popup.mode === 'menu' && <div className="textbook-mark-commands">
            <button onClick={() => { setSelection(q?.citation.anchor ?? mark!.anchor); setQuestion(q?.question ?? ''); setPopup({ ...popup, mode: 'compose', nodeId: q?.id }); }}>{q ? rt('编辑问题并重发') : rt('添加问题')}</button>
            <button className="textbook-delete" title={rt('只删除文章标记，保留画布问题和历史回答')} onClick={() => void attempt(async () => { await request({ action: 'delete-mark', materialId, nodeId: id }); setPopup(null); })}>{rt('删除当前标记')}</button>
          </div>}
        </div>;
      })}
    </div>}
  </main>;
}
