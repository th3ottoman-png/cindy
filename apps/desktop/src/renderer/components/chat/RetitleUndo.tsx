/**
 * ROADMAP 13.9: one-click undo for an automatic re-title. Renders only while the session
 * has a previous title to go back to, so it is invisible in the normal case.
 */

import { useCallback, useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';

const log = createLogger('RetitleUndo');

export function RetitleUndo({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const [previous, setPrevious] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await window.electronAPI.maker.retitle.getState(sessionId);
      setPrevious(state?.history?.[0] ?? null);
    } catch (err) {
      log.warn('retitle getState failed', err);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const undo = useCallback(async () => {
    setBusy(true);
    try {
      await window.electronAPI.maker.retitle.undo(sessionId);
      await load();
    } catch (err) {
      log.warn('retitle undo failed', err);
    } finally {
      setBusy(false);
    }
  }, [sessionId, load]);

  if (!previous) return null;
  return (
    <div
      data-retitle-undo
      className="mb-1.5 flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-12 text-[var(--text-secondary)]"
    >
      <span className="truncate">Title changed automatically. Previous: {previous}</span>
      <button
        type="button"
        onClick={() => { void undo(); }}
        disabled={busy}
        aria-label="Undo the automatic title change"
        className="ml-auto shrink-0 rounded-full border border-[var(--border-default)] px-2.5 py-0.5 text-11 font-medium text-[var(--text-primary)] disabled:opacity-50"
      >
        Undo
      </button>
    </div>
  );
}
