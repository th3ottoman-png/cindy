import React, { useEffect, useState } from 'react';

import type { ShellLimitsView } from '../../../main/maker-ipc/shellLimits';
import { shellLimitsChip } from './shellLimitsChipText';

/** The limit is one file the owner edits by hand, so a slow re-read is enough. */
export const SHELL_LIMITS_POLL_MS = 10_000;

/**
 * ROADMAP 13.10b: `shell 300s` in the session manifest strip. Renders nothing when the host gives
 * no answer, so a missing bridge never leaves a misleading chip on screen.
 */
export function ShellLimitsChip({ pollMs = SHELL_LIMITS_POLL_MS }: { pollMs?: number }) {
  const [view, setView] = useState<ShellLimitsView | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.maker?.shellLimits;
    if (!api) return undefined;
    let alive = true;
    const read = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void api
        .get()
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
  }, [pollMs]);

  const chip = shellLimitsChip(view);
  if (!chip) return null;
  const tone =
    chip.state === 'error'
      ? 'border-[var(--state-danger,#c0504d)] text-[var(--state-danger,#e06c66)]'
      : chip.state === 'off'
        ? 'border-[var(--border-subtle,#333)] text-[var(--text-placeholder)]'
        : 'border-[var(--border-subtle,#333)] text-[var(--text-secondary,#aaa)]';
  return (
    <span
      data-testid="manifest-shell-limits"
      data-state={chip.state}
      title={chip.title}
      className={`shrink-0 rounded border px-1.5 py-0.5 tabular-nums ${tone}`}
    >
      {chip.label}
    </span>
  );
}
