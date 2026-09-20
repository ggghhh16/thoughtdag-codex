import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useT } from '../../i18n';
import { confirmDialog, useUiStore, type PermissionMode } from '../../lib/ui-store';

const MODES: PermissionMode[] = ['readonly', 'workspace', 'full'];

export default function PermissionPicker() {
  const t = useT();
  const mode = useUiStore((state) => state.permissionMode);
  const setMode = useUiStore((state) => state.setPermissionMode);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', closeOnOutsideClick);
    return () => window.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open]);

  const label = mode === 'readonly'
    ? t('permission.readonly')
    : mode === 'workspace'
      ? t('permission.workspace')
      : t('permission.full');

  const icon = (item: PermissionMode, size = 14) => {
    if (item === 'readonly') return <Shield size={size} strokeWidth={1.75} />;
    if (item === 'workspace') return <ShieldCheck size={size} strokeWidth={1.75} />;
    return <ShieldAlert size={size} strokeWidth={1.75} />;
  };

  const itemLabel = (item: PermissionMode) => item === 'readonly'
    ? t('permission.readonly')
    : item === 'workspace'
      ? t('permission.workspace')
      : t('permission.full');

  const itemDescription = (item: PermissionMode) => item === 'readonly'
    ? t('permission.readonlyDesc')
    : item === 'workspace'
      ? t('permission.workspaceDesc')
      : t('permission.fullDesc');

  return (
    <div ref={rootRef} className="relative" data-permission-picker>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        title={t('permission.toolbarTitle')}
        className={`bg-card/90 backdrop-blur border rounded-lg h-8 px-2.5 flex items-center gap-1.5 shadow-sm transition-colors max-w-[190px] ${
          mode === 'full'
            ? 'border-orange-500/60 text-orange-500 hover:bg-orange-500/10'
            : mode === 'workspace'
              ? 'border-accent/40 text-accent hover:bg-accent/10'
              : 'border-line text-ink-muted hover:bg-wash'
        }`}
      >
        <span className="shrink-0">{icon(mode)}</span>
        <span className="text-xs truncate font-medium">{label}</span>
        <ChevronDown size={12} strokeWidth={1.75} className="shrink-0" />
      </button>

      {open && (
        <div className="absolute top-9 right-0 bg-card border border-line rounded-xl shadow-xl py-1.5 w-[330px] z-30 animate-fade-in">
          <p className="text-2xs text-ink-faint uppercase tracking-wider font-medium px-3 pt-1 pb-1.5">
            {t('permission.title')}
          </p>
          {MODES.map((item) => {
            const selected = item === mode;
            const full = item === 'full';
            return (
              <button
                key={item}
                type="button"
                onClick={() => {
                  if (item === 'full' && mode !== 'full') {
                    setOpen(false);
                    void confirmDialog({
                      title: t('permission.fullConfirmTitle'),
                      message: t('permission.fullConfirmMessage'),
                      confirmLabel: t('permission.fullConfirmAction'),
                      danger: true,
                    }).then((confirmed) => {
                      if (confirmed) setMode('full');
                    });
                    return;
                  }
                  setMode(item);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors ${
                  full
                    ? 'hover:bg-orange-500/10'
                    : 'hover:bg-wash'
                } ${selected ? (full ? 'bg-orange-500/10' : 'bg-accent/5') : ''}`}
              >
                <span className={`shrink-0 mt-0.5 ${full ? 'text-orange-500' : selected ? 'text-accent' : 'text-ink-muted'}`}>
                  {icon(item, 16)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`text-xs font-medium flex items-center gap-1.5 ${full ? 'text-orange-500' : selected ? 'text-accent' : 'text-ink'}`}>
                    {itemLabel(item)}
                    {item === 'workspace' && (
                      <span className="text-2xs font-normal rounded px-1.5 py-0.5 bg-accent/10 text-accent">
                        {t('permission.recommended')}
                      </span>
                    )}
                  </span>
                  <span className={`block text-2xs leading-relaxed mt-0.5 ${full ? 'text-orange-500/80' : 'text-ink-faint'}`}>
                    {itemDescription(item)}
                  </span>
                </span>
                {selected && <Check size={14} strokeWidth={2} className={`shrink-0 mt-0.5 ${full ? 'text-orange-500' : 'text-accent'}`} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
