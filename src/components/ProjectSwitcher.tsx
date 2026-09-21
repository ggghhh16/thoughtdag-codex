import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Dna, FolderCog, FolderOpen, Loader2, MessagesSquare, RefreshCw, Unlink, Upload } from 'lucide-react';
import { useProjects, switchProject, duplicateProject, registerCanvasFolder, moveCanvas } from '../store/projects';
import { useI18n } from '../i18n';
import { parseImportFile } from '../lib/export';
import ImportChatModal from './ImportChatModal';
import CodexThreadImportModal from './CodexThreadImportModal';
import type { ImportableConversation } from '../lib/import-chat';
import { codexThreadImportAvailable } from '../lib/codex-thread-import';
import { toast, useUiStore } from '../lib/ui-store';
import { commitDesktopProject, ensureDesktopProjectHydrated } from '../lib/desktop-project';
import CanvasProjectList from './CanvasProjectList';
import { useT, t as ti, fmt } from '../i18n';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return ti('switcher.justNow');
  if (min < 60) return fmt(ti('switcher.minAgo'), { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return fmt(ti('switcher.hourAgo'), { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return fmt(ti('switcher.dayAgo'), { n: d });
  return new Date(ts).toLocaleDateString(useI18n.getState().lang === 'zh' ? 'zh-CN' : 'en-US');
}

export default function ProjectSwitcher({ onSwitched }: { onSwitched: () => void }) {
  const t = useT();
  const projects = useProjects((s) => s.projects);
  const activeId = useProjects((s) => s.activeId);
  const switching = useProjects((s) => s.switching);
  const activeIsParadigm = projects.find((p) => p.id === activeId)?.kind === 'paradigm';
  const [open, setOpen] = useState(false);
  const [chatImport, setChatImport] = useState<ImportableConversation[] | null>(null);
  const [codexImportOpen, setCodexImportOpen] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const codexProjectFolder = useUiStore((s) => s.codexProjectFolder);
  const codexProjectHydrated = useUiStore((s) => s.codexProjectHydrated);

  const active = projects.find((p) => p.id === activeId);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if ((e.target as Element).closest('[data-project-context-menu], [data-folder-editor]')) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    let mounted = true;
    if (!window.desktop?.getProjectFolder) return;
    void ensureDesktopProjectHydrated()
      .catch((error) => {
        if (mounted) toast('error', fmt(ti('projectFolder.failed'), { msg: error instanceof Error ? error.message : String(error) }));
      });
    return () => { mounted = false; };
  }, []);

  const chooseProjectFolder = async () => {
    if (!window.desktop?.selectProjectFolder || folderBusy) return;
    setFolderBusy(true);
    try {
      const result = await window.desktop.selectProjectFolder({ activate: false });
      if (!result.canceled) {
        if (result.project) await registerCanvasFolder(result.project);
        if (result.project) toast('success', fmt(ti('projectFolder.selected'), { name: result.project.name }));
      }
    } catch (error) {
      toast('error', fmt(ti('projectFolder.failed'), { msg: error instanceof Error ? error.message : String(error) }));
    } finally {
      setFolderBusy(false);
    }
  };

  const clearProjectFolder = async () => {
    if (!window.desktop?.clearProjectFolder || folderBusy) return;
    setFolderBusy(true);
    try {
      if (activeId) await moveCanvas(activeId, null);
      else { await window.desktop.clearProjectFolder(); commitDesktopProject(null); }
      toast('success', ti('projectFolder.cleared'));
    } catch (error) {
      toast('error', fmt(ti('projectFolder.failed'), { msg: error instanceof Error ? error.message : String(error) }));
    } finally {
      setFolderBusy(false);
    }
  };

  const doSwitch = async (id: string) => {
    setOpen(false);
    await switchProject(id);
    onSwitched();
  };

  const doDuplicate = async (id: string) => {
    setOpen(false);
    try {
      const copiedId = await duplicateProject(id);
      if (copiedId) {
        onSwitched();
        toast('success', ti('switcher.copyCreated'));
      }
    } catch (error) {
      toast('error', fmt(ti('switcher.copyFailed'), { msg: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    // z-20: the open dropdown must cover the content palette below (both
    // live on the left edge; the palette is z-10)
    <div ref={rootRef} className="absolute top-4 left-4 z-20">
      <button
        onClick={() => setOpen(!open)}
        disabled={switching || folderBusy}
        className="bg-card/90 backdrop-blur border border-line rounded-xl px-3.5 py-2 shadow-sm hover:bg-wash transition-colors flex items-center gap-2 text-sm text-ink max-w-[300px] disabled:opacity-60"
      >
        {switching
          ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin shrink-0 text-accent" />
          : activeIsParadigm
            ? <Dna size={16} strokeWidth={1.75} className="shrink-0 text-accent" />
            : <FolderOpen size={16} strokeWidth={1.75} className="shrink-0 text-ink-muted" />}
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-medium">{active?.name ?? '…'}</span>
          {window.desktop?.selectProjectFolder && (
            <span className="block truncate text-2xs text-ink-faint font-normal mt-0.5" title={codexProjectFolder?.path}>
              {!codexProjectHydrated ? t('projectFolder.loading') : codexProjectFolder?.name ?? t('projectFolder.none')}
            </span>
          )}
        </span>
        <ChevronDown size={14} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
      </button>

      {open && (
        <div className="mt-1.5 bg-card border border-line rounded-xl shadow-lg py-1.5 w-[340px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-100px)] overflow-y-auto animate-fade-in">
          <CanvasProjectList relativeTime={relativeTime} onSwitch={doSwitch} onDuplicate={doDuplicate} onSwitched={onSwitched} busy={folderBusy} />

          <div className="border-t border-line mt-1 pt-1">
            {window.desktop?.selectProjectFolder && <button
              onClick={() => { void chooseProjectFolder(); }} disabled={folderBusy || switching}
              className="w-full text-left px-3 py-2 text-[13px] text-ink-muted hover:bg-wash transition-colors flex items-center gap-2 disabled:opacity-60"
            ><FolderCog size={15} strokeWidth={1.75} />{t('folders.addProject')}</button>}
            <button
              onClick={() => importFileRef.current?.click()}
              className="w-full text-left px-3 py-2 text-sm text-ink-muted hover:bg-wash transition-colors flex items-center gap-2"
            >
              <Upload size={15} strokeWidth={1.75} /> {t('switcher.importBackup')}
            </button>
            {codexThreadImportAvailable() && (
              <button
                onClick={() => { setOpen(false); setCodexImportOpen(true); }}
                className="w-full text-left px-3 py-2 text-sm text-ink-muted hover:bg-wash transition-colors flex items-center gap-2"
                data-import-codex-thread
              >
                <MessagesSquare size={15} strokeWidth={1.75} /> {t('codexImport.menuEntry')}
              </button>
            )}
            {window.desktop?.selectProjectFolder && (
              <div className="border-t border-line mt-1 pt-1" data-project-folder-section>
                {codexProjectFolder && (
                  <button
                    onClick={() => { setOpen(false); void clearProjectFolder(); }}
                    disabled={folderBusy}
                    className="w-full text-left px-3 py-2 text-sm text-ink-muted hover:bg-wash transition-colors flex items-center gap-2 disabled:opacity-60"
                  >
                    <Unlink size={15} strokeWidth={1.75} /> {t('projectFolder.clear')}
                  </button>
                )}
              </div>
            )}
            {window.desktop && (
              <button
                onClick={() => { setOpen(false); void window.desktop!.checkForUpdates(); }}
                className="w-full text-left px-3 py-2 text-sm text-ink-muted hover:bg-wash transition-colors flex items-center gap-2"
                data-check-updates
              >
                <RefreshCw size={15} strokeWidth={1.75} /> {t('update.checkMenu')}
                {/* the one place that answers "which version am I on" at a glance */}
                <span className="ml-auto text-2xs text-ink-faint">
                  v{new URLSearchParams(window.location.search).get('dv')}
                </span>
              </button>
            )}
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  // Every failure path must surface — a silently swallowed
                  // rejection here reads as "the import does nothing".
                  void parseImportFile(f).then((r) => {
                    if (r.kind === 'own' && r.ok) { setOpen(false); onSwitched(); }
                    else if (r.kind === 'chat') { setOpen(false); setChatImport(r.conversations); }
                  }).catch((err) => {
                    toast('error', fmt(ti('toast.importFailedGeneric'), { msg: err instanceof Error ? err.message : String(err) }));
                  });
                }
                e.target.value = '';
              }}
            />
          </div>
        </div>
      )}
      {chatImport && (
        <ImportChatModal
          conversations={chatImport}
          onClose={() => setChatImport(null)}
          onDone={() => { setChatImport(null); onSwitched(); }}
        />
      )}
      {codexImportOpen && (
        <CodexThreadImportModal
          onClose={() => setCodexImportOpen(false)}
          onDone={() => { setCodexImportOpen(false); onSwitched(); }}
        />
      )}
    </div>
  );
}
