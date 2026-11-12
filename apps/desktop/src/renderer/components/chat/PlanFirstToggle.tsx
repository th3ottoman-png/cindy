/**
 * PlanFirstToggle — composer modifier chip `✦ Plan First` (ROADMAP 11.7).
 *
 * Sits next to the Chat-Only toggle in the session header (see CCAgentSessionView).
 * While on and undecided, the daemon locks the session's file-writing tools and the model
 * is instructed to return its decisions as `cindy-decisions` cards instead of code.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PlanFirstView } from '@/../main/maker-ipc/planFirst';

interface PlanFirstToggleProps {
  sessionId: string;
}

export function PlanFirstToggle({ sessionId }: PlanFirstToggleProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<PlanFirstView | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    window.electronAPI.maker.planFirst
      .get({ sessionId })
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const toggle = useCallback(async () => {
    const next = !(view?.planFirst ?? false);
    try {
      const updated = await window.electronAPI.maker.planFirst.set({ sessionId, planFirst: next });
      setView(updated);
    } catch {
      // Fails open: the chip keeps its previous state; the daemon never learns a half-toggle.
    }
  }, [sessionId, view?.planFirst]);

  const on = view?.planFirst ?? false;
  const locked = view?.locked ?? false;
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      title={
        locked
          ? t('chat.planFirst.lockedHint')
          : t('chat.planFirst.hint')
      }
      aria-pressed={on}
      data-testid="plan-first-toggle"
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        on
          ? 'border-[var(--warning-accent)] bg-[var(--warning-bg-soft)] text-foreground'
          : 'border-border/40 bg-muted/40 text-muted-foreground hover:text-foreground',
      )}
    >
      <span aria-hidden>✦</span>
      <span className="truncate">{t('chat.planFirst.label')}</span>
      {locked && (
        <span className="truncate text-muted-foreground">
          · {t('chat.planFirst.locked')}
        </span>
      )}
    </button>
  );
}
