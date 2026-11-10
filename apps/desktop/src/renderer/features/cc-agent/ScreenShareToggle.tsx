import { useEffect, useState } from 'react';
import { Shield, EyeOff } from 'lucide-react';
import { screenShareStore, type ScreenShareState } from '@/lib/screenShareStore';

export interface ScreenShareToggleProps {
  className?: string;
  onToggle?: (enabled: boolean) => void;
}

export function ScreenShareToggleView({
  enabled,
  onToggle,
  className,
}: {
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid="screen-share-toggle"
      data-active={enabled}
      onClick={onToggle}
      title={
        enabled
          ? 'Screen-share privacy active: click to disable'
          : 'Enable screen-share privacy redaction (/screen-share)'
      }
      aria-label="Screen-share privacy toggle"
      className={
        className ??
        `inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-11 font-medium transition-colors ${
          enabled
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
        }`
      }
    >
      {enabled ? (
        <EyeOff size={13} className="shrink-0 text-amber-500" />
      ) : (
        <Shield size={13} className="shrink-0 text-[var(--text-tertiary)]" />
      )}
      <span>{enabled ? 'Privacy Active' : 'Screen-Share'}</span>
    </button>
  );
}

export function ScreenShareToggle({ className, onToggle }: ScreenShareToggleProps) {
  const [state, setState] = useState<ScreenShareState>(screenShareStore.getState());

  useEffect(() => {
    void screenShareStore.init();
    const unsub = screenShareStore.subscribe((next) => {
      setState(next);
      onToggle?.(next.enabled);
    });
    return unsub;
  }, [onToggle]);

  const handleToggle = () => {
    void screenShareStore.toggle();
  };

  return (
    <ScreenShareToggleView
      enabled={state.enabled}
      onToggle={handleToggle}
      className={className}
    />
  );
}
