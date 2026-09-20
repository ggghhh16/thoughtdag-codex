import { useEffect, useRef, useState } from 'react';
import { BrainCircuit, Check, ChevronDown, Cpu, SquareTerminal } from 'lucide-react';
import { useUiStore } from '../../lib/ui-store';
import { useModels, type CodexConnectionStatus } from '../../lib/use-models';
import { useT } from '../../i18n';

function effortLabel(t: ReturnType<typeof useT>, effort: string): string {
  switch (effort) {
    case 'none': return t('model.effortNone');
    case 'minimal': return t('model.effortMinimal');
    case 'low': return t('model.effortLow');
    case 'medium': return t('model.effortMedium');
    case 'high': return t('model.effortHigh');
    case 'xhigh': return t('model.effortXHigh');
    case 'max': return t('model.effortMax');
    case 'ultra': return t('model.effortUltra');
    case 'persistent': return t('model.effortPersistent');
    default: return effort;
  }
}

interface PickerProps {
  /** Node mode: controlled value (undefined = inherit global) + change handler. */
  value?: string;
  onChange?: (id: string | undefined) => void;
  /** Compact styling for embedding in panel rows. */
  compact?: boolean;
}

// Codex-only model picker. The local proxy owns authentication and model
// discovery; this surface never accepts credentials or endpoint settings.
export default function ModelPicker({ value, onChange, compact }: PickerProps) {
  const t = useT();
  const nodeMode = !!onChange;
  const selectedModel = useUiStore((s) => s.selectedModel);
  const setSelectedModel = useUiStore((s) => s.setSelectedModel);
  const selectedEffort = useUiStore((s) => s.selectedReasoningEffort);
  const setSelectedEffort = useUiStore((s) => s.setSelectedReasoningEffort);
  const data = useModels();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const ping = useUiStore((s) => s.modelPickerPing);
  const [pingSeen, setPingSeen] = useState(ping);
  if (ping !== pingSeen) {
    setPingSeen(ping);
    if (!nodeMode) setOpen(true);
  }

  const models = data?.models ?? [];
  const connectionStatus = data?.capabilities?.status ?? data?.codex?.status;
  const noModels = !nodeMode && (models.length === 0 || (connectionStatus !== undefined && connectionStatus !== 'ready'));
  const globalId = selectedModel && models.some((model) => model.id === selectedModel)
    ? selectedModel
    : data?.default;
  const activeId = nodeMode ? (value ?? null) : globalId;
  const active = activeId ? models.find((model) => model.id === activeId) : null;
  const effectiveEffort = selectedEffort && active?.reasoningEfforts.some((effort) => effort.id === selectedEffort)
    ? selectedEffort
    : null;

  useEffect(() => {
    if (!nodeMode && connectionStatus === 'ready' && selectedEffort && active && !active.reasoningEfforts.some((effort) => effort.id === selectedEffort)) {
      setSelectedEffort(null);
    }
  }, [active, connectionStatus, nodeMode, selectedEffort, setSelectedEffort]);

  // A single logical Codex model has no meaningful node-level override.
  if (nodeMode && models.length < 2) return null;
  const label = nodeMode
    ? (active ? active.name : t('model.inherit'))
    : (active?.name ?? activeId ?? (noModels ? t('model.none') : null));

  const pick = (id: string | null) => {
    if (nodeMode) onChange!(id ?? undefined);
    else {
      setSelectedModel(id === data?.default ? null : id);
      const nextId = id ?? data?.default ?? null;
      const next = nextId ? models.find((model) => model.id === nextId) : null;
      if (selectedEffort && !next?.reasoningEfforts.some((effort) => effort.id === selectedEffort)) {
        setSelectedEffort(null);
      }
    }
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={(event) => {
          event.stopPropagation();
          if (noModels) useUiStore.getState().setApiKeyModalOpen(true);
          else setOpen((current) => !current);
        }}
        className={compact
          ? `text-xs px-3 py-2 rounded-lg transition-colors flex items-center gap-1.5 max-w-[200px] ${value ? 'bg-accent/10 text-accent' : 'bg-wash hover:bg-line text-ink-muted'}`
          : noModels
            ? 'bg-accent/10 backdrop-blur border border-accent/40 rounded-lg h-8 px-2.5 flex items-center gap-1.5 shadow-sm hover:bg-accent/20 transition-colors text-accent max-w-[190px]'
            : 'bg-card/90 backdrop-blur border border-line rounded-lg h-8 px-2.5 flex items-center gap-1.5 shadow-sm hover:bg-wash transition-colors text-ink-muted max-w-[250px]'}
        title={noModels ? t('codex.connectionTitle') : t('toolbar.model')}
        data-codex-entry={noModels || undefined}
      >
        {noModels
          ? <SquareTerminal size={14} strokeWidth={1.75} className="shrink-0" />
          : <Cpu size={14} strokeWidth={1.75} className={`shrink-0 ${compact && !value ? '' : 'text-accent'}`} />}
        <span className="text-xs truncate font-medium">{noModels ? t('model.connectCta') : label}</span>
        {!nodeMode && !noModels && active && active.reasoningEfforts.length > 0 && (
          <span className="text-2xs text-accent bg-accent/10 rounded px-1.5 py-0.5 shrink-0">
            {effortLabel(t, effectiveEffort || active.defaultReasoningEffort || 'auto')}
          </span>
        )}
        {!noModels && <ChevronDown size={12} strokeWidth={1.75} className="shrink-0" />}
      </button>

      {open && (
        <div className="absolute top-9 right-0 bg-card border border-line rounded-xl shadow-xl py-1.5 w-72 max-h-[70vh] overflow-y-auto z-30">
          <p className="text-2xs text-ink-faint uppercase tracking-wider font-medium px-3 pt-1 pb-1">
            {t('model.modelsTitle')}
          </p>
          {nodeMode && (
            <button
              onClick={() => pick(null)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors hover:bg-wash ${!value ? 'text-accent font-medium' : 'text-ink'}`}
            >
              <span className="truncate flex-1">{t('model.inherit')}</span>
              {!value && <Check size={13} strokeWidth={2} className="shrink-0" />}
            </button>
          )}
          {models.map((model) => (
            <button
              key={model.id}
              onClick={() => pick(model.id)}
              className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-wash ${
                model.id === activeId ? 'text-accent font-medium' : 'text-ink'
              }`}
            >
              <span className="truncate flex-1">{model.name}</span>
              {model.vision && <span className="text-2xs text-ink-faint shrink-0">{t('model.vision')}</span>}
              {model.id === activeId && <Check size={13} strokeWidth={2} className="shrink-0" />}
            </button>
          ))}
          {!nodeMode && active && active.reasoningEfforts.length > 0 && (
            <div className="border-t border-line mt-1.5 pt-1.5 pb-1">
              <p className="text-2xs text-ink-faint uppercase tracking-wider font-medium px-3 pt-1 pb-1 flex items-center gap-1.5">
                <BrainCircuit size={12} strokeWidth={1.75} /> {t('model.reasoningTitle')}
              </p>
              <button
                onClick={() => { setSelectedEffort(null); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-wash ${
                  !effectiveEffort ? 'text-accent font-medium' : 'text-ink'
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className="block">{t('model.effortAuto')}</span>
                  <span className="block text-2xs text-ink-faint font-normal mt-0.5 truncate">
                    {active.defaultReasoningEffort
                      ? `${t('model.effortDefault')} · ${effortLabel(t, active.defaultReasoningEffort)}`
                      : t('model.effortModelDefault')}
                  </span>
                </span>
                {!effectiveEffort && <Check size={13} strokeWidth={2} className="shrink-0" />}
              </button>
              {active.reasoningEfforts.map((effort) => (
                <button
                  key={effort.id}
                  onClick={() => { setSelectedEffort(effort.id); setOpen(false); }}
                  title={effort.description}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-wash ${
                    effectiveEffort === effort.id ? 'text-accent font-medium' : 'text-ink'
                  }`}
                >
                  <span className="truncate flex-1">{effortLabel(t, effort.id)}</span>
                  {effectiveEffort === effort.id && <Check size={13} strokeWidth={2} className="shrink-0" />}
                </button>
              ))}
            </div>
          )}
          {!nodeMode && <GlobalCapabilities />}
        </div>
      )}
    </div>
  );
}

function GlobalCapabilities() {
  const t = useT();
  const data = useModels();
  const visionModelPref = useUiStore((s) => s.visionModelPref);
  const setVisionModelPref = useUiStore((s) => s.setVisionModelPref);
  const memoryEnabled = useUiStore((s) => s.memoryEnabled);
  const setMemoryEnabled = useUiStore((s) => s.setMemoryEnabled);
  const memoryCount = useUiStore((s) => s.memories.length);
  const setMemoryManagerOpen = useUiStore((s) => s.setMemoryManagerOpen);
  if (!data) return null;

  const capabilities = data.capabilities;
  const visionModels = data.models.filter((model) => model.vision);
  const hasVision = visionModels.length > 0;
  const status: CodexConnectionStatus = capabilities?.status ?? data.codex?.status
    ?? (data.models.length > 0 ? 'ready' : 'unavailable');
  const statusText = status === 'ready'
    ? t('caps.codexReady')
    : status === 'not_logged_in'
      ? t('caps.codexNotLoggedIn')
      : t('caps.codexUnavailable');
  const dot = (on: boolean, warning = false) => (
    <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${on ? 'bg-emerald-500' : warning ? 'bg-amber-500' : 'bg-line-strong'}`} />
  );

  return (
    <div className="border-t border-line mt-1.5 pt-1 pb-1">
      <p className="text-2xs text-ink-faint uppercase tracking-wider font-medium px-3 pt-1 pb-1">{t('caps.title')}</p>
      <button
        onClick={(event) => {
          event.stopPropagation();
          useUiStore.getState().setApiKeyModalOpen(true);
        }}
        className="w-full text-left px-3 py-1 flex items-start gap-2 hover:bg-wash transition-colors"
      >
        {dot(status === 'ready', status === 'not_logged_in')}
        <span className="text-2xs text-ink-muted font-medium flex-1">{t('caps.codexRuntime')}</span>
        <span className="text-2xs text-ink-faint">{statusText}</span>
      </button>
      <div className="px-3 py-1 flex items-start gap-2">
        {dot(capabilities?.webSearch === true)}
        <p className="text-2xs text-ink-faint leading-relaxed flex-1">
          <span className="text-ink-muted font-medium">{t('caps.webSearch')}</span>{' · '}
          {capabilities?.webSearch ? t('caps.webSearchCodex') : t('caps.webSearchOff')}
        </p>
      </div>
      <div className="px-3 py-1 flex items-start gap-2">
        {dot(capabilities?.scholarSearch === true)}
        <p className="text-2xs text-ink-faint leading-relaxed flex-1">
          <span className="text-ink-muted font-medium">{t('caps.scholar')}</span>{' · '}
          {capabilities?.scholarSearch ? t('caps.scholarDesc') : t('caps.scholarCodexOff')}
        </p>
      </div>
      <div className="px-3 py-1 flex items-start gap-2">
        {dot(memoryEnabled)}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <p className="text-2xs text-ink-muted font-medium flex-1">
            {t('caps.memory')} <span className="text-ink-faint font-normal">· {memoryCount}</span>
          </p>
          <button
            onClick={(event) => { event.stopPropagation(); setMemoryManagerOpen(true); }}
            className="text-2xs text-ink-faint hover:text-accent underline decoration-dotted transition-colors shrink-0"
          >
            {t('memory.manage')}
          </button>
          <button
            onClick={(event) => { event.stopPropagation(); setMemoryEnabled(!memoryEnabled); }}
            title={t('caps.memoryTitle')}
            className={`text-2xs px-2 py-0.5 rounded-full transition-colors shrink-0 ${memoryEnabled ? 'bg-accent/10 text-accent' : 'bg-wash text-ink-faint'}`}
          >
            {memoryEnabled ? t('caps.on') : t('caps.off')}
          </button>
        </div>
      </div>
      <div className="px-3 py-1 flex items-start gap-2">
        {dot(hasVision)}
        <div className="flex-1 min-w-0">
          <p className="text-2xs text-ink-muted font-medium">{t('caps.vision')}</p>
          {hasVision ? (
            <select
              value={visionModels.some((model) => model.id === visionModelPref) ? visionModelPref : 'auto'}
              onChange={(event) => setVisionModelPref(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              title={t('caps.visionPickTitle')}
              className="mt-1 w-full text-2xs text-ink-muted bg-wash border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              <option value="auto">{t('caps.visionAuto')}</option>
              {visionModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          ) : (
            <p className="text-2xs text-ink-faint leading-relaxed mt-0.5">{t('caps.visionOff')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
