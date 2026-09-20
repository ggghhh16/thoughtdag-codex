import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Gauge, Zap } from 'lucide-react';
import { useT } from '../../i18n';
import { useUiStore, type ModelSpeed } from '../../lib/ui-store';
import { useModels } from '../../lib/use-models';

const SPEEDS: ModelSpeed[] = ['standard', 'fast'];

export default function ModelSpeedPicker() {
  const t = useT();
  const speed = useUiStore((state) => state.modelSpeed);
  const setSpeed = useUiStore((state) => state.setModelSpeed);
  const selectedModel = useUiStore((state) => state.selectedModel);
  const data = useModels();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const activeModelId = selectedModel && data?.models.some((model) => model.id === selectedModel)
    ? selectedModel
    : data?.default;
  const activeModel = data?.models.find((model) => model.id === activeModelId);
  const fastAvailable = activeModel?.supportsFastMode !== false && data?.capabilities?.modelSpeed !== false;
  const fastDescription = activeModel?.serviceTiers.find(
    (tier) => tier.id === 'priority' || tier.id === 'fast',
  )?.description || t('model.speedFastDesc');

  useEffect(() => {
    if (speed === 'fast' && activeModel && !activeModel.supportsFastMode) setSpeed('standard');
  }, [activeModel, setSpeed, speed]);

  const label = speed === 'fast' ? t('model.speedFast') : t('model.speedStandard');

  return (
    <div ref={rootRef} className="relative" data-model-speed-picker>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('model.speedToolbarTitle')}
        className={`bg-card/90 backdrop-blur border rounded-lg h-8 px-2.5 flex items-center gap-1.5 shadow-sm transition-colors max-w-[120px] ${
          speed === 'fast'
            ? 'border-accent/40 text-accent hover:bg-accent/10'
            : 'border-line text-ink-muted hover:bg-wash'
        }`}
      >
        {speed === 'fast'
          ? <Zap size={14} strokeWidth={1.9} className="shrink-0" />
          : <Gauge size={14} strokeWidth={1.75} className="shrink-0" />}
        <span className="hidden min-[1500px]:inline text-xs truncate font-medium">{label}</span>
        <ChevronDown size={12} strokeWidth={1.75} className="shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-9 right-0 bg-card border border-line rounded-xl shadow-xl py-1.5 w-[306px] z-30 animate-fade-in"
        >
          <p className="text-2xs text-ink-faint uppercase tracking-wider font-medium px-3 pt-1 pb-1.5">
            {t('model.speedTitle')}
          </p>
          {SPEEDS.map((item) => {
            const selected = item === speed;
            const fast = item === 'fast';
            const disabled = fast && !fastAvailable;
            return (
              <button
                key={item}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={disabled}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  setSpeed(item);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors ${
                  disabled ? 'opacity-45 cursor-not-allowed' : 'hover:bg-wash'
                } ${
                  selected ? 'bg-accent/5' : ''
                }`}
              >
                <span className={`shrink-0 mt-0.5 ${selected ? 'text-accent' : 'text-ink-muted'}`}>
                  {fast
                    ? <Zap size={16} strokeWidth={1.9} />
                    : <Gauge size={16} strokeWidth={1.75} />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-xs font-medium ${selected ? 'text-accent' : 'text-ink'}`}>
                    {fast ? t('model.speedFast') : t('model.speedStandard')}
                  </span>
                  <span className="block text-2xs leading-relaxed mt-0.5 text-ink-faint">
                    {fast
                      ? disabled ? t('model.speedUnavailable') : fastDescription
                      : t('model.speedStandardDesc')}
                  </span>
                </span>
                {selected && <Check size={14} strokeWidth={2} className="shrink-0 mt-0.5 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
