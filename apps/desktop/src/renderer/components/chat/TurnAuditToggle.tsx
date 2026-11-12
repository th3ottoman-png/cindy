/**
 * TurnAuditToggle — session header chip `Audit` (ROADMAP 11.10).
 *
 * Sits next to Chat-Only and Plan First. While on, each Hermes turn asks the model for a
 * `cindy-audit` footer (progress, decisions, low-confidence assumptions) that the In This Chat
 * inspector shows under "Audit & Assumptions". Stated in the header because it changes what the
 * agent is asked (AGENTS.md §6, no hidden state). English-only UI by decision (ADR 0002).
 */

import { useCallback, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import type { TurnAuditView } from '@/../main/maker-ipc/turnAudit';

export function TurnAuditToggle({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<TurnAuditView | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    window.electronAPI?.maker?.turnAudit
      ?.get({ sessionId })
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
    try {
      setView(
        await window.electronAPI.maker.turnAudit.set({
          sessionId,
          turnAudit: !(view?.turnAudit ?? false),
        }),
      );
    } catch {
      // Keeps its previous state; the agent reads the flag file on the next turn either way.
    }
  }, [sessionId, view?.turnAudit]);

  const on = view?.turnAudit ?? false;
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      title="Turn audit: each reply ends with its progress, decisions and low-confidence assumptions, shown in In This Chat → Audit & Assumptions"
      aria-pressed={on}
      data-testid="turn-audit-toggle"
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        on
          ? 'border-[var(--warning-accent)] bg-[var(--warning-bg-soft)] text-foreground'
          : 'border-border/40 bg-muted/40 text-muted-foreground hover:text-foreground',
      )}
    >
      <span aria-hidden>◎</span>
      <span className="truncate">{on ? 'Audit on' : 'Audit'}</span>
    </button>
  );
}
