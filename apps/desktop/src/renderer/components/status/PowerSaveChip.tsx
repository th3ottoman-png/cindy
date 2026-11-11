/**
 * PowerSaveChip — ROADMAP 11.2.
 *
 * The coffee cup in the session header. It lights up while the main process holds an automatic
 * power-save blocker (a turn, a scheduled run, a research job) and stays muted otherwise. Clicking
 * it toggles the owner's manual "keep awake" setting, so the same control both reports and arms.
 */

import { Coffee } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useKeepAwakeSetting } from '@/hooks/useKeepAwakeSetting';
import { cn } from '@/lib/utils';

interface PowerSaveStatus {
  active: boolean;
  reasons: string[];
  blockerId: number | null;
}

const EMPTY: PowerSaveStatus = { active: false, reasons: [], blockerId: null };

export function PowerSaveChip() {
  const { t } = useTranslation();
  const { keepAwake, setKeepAwake } = useKeepAwakeSetting();
  const [status, setStatus] = useState<PowerSaveStatus>(EMPTY);

  useEffect(() => {
    let mounted = true;
    void window.electronAPI?.maker?.powerSave
      ?.getStatus()
      .then((next) => {
        if (mounted) setStatus(next);
      })
      .catch(() => {});
    const off = window.electronAPI?.maker?.powerSave?.onChanged((next) => {
      if (mounted) setStatus(next);
    });
    return () => {
      mounted = false;
      off?.();
    };
  }, []);

  const reasons = [...status.reasons, ...(keepAwake ? ['manual'] : [])];
  const active = status.active || keepAwake;
  const reasonText = reasons.length
    ? reasons.map((reason) => t(`ccAgent.powerSave.reason.${reason}`)).join(', ')
    : t('ccAgent.powerSave.idle');

  return (
    <button
      type="button"
      data-testid="power-save-chip"
      data-active={active}
      onClick={() => void setKeepAwake(!keepAwake)}
      title={t('ccAgent.powerSave.tooltip', { reasons: reasonText })}
      aria-label={t('ccAgent.powerSave.toggle')}
      aria-pressed={keepAwake}
      className={cn(
        'inline-flex h-6 items-center justify-center rounded-full text-11 font-medium transition-colors',
        active
          ? 'gap-1.5 bg-[var(--warning-bg-soft)] px-2 text-[var(--warning-fg)]'
          : 'w-6 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
      )}
    >
      <Coffee size={13} strokeWidth={1.75} className="shrink-0" />
      {active ? <span>{t('ccAgent.powerSave.active')}</span> : null}
    </button>
  );
}
