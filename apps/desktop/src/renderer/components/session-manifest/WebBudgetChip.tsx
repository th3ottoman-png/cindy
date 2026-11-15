import React, { useEffect, useState } from 'react';

import type { WebBudgetView } from '../../../main/maker-ipc/webBudget';
import { webBudgetChip } from './webBudgetChipText';

/** How often the chip re-reads the daemon's count while it is on screen (local socket only). */
export const WEB_BUDGET_POLL_MS = 4_000;

/**
 * ROADMAP 13.5: `web N/M` in the session manifest strip. The count moves during a turn, so the
 * chip re-reads it while visible; it renders nothing when the daemon gives no answer.
 */
export function WebBudgetChip({
  sessionId,
  pollMs = WEB_BUDGET_POLL_MS,
}: {
  sessionId: string;
  pollMs?: number;
}) {
  const [view, setView] = useState<WebBudgetView | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.maker?.webBudget;
    if (!api) return undefined;
    let alive = true;
    const read = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void api
        .get(sessionId)
        .then((next) => {
          if (alive) setView(next);
        })
        .catch(() => {
          if (alive) setView(null);
        });
    };
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId, pollMs]);

  const chip = webBudgetChip(view);
  if (!chip) return null;
  const tone =
    chip.state === 'reached'
      ? 'border-[var(--state-danger,#c0504d)] text-[var(--state-danger,#e06c66)]'
      : chip.state === 'near'
        ? 'border-[var(--state-warning,#b8860b)] text-[var(--state-warning,#d9a441)]'
        : 'border-[var(--border-subtle,#333)] text-[var(--text-secondary,#aaa)]';
  return (
    <span
      data-testid="manifest-web-budget"
      data-state={chip.state}
      title={chip.title}
      className={`shrink-0 rounded border px-1.5 py-0.5 tabular-nums ${tone}`}
    >
      {chip.label}
    </span>
  );
}
