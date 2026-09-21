import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, Copy, Folder, FolderOpen, GitBranch, GripVertical, List, MoreHorizontal, Pencil, Pin, Plus, Settings2, Trash2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { createProject, deleteProject, markFolderRead, moveCanvas, registerCanvasFolder, removeCanvasFolder, renameProject, setCanvasArchived, updateCanvasFolder, useProjects } from '../store/projects';
import type { ProjectFolder, ProjectMeta } from '../store/projects';
import { confirmDialog, toast } from '../lib/ui-store';
import { fmt, useT } from '../i18n';
import { isImeComposing } from '../utils';

interface Props {
  relativeTime: (ts: number) => string;
  onSwitch: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
  onSwitched: () => void;
  busy?: boolean;
}

export default function CanvasProjectList({ relativeTime, onSwitch, onDuplicate, onSwitched, busy }: Props) {
  const t = useT();
  const { projects, folders, sections, activeId, switching } = useProjects();
  const disabled = switching || busy;
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ folderId: string | null; targetId?: string; after?: boolean } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sectionMenu, setSectionMenu] = useState(false);
  const [editor, setEditor] = useState<{ kind: 'canvas' | 'folder' | 'section'; id: string; value: string } | null>(null);
  const [working, setWorking] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const folder = folders.find((f) => f.id === menu?.id);
  const visible = projects.filter((p) => !!p.archived === showArchived);
  const archivedCount = projects.filter((p) => p.archived).length;
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error) => toast('error', error instanceof Error ? error.message : String(error)));
  };

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [menu]);

  const openMenu = (id: string, x: number, y: number) => {
    setSectionMenu(false);
    setMenu({ id, x: Math.max(8, Math.min(x, window.innerWidth - 256)), y: Math.max(8, Math.min(y, window.innerHeight - 370)) });
  };
  const acceptDrop = (event: DragEvent, folderId: string | null, targetId?: string) => {
    if (!dragged || disabled) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDrop({ folderId, targetId, after: targetId ? event.clientY > rect.y + rect.height / 2 : false });
    const scroller = event.currentTarget.closest('[data-project-list]');
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientY < bounds.top + 32) scroller.scrollTop -= 12;
      if (event.clientY > bounds.bottom - 32) scroller.scrollTop += 12;
    }
  };
  const finishDrop = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (dragged && drop) run(() => moveCanvas(dragged, drop.folderId, drop.targetId, drop.after));
    setDragged(null); setDrop(null);
  };
  const line = (id: string, after: boolean) => drop?.targetId === id && !!drop.after === after && dragged !== id
    ? <span className={`canvas-insert-line ${after ? 'bottom-0' : 'top-0'}`} /> : null;

  const renderCanvas = (p: ProjectMeta) => (
    <div key={p.id} data-canvas-id={p.id} role="listitem"
      draggable={!disabled && !editor} onDragStart={(event) => {
        event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', p.id); setDragged(p.id);
      }} onDragEnd={() => { setDragged(null); setDrop(null); }}
      onDragOver={(event) => acceptDrop(event, p.folderId ?? null, p.id)} onDrop={finishDrop}
      className={`canvas-project-row group relative ml-6 mr-1 flex items-center gap-1 rounded-md px-2 py-1.5 ${p.id === activeId ? 'bg-accent/10' : 'hover:bg-wash'} ${dragged === p.id ? 'ring-1 ring-accent bg-accent/10 opacity-60' : ''}`}
    >
      {line(p.id, false)}
      <GripVertical size={12} className="absolute -left-4 text-ink-faint opacity-0 group-hover:opacity-100 cursor-grab" aria-hidden="true" />
      <button disabled={disabled} className="min-w-0 flex-1 text-left disabled:opacity-60" onClick={() => run(() => onSwitch(p.id))}
        onKeyDown={(event) => {
          if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const siblings = visible.filter((item) => item.folderId === p.folderId);
          const index = siblings.findIndex((item) => item.id === p.id);
          const next = siblings[index + (event.key === 'ArrowUp' ? -1 : 1)];
          if (next) run(() => moveCanvas(p.id, p.folderId ?? null, next.id, event.key === 'ArrowDown'));
        }} title={`${p.name}\n${t('folders.dragHint')}`}>
        <span className={`block truncate text-[13px] leading-5 ${p.id === activeId ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
        <span className="block text-[11px] leading-4 text-ink-faint">{relativeTime(p.updatedAt)}</span>
      </button>
      {p.id !== activeId && p.updatedAt > (p.readAt ?? 0) && <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" title={t('folders.unread')} />}
      <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {showArchived ? <button className="canvas-row-action" disabled={disabled} title={t('folders.restore')} aria-label={t('folders.restore')} onClick={() => run(() => setCanvasArchived([p.id], false))}><ArchiveRestore size={13} /></button> : <>
          <button className="canvas-row-action" disabled={disabled} title={t('switcher.rename')} aria-label={t('switcher.rename')} onClick={() => setEditor({ kind: 'canvas', id: p.id, value: p.name })}><Pencil size={13} /></button>
          <button className="canvas-row-action" disabled={disabled} title={t('switcher.duplicate')} aria-label={t('switcher.duplicate')} onClick={() => run(() => onDuplicate(p.id))}><Copy size={13} /></button>
          <button className="canvas-row-action" disabled={disabled} title={t('folders.archiveCanvas')} aria-label={t('folders.archiveCanvas')} onClick={() => run(() => setCanvasArchived([p.id], true))}><Archive size={13} /></button>
        </>}
        <button className="canvas-row-action hover:!text-red-400" disabled={disabled} title={t('common.delete')} aria-label={t('common.delete')} onClick={() => run(async () => {
          if (await confirmDialog({ title: t('confirm.deleteCanvasTitle'), message: fmt(t('confirm.deleteCanvas'), { name: p.name }), confirmLabel: t('common.delete'), danger: true })) { await deleteProject(p.id); onSwitched(); }
        })}><Trash2 size={13} /></button>
      </div>
      {line(p.id, true)}
    </div>
  );
  const renderFolder = (f: ProjectFolder | null) => {
    const rows = visible.filter((p) => f ? p.folderId === f.id : !p.folderId || !folders.some((item) => item.id === p.folderId));
    if (!f && !rows.length) return null;
    const selected = !!f && projects.some((p) => p.id === activeId && p.folderId === f.id);
    return <div key={f?.id ?? 'unassigned'} data-folder-id={f?.id ?? 'unassigned'} className="mb-1">
      <div className={`group flex items-center rounded-md px-2 py-1.5 gap-2 text-[13px] ${selected ? 'bg-wash' : 'hover:bg-wash'} ${drop && !drop.targetId && drop.folderId === (f?.id ?? null) ? 'ring-1 ring-accent bg-accent/10' : ''}`}
        onContextMenu={(event) => { if (f) { event.preventDefault(); openMenu(f.id, event.clientX, event.clientY); } }}
        onDragOver={(event) => acceptDrop(event, f?.id ?? null)} onDrop={finishDrop}>
        <button className="flex items-center gap-2 min-w-0 flex-1 text-left text-ink-muted" title={f?.path} aria-expanded={!f?.collapsed} disabled={disabled}
          onClick={() => { if (f) run(() => updateCanvasFolder(f.id, { collapsed: !f.collapsed })); }}>
          {f?.collapsed ? <Folder size={16} className="shrink-0" /> : <FolderOpen size={16} className="shrink-0" />}
          <span className="truncate">{f?.name ?? t('folders.unassigned')}</span>
          {f?.pinned && <Pin size={11} className="shrink-0 text-ink-faint" />}
          <span className="text-[10px] text-ink-faint ml-auto">{rows.length}</span>
        </button>
        {f && <>
          <button className="canvas-row-action opacity-0 group-hover:opacity-100 focus:opacity-100" title={t('switcher.newCanvas')} aria-label={`${t('switcher.newCanvas')} · ${f.name}`} disabled={disabled} onClick={() => run(async () => { await updateCanvasFolder(f.id, { collapsed: false }); await createProject('Untitled', 'chat', f.id); onSwitched(); })}><Plus size={14} /></button>
          <button className="canvas-row-action opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`${t('folders.actions')} · ${f.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(f.id, rect.right, rect.top); }}><MoreHorizontal size={14} /></button>
          <ChevronDown size={12} className={`text-ink-faint shrink-0 transition-transform ${f.collapsed ? '-rotate-90' : ''}`} />
        </>}
      </div>
      {!f?.collapsed && <div role="list" aria-label={f?.name ?? t('folders.unassigned')}>{rows.map(renderCanvas)}{f && rows.length === 0 && <div className="ml-8 py-2 text-[11px] text-ink-faint" onDragOver={(event) => acceptDrop(event, f.id)} onDrop={finishDrop}>{t('folders.empty')}</div>}</div>}
    </div>;
  };
  const groups = [
    { name: t('folders.pinned'), folders: folders.filter((f) => f.pinned) },
    { name: t('folders.projects'), folders: folders.filter((f) => !f.pinned && !f.section) },
    ...sections.map((section) => ({ name: section, folders: folders.filter((f) => !f.pinned && f.section === section) })),
  ];
  const menuAction = (action: () => Promise<unknown>) => { setMenu(null); run(action); };
  return <>
    <div className="px-3 pt-1 pb-2 flex items-center text-[11px] text-ink-faint gap-2">
      <span>{showArchived ? t('folders.archived') : t('folders.projects')}</span>
      <span className="ml-auto text-[10px]">{t('folders.dragHint')}</span>
      {(archivedCount > 0 || showArchived) && <button className="hover:text-accent" onClick={() => setShowArchived(!showArchived)} title={showArchived ? t('folders.back') : t('folders.archived')} aria-label={showArchived ? t('folders.back') : t('folders.archived')}><Archive size={14} /></button>}
    </div>
    <div data-project-list className="max-h-[min(440px,55vh)] overflow-y-auto px-1.5 pb-1" onScroll={() => setMenu(null)}>
      {groups.filter((g) => g.folders.length).map((g) => <div key={g.name}>
        {(g.name !== t('folders.projects')) && <div className="px-2 pt-2 pb-1 text-[11px] text-ink-faint">{g.name}</div>}
        {g.folders.map(renderFolder)}
      </div>)}
      {renderFolder(null)}
      {showArchived && !archivedCount && <p className="p-3 text-[12px] text-ink-faint">{t('folders.noArchived')}</p>}
    </div>
    {folder && menu && createPortal(<div data-project-context-menu ref={menuRef} role="menu" className="fixed z-[200] w-[248px] max-h-[calc(100vh-16px)] overflow-y-auto rounded-xl border border-line bg-card p-1.5 shadow-2xl text-[13px] text-ink" style={{ left: menu.x, top: menu.y, maxHeight: `calc(100vh - ${menu.y + 8}px)` }}>
      <button role="menuitem" className="project-context-action" disabled={disabled} onClick={() => menuAction(() => updateCanvasFolder(folder.id, { pinned: !folder.pinned }))}><Pin size={16} />{folder.pinned ? t('folders.unpin') : t('folders.pin')}</button>
      <button role="menuitem" className="project-context-action" disabled={disabled} onClick={() => { setEditor({ kind: 'folder', id: folder.id, value: folder.name }); setMenu(null); }}><Settings2 size={16} />{t('folders.edit')}</button>
      <hr className="my-1 border-line" />
      <button role="menuitem" aria-haspopup="menu" aria-expanded={sectionMenu} className="project-context-action" disabled={disabled} onClick={() => setSectionMenu(!sectionMenu)}><List size={16} />{t('folders.section')}<ChevronRight size={14} className="ml-auto" /></button>
      {sectionMenu && <div role="menu" className="max-h-36 overflow-y-auto rounded-lg bg-wash ml-5 p-1">
        <button role="menuitem" className="project-context-action" onClick={() => menuAction(() => updateCanvasFolder(folder.id, { section: '' }))}>{t('folders.defaultSection')}{!folder.section && <Check size={13} />}</button>
        {sections.map((section) => <button role="menuitem" key={section} className="project-context-action" onClick={() => menuAction(() => updateCanvasFolder(folder.id, { section }))}><span className="truncate">{section}</span>{folder.section === section && <Check size={13} />}</button>)}
        <button role="menuitem" className="project-context-action" onClick={() => { setEditor({ kind: 'section', id: folder.id, value: '' }); setMenu(null); }}><Plus size={13} />{t('folders.newSection')}</button>
      </div>}
      <button role="menuitem" className="project-context-action" disabled={!window.desktop?.openProjectFolder || disabled} onClick={() => menuAction(() => window.desktop!.openProjectFolder!(folder.path))}><FolderOpen size={16} />{t('folders.openExplorer')}</button>
      <button role="menuitem" className="project-context-action" disabled={!window.desktop?.createProjectWorktree || disabled || working} onClick={() => menuAction(async () => {
        setWorking(true);
        try { const result = await window.desktop!.createProjectWorktree!(folder.path); if (result.project && !result.canceled) { await registerCanvasFolder(result.project); toast('success', t('folders.worktreeCreated')); } }
        finally { setWorking(false); }
      })}><GitBranch size={16} />{t('folders.worktree')}</button>
      <hr className="my-1 border-line" />
      <button role="menuitem" className="project-context-action" disabled={disabled} onClick={() => menuAction(() => markFolderRead(folder.id))}><Check size={16} />{t('folders.readAll')}</button>
      <button role="menuitem" className="project-context-action" disabled={disabled} onClick={() => menuAction(() => setCanvasArchived(projects.filter((p) => p.folderId === folder.id).map((p) => p.id), !showArchived))}><Archive size={16} />{showArchived ? t('folders.restoreAll') : t('folders.archiveAll')}</button>
      <hr className="my-1 border-line" />
      <button role="menuitem" className="project-context-action" disabled={disabled} onClick={() => menuAction(async () => {
        if (await confirmDialog({ title: t('folders.remove'), message: t('folders.removeConfirm'), confirmLabel: t('folders.remove'), danger: true })) await removeCanvasFolder(folder.id);
      })}><X size={16} />{t('folders.remove')}</button>
    </div>, document.body)}
    {editor && createPortal(<div data-folder-editor className="fixed inset-0 z-[210] bg-black/50 flex items-center justify-center" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}>
      <form role="dialog" aria-modal="true" aria-label={editor.kind === 'section' ? t('folders.newSection') : t('folders.edit')} className="w-[360px] max-w-[90vw] rounded-xl border border-line bg-card p-5 shadow-xl" onSubmit={(event) => {
        event.preventDefault(); if (!editor.value.trim()) return;
        const edit = editor; setEditor(null);
        run(() => edit.kind === 'canvas' ? renameProject(edit.id, edit.value.trim()) : updateCanvasFolder(edit.id, edit.kind === 'section' ? { section: edit.value.trim() } : { name: edit.value.trim() }));
      }}>
        <h2 className="text-sm text-ink mb-3">{editor.kind === 'section' ? t('folders.newSection') : t('folders.edit')}</h2>
        <input autoFocus aria-label={t('folders.name')} value={editor.value} maxLength={100} onChange={(event) => setEditor({ ...editor, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') setEditor(null); if (event.key === 'Enter' && isImeComposing(event)) event.preventDefault(); }} className="w-full border border-line bg-surface text-ink rounded-md px-3 py-2 text-[13px] outline-none focus:border-accent" />
        <div className="flex justify-end gap-2 mt-4 text-[13px]"><button type="button" className="px-3 py-1.5 text-ink-muted" onClick={() => setEditor(null)}>{t('common.cancel')}</button><button type="submit" disabled={!editor.value.trim()} className="px-3 py-1.5 rounded-md bg-accent text-white disabled:opacity-50">{t('folders.save')}</button></div>
      </form>
    </div>, document.body)}
  </>;
}
