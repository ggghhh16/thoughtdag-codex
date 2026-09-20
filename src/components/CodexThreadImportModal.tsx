import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder, Import, Loader2, MessagesSquare, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { importChatConversations } from '../lib/export';
import {
  asImportableCodexConversation,
  codexThreadTitle,
  getCodexThread,
  listCodexThreads,
  type CodexThreadSummary,
} from '../lib/codex-thread-import';
import { useProjects } from '../store/projects';
import { fmt, useDateLocale, useT } from '../i18n';

type LoadPhase = 'list' | 'more' | null;

function readableDate(value: string | undefined, locale: string): string {
  if (!value) return '';
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
    : value;
}

/** Browse the local Codex task store and turn one selected task into an
 *  independent ThoughtDAG canvas. The server only supplies transcript data;
 *  project persistence still goes through the existing chat-import path. */
export default function CodexThreadImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const locale = useDateLocale();
  const projects = useProjects((state) => state.projects);
  const switching = useProjects((state) => state.switching);
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [draftSearch, setDraftSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [viewArchived, setViewArchived] = useState(false);
  const [activeArchived, setActiveArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [phase, setPhase] = useState<LoadPhase>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);

  const importedProjects = useMemo(() => {
    const out = new Map<string, { id: string; name: string }>();
    for (const project of projects) {
      if (project.importedCodexThreadId) out.set(project.importedCodexThreadId, project);
    }
    return out;
  }, [projects]);
  const selected = threads.find((thread) => thread.id === selectedId);
  const selectedExisting = selectedId ? importedProjects.get(selectedId) : undefined;

  const load = useCallback(async (options: { search: string; archived: boolean; cursor?: string; append?: boolean }) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const request = ++requestNumber.current;
    setPhase(options.append ? 'more' : 'list');
    setError('');
    if (!options.append) {
      // A cursor belongs to exactly one (search, archived) query. Clear the
      // old result set before crossing that boundary, including failure paths.
      setThreads([]);
      setSelectedId(null);
      setNextCursor(undefined);
    }
    try {
      const page = await listCodexThreads({
        search: options.search,
        archived: options.archived,
        cursor: options.cursor,
        limit: 30,
        signal: controller.signal,
      });
      if (request !== requestNumber.current) return;
      setThreads((current) => {
        if (!options.append) return page.threads;
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...page.threads.filter((item) => !ids.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      if (!options.append) {
        // Commit the query only after its page succeeds. Pagination therefore
        // can never combine a failed new filter with an older result cursor.
        setActiveSearch(options.search);
        setActiveArchived(options.archived);
      }
    } catch (cause) {
      if (controller.signal.aborted || request !== requestNumber.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestNumber.current) setPhase(null);
    }
  }, []);

  useEffect(() => {
    void load({ search: '', archived: false });
    return () => requestRef.current?.abort();
  }, [load]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !importing) onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [importing, onClose]);

  const submitSearch = () => {
    const search = draftSearch.trim();
    void load({ search, archived: viewArchived });
  };

  const switchArchiveFilter = (archived: boolean) => {
    if (archived === viewArchived && phase === null) return;
    setViewArchived(archived);
    void load({ search: draftSearch.trim(), archived });
  };

  const importSelected = async () => {
    if (!selected || importing || switching) return;
    setImporting(true);
    setError('');
    try {
      if (selectedExisting) {
        await importChatConversations([{
          title: selectedExisting.name,
          messageCount: 0,
          source: 'codex',
          codexThreadId: selected.id,
          build: () => ({ nodes: [], edges: [] }),
        }]);
        onDone();
        return;
      }
      const detail = await getCodexThread(selected.id);
      if (detail.turns.length === 0) {
        setError(t('codexImport.noTurns'));
        return;
      }
      await importChatConversations([asImportableCodexConversation({
        ...detail,
        // Archive state belongs to the selected list view rather than the
        // detail DTO. Archived imports are display-only snapshots and must
        // never silently resume (and thereby unarchive) the official task.
        archived: viewArchived,
      })]);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] bg-ink/30 backdrop-blur-sm flex items-center justify-center p-5"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) onClose(); }}
      data-codex-thread-import-dialog
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-import-title"
        className="bg-card border border-line rounded-2xl shadow-2xl w-full max-w-3xl h-[min(760px,88vh)] flex flex-col overflow-hidden"
      >
        <header className="px-6 py-4 border-b border-line flex items-start gap-3">
          <div className="mt-0.5 w-9 h-9 rounded-lg border border-line bg-wash flex items-center justify-center text-accent shrink-0">
            <MessagesSquare size={18} strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="codex-import-title" className="text-base font-semibold text-ink">{t('codexImport.title')}</h2>
            <p className="text-xs text-ink-muted mt-1 leading-relaxed">{t('codexImport.subtitle')}</p>
          </div>
          <button
            onClick={onClose}
            disabled={importing}
            className="w-8 h-8 rounded-lg text-ink-faint hover:text-ink hover:bg-wash flex items-center justify-center transition-colors disabled:opacity-40"
            title={t('common.close')}
          >
            <X size={17} strokeWidth={1.75} />
          </button>
        </header>

        <div className="px-6 py-2.5 border-b border-attention/30 bg-attention/10 flex items-start gap-2 text-xs text-attention leading-relaxed" role="note">
          <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
          <span>{t(viewArchived
            ? 'codexImport.archivedHistoryWarning'
            : 'codexImport.hiddenHistoryWarning')}</span>
        </div>

        <form
          className="px-6 py-3 border-b border-line flex gap-2"
          onSubmit={(event) => { event.preventDefault(); submitSearch(); }}
        >
          <div className="h-9 rounded-lg border border-line overflow-hidden flex shrink-0" role="group" aria-label={t('codexImport.statusFilter')}>
            {([false, true] as const).map((archived) => (
              <button
                key={String(archived)}
                type="button"
                onClick={() => switchArchiveFilter(archived)}
                disabled={importing}
                aria-pressed={viewArchived === archived}
                className={`px-3 text-xs font-medium transition-colors ${archived ? 'border-l border-line' : ''} ${
                  viewArchived === archived ? 'bg-accent/10 text-accent' : 'bg-card text-ink-muted hover:bg-wash hover:text-ink'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {archived ? t('codexImport.archived') : t('codexImport.active')}
              </button>
            ))}
          </div>
          <label className="flex-1 min-w-0 h-9 bg-surface border border-line rounded-lg flex items-center gap-2 px-3 focus-within:border-accent/60 transition-colors">
            <Search size={15} strokeWidth={1.75} className="text-ink-faint shrink-0" />
            <input
              autoFocus
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder={t('codexImport.searchPlaceholder')}
              className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={phase !== null}
            className="h-9 px-4 rounded-lg border border-line bg-wash text-xs font-medium text-ink hover:border-line-strong transition-colors disabled:opacity-50"
          >
            {t('codexImport.search')}
          </button>
          <button
            type="button"
            onClick={() => void load({ search: draftSearch.trim(), archived: viewArchived })}
            disabled={phase !== null}
            className="w-9 h-9 rounded-lg border border-line text-ink-muted hover:text-accent hover:bg-wash flex items-center justify-center transition-colors disabled:opacity-50"
            title={t('codexImport.refresh')}
          >
            <RefreshCw size={15} strokeWidth={1.75} className={phase === 'list' ? 'animate-spin' : ''} />
          </button>
        </form>

        <div className="flex-1 min-h-0 overflow-y-auto bg-surface/40">
          {phase === 'list' && threads.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-ink-faint gap-3">
              <Loader2 size={22} strokeWidth={1.75} className="animate-spin text-accent" />
              <span className="text-xs">{t('codexImport.loading')}</span>
            </div>
          )}
          {phase !== 'list' && threads.length === 0 && !error && (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <MessagesSquare size={28} strokeWidth={1.5} className="text-ink-faint mb-3" />
              <p className="text-sm text-ink-muted">{t('codexImport.empty')}</p>
            </div>
          )}
          {threads.length > 0 && (
            <ul className="divide-y divide-line/70">
              {threads.map((thread) => {
                const imported = importedProjects.get(thread.id);
                const selectedRow = selectedId === thread.id;
                const when = readableDate(thread.updatedAt ?? thread.createdAt, locale);
                const sourceLabel = thread.sourceKind ?? thread.threadSource;
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      aria-selected={selectedRow}
                      onClick={() => setSelectedId(thread.id)}
                      className={`w-full text-left px-6 py-3.5 transition-colors border-l-2 ${
                        selectedRow ? 'bg-accent/10 border-accent' : 'border-transparent hover:bg-wash'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium text-ink truncate flex-1">{codexThreadTitle(thread)}</span>
                        {imported && (
                          <span className="rounded-full px-2 py-0.5 bg-success/10 text-success text-2xs font-medium flex items-center gap-1 shrink-0">
                            <Check size={11} strokeWidth={2} /> {t('codexImport.imported')}
                          </span>
                        )}
                        {sourceLabel && (
                          <span className="rounded px-1.5 py-0.5 border border-line text-2xs font-mono text-ink-faint shrink-0">{sourceLabel}</span>
                        )}
                      </div>
                      {thread.preview && thread.preview.trim() !== codexThreadTitle(thread) && (
                        <p className="mt-1 text-xs text-ink-muted truncate">{thread.preview}</p>
                      )}
                      <div className="mt-1.5 flex items-center gap-3 min-w-0 text-2xs text-ink-faint">
                        {thread.cwd && (
                          <span className="flex items-center gap-1 min-w-0 truncate" title={thread.cwd}>
                            <Folder size={11} strokeWidth={1.75} className="shrink-0" />
                            <span className="truncate">{thread.cwd}</span>
                          </span>
                        )}
                        {when && <time className="ml-auto shrink-0">{when}</time>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {nextCursor && threads.length > 0 && (
            <div className="p-4 flex justify-center">
              <button
                type="button"
                onClick={() => void load({ search: activeSearch, archived: activeArchived, cursor: nextCursor, append: true })}
                disabled={phase !== null}
                className="h-8 px-4 rounded-lg border border-line text-xs text-ink-muted hover:text-ink hover:bg-wash transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {phase === 'more' && <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />}
                {t('codexImport.loadMore')}
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mx-6 mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {fmt(t('codexImport.failed'), { msg: error })}
          </div>
        )}

        <footer className="px-6 py-4 border-t border-line flex items-center gap-3">
          <p className="text-xs text-ink-faint min-w-0 flex-1 truncate">
            {viewArchived
              ? selectedExisting
                ? fmt(t('codexImport.archivedExistingHint'), { name: selectedExisting.name })
                : selected
                  ? t('codexImport.archivedNewCanvasHint')
                  : t('codexImport.archivedSelectHint')
              : selectedExisting
                ? fmt(t('codexImport.existingHint'), { name: selectedExisting.name })
                : selected
                  ? t('codexImport.newCanvasHint')
                  : t('codexImport.selectHint')}
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            className="h-9 px-4 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-wash transition-colors disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void importSelected()}
            disabled={!selected || importing || switching}
            className="h-9 px-4 rounded-lg bg-accent hover:bg-accent-strong text-white text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
          >
            {importing
              ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              : selectedExisting
                ? <MessagesSquare size={14} strokeWidth={1.75} />
                : <Import size={14} strokeWidth={1.75} />}
            {importing
              ? t('codexImport.importing')
              : selectedExisting
                ? t('codexImport.openExisting')
                : t('codexImport.import')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
