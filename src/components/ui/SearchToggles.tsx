import { useEffect } from 'react';
import { Globe, GraduationCap, Wrench } from 'lucide-react';
import { useUiStore } from '../../lib/ui-store';
import { useModels } from '../../lib/use-models';
import { useT } from '../../i18n';

// Per-ask search permissions, shown next to every input that asks. The two
// toggles edit the shared default (ui-store, persisted); each new node
// snapshots them at creation, so reruns keep behaving the same way.
export default function SearchToggles({ size = 16 }: { size?: number }) {
  const web = useUiStore((s) => s.webSearchEnabled);
  const setWeb = useUiStore((s) => s.setWebSearchEnabled);
  const scholar = useUiStore((s) => s.scholarSearchEnabled);
  const setScholar = useUiStore((s) => s.setScholarSearchEnabled);
  const mcp = useUiStore((s) => s.mcpEnabled);
  const setMcp = useUiStore((s) => s.setMcpEnabled);
  const t = useT();
  // Keep both permissions visible. The local proxy reports whether each
  // Codex search mode is currently available.
  const capabilities = useModels()?.capabilities;
  const webAvailable = capabilities?.webSearch ?? true;
  const scholarAvailable = capabilities?.scholarSearch ?? true;
  const mcpAvailable = capabilities?.mcp === true;

  useEffect(() => {
    if (capabilities && !mcpAvailable && mcp) setMcp(false);
  }, [capabilities, mcp, mcpAvailable, setMcp]);

  const cls = (on: boolean, available: boolean) =>
    available
      ? `transition-colors shrink-0 rounded-full w-8 h-8 flex items-center justify-center ${on
        ? 'text-accent bg-accent/15 ring-1 ring-accent/40 hover:bg-accent/25'
        : 'text-ink-muted opacity-50 hover:opacity-90 hover:bg-line'}`
      : 'transition-colors shrink-0 rounded-full w-8 h-8 flex items-center justify-center text-ink-faint opacity-30 cursor-not-allowed';

  return (
    <>
      <button
        type="button"
        onClick={() => setWeb(!web)}
        disabled={!webAvailable}
        title={!webAvailable ? t('toolbar.searchUnavailableLane') : web ? t('toolbar.webSearch') : t('toolbar.webSearchOff')}
        className={cls(web, webAvailable)}
        data-web-toggle
      >
        <Globe size={size} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={() => setScholar(!scholar)}
        disabled={!scholarAvailable}
        title={!scholarAvailable ? t('toolbar.searchUnavailableLane') : scholar ? t('toolbar.scholarSearch') : t('toolbar.scholarSearchOff')}
        className={cls(scholar, scholarAvailable)}
        data-scholar-toggle
      >
        <GraduationCap size={size} strokeWidth={1.75} />
      </button>
      {mcpAvailable && (
        <button
          type="button"
          onClick={() => setMcp(!mcp)}
          title={mcp ? t('toolbar.mcp') : t('toolbar.mcpOff')}
          className={cls(mcp, true)}
          data-mcp-toggle
        >
          <Wrench size={size} strokeWidth={1.75} />
        </button>
      )}
    </>
  );
}
