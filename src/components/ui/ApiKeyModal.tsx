import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Copy, Loader2, RefreshCw, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import { useUiStore, toast } from '../../lib/ui-store';
import { refreshModels, type CodexConnectionStatus } from '../../lib/use-models';
import { useT } from '../../i18n';
import { API_BASE } from '../../lib/constants';

interface StatusResponse {
  status: CodexConnectionStatus;
  message?: string;
  model?: string;
}

type ViewStatus = CodexConnectionStatus | 'loading';

// Kept under the historical filename to avoid churn at call sites. This is
// now a read-only Codex connection panel: authentication belongs to the
// local Codex installation and no secret is ever entered into the browser.
export default function ApiKeyModal() {
  const t = useT();
  const open = useUiStore((state) => state.apiKeyModalOpen);
  const setOpen = useUiStore((state) => state.setApiKeyModalOpen);
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [details, setDetails] = useState<StatusResponse | null>(null);

  const readStatus = useCallback(async (signal?: AbortSignal) => {
    setStatus('loading');
    try {
      const response = await fetch(`${API_BASE}/api/codex/status`, {
        cache: 'no-store',
        signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      const raw = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
      const reportedStatus = raw && ['ready', 'not_logged_in', 'unavailable'].includes(String(raw.status))
        ? raw.status as CodexConnectionStatus
        : null;
      const reportedMessage = typeof raw?.message === 'string' ? raw.message : undefined;
      // Local-only deployments intentionally answer with a non-2xx status
      // plus a useful JSON diagnosis. Preserve it; HTTP text is the fallback
      // only when the endpoint did not return a meaningful status payload.
      if (!raw || (!reportedStatus && !reportedMessage)) throw new Error(`HTTP ${response.status}`);
      const nextStatus: CodexConnectionStatus = reportedStatus ?? 'unavailable';
      const next: StatusResponse = {
        status: nextStatus,
        ...(reportedMessage ? { message: reportedMessage } : {}),
        ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      };
      setDetails(next);
      setStatus(nextStatus);
      if (nextStatus === 'ready') void refreshModels();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setDetails({
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
      setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void readStatus(controller.signal);
    return () => controller.abort();
  }, [open, readStatus]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  if (!open) return null;

  const ready = status === 'ready';
  const notLoggedIn = status === 'not_logged_in';
  const title = status === 'loading'
    ? t('codex.statusLoading')
    : ready
      ? t('codex.statusReady')
      : notLoggedIn
        ? t('codex.statusNotLoggedIn')
        : t('codex.statusUnavailable');
  const description = status === 'loading'
    ? t('codex.loadingDesc')
    : ready
      ? t('codex.readyDesc')
      : notLoggedIn
        ? t('codex.notLoggedInDesc')
        : t('codex.unavailableDesc');

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      data-codex-connection-modal
    >
      <div className="w-full max-w-md bg-card border border-line rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <span className="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
            <SquareTerminal size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{t('codex.connectionTitle')}</h2>
            <p className="text-2xs text-ink-faint mt-0.5">{t('codex.connectionIntro')}</p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink hover:bg-wash transition-colors"
            title={t('common.close')}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className={`rounded-xl border px-4 py-3 ${
            ready
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : notLoggedIn
                ? 'border-amber-500/30 bg-amber-500/5'
                : status === 'loading'
                  ? 'border-line bg-wash/50'
                  : 'border-red-500/30 bg-red-500/5'
          }`}>
            <div className="flex items-start gap-3">
              {status === 'loading'
                ? <Loader2 size={18} strokeWidth={1.75} className="animate-spin text-accent shrink-0 mt-0.5" />
                : ready
                  ? <CheckCircle2 size={18} strokeWidth={1.75} className="text-emerald-500 shrink-0 mt-0.5" />
                  : <TriangleAlert size={18} strokeWidth={1.75} className={`${notLoggedIn ? 'text-amber-500' : 'text-red-500'} shrink-0 mt-0.5`} />}
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{title}</p>
                <p className="text-xs text-ink-muted leading-relaxed mt-1">{description}</p>
                {ready && details?.model && (
                  <p className="text-2xs text-ink-faint mt-2">{t('codex.activeModel')}: <span className="font-mono text-ink-muted">{details.model}</span></p>
                )}
                {!ready && details?.message && (
                  <p className="text-2xs text-ink-faint mt-2 break-words">{details.message}</p>
                )}
              </div>
            </div>
          </div>

          {notLoggedIn && (
            <div>
              <p className="text-xs text-ink-muted leading-relaxed mb-2">{t('codex.loginHint')}</p>
              <div className="flex items-center gap-2 rounded-xl bg-canvas border border-line px-3 py-2">
                <code className="text-xs text-ink font-mono flex-1">codex login</code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText('codex login').then(() => toast('success', t('codex.commandCopied')));
                  }}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-accent hover:bg-wash transition-colors"
                  title={t('codex.copyCommand')}
                >
                  <Copy size={13} strokeWidth={1.75} />
                </button>
              </div>
              <p className="text-2xs text-ink-faint leading-relaxed mt-1.5">{t('codex.loginAlt')}</p>
            </div>
          )}

          {!ready && status !== 'loading' && (
            <p className="text-2xs text-ink-faint leading-relaxed">{t('codex.proxyHint')}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-line bg-wash/30">
          <button
            onClick={() => void readStatus()}
            disabled={status === 'loading'}
            className="h-8 px-3 rounded-lg border border-line text-xs text-ink-muted hover:text-ink hover:bg-wash disabled:opacity-40 transition-colors inline-flex items-center gap-1.5"
          >
            <RefreshCw size={13} strokeWidth={1.75} className={status === 'loading' ? 'animate-spin' : ''} />
            {t('codex.retry')}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="h-8 px-4 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-strong transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
