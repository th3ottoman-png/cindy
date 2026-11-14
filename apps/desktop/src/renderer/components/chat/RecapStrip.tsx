/**
 * "Where you left off" recap strip (ROADMAP 13.3, blueprint §5).
 *
 * A transient reminder above the composer. It is NEVER inserted into the transcript and never
 * sent to the agent. The route and model are named on the strip so background spend is visible
 * (AGENTS.md §6.4); when `recap` is not routed the host returns null and nothing renders.
 *
 * "Away" is measured from when the owner last left this session, so the map lives at module
 * scope: it must survive the component unmounting on a session switch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RecapStrip as RecapStripData } from '../../../main/maker-ipc/recap';
import { createLogger } from '@/lib/logger';

const log = createLogger('RecapStrip');

const leftAt = new Map<string, number>();

export interface RecapStripProps {
  sessionId: string;
  /** User turns in the conversation; the host needs at least 4. */
  turnCount: number;
  running: boolean;
}

export function RecapStrip({ sessionId, turnCount, running }: RecapStripProps) {
  const [strip, setStrip] = useState<RecapStripData | null>(null);
  const askedFor = useRef<string>('');

  const ask = useCallback(() => {
    if (!sessionId) return;
    // One ask per (session, turn count): a focus event must not re-bill the same state.
    const key = `${sessionId}:${turnCount}`;
    if (askedFor.current === key) return;
    askedFor.current = key;
    void window.electronAPI.maker.recap
      .onFocus({ sessionId, leftAt: leftAt.get(sessionId) ?? null, turnCount, running })
      .then((next) => { if (next) setStrip(next); })
      .catch((err) => { log.warn('recap onFocus failed', err); });
  }, [sessionId, turnCount, running]);

  // Leaving the session (switch or window blur) starts the away clock.
  useEffect(() => {
    if (!sessionId) return;
    const mark = () => { leftAt.set(sessionId, Date.now()); };
    window.addEventListener('blur', mark);
    return () => {
      window.removeEventListener('blur', mark);
      mark();
    };
  }, [sessionId]);

  // Returning: a session switch mounts this component, and a window focus fires the event.
  useEffect(() => {
    if (!sessionId) return;
    ask();
    const onFocus = () => { ask(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, [sessionId, ask]);

  // A new turn invalidates the strip: it describes an older state.
  useEffect(() => {
    setStrip((current) => (current && current.turnCount !== turnCount ? null : current));
  }, [turnCount]);

  const dismiss = useCallback(() => {
    setStrip(null);
    void window.electronAPI.maker.recap.dismiss(sessionId).catch(() => {});
  }, [sessionId]);

  if (!strip) return null;

  return (
    <div
      role="status"
      aria-label="Where you left off"
      data-recap-strip=""
      className="mx-3 mb-1.5 flex items-start gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2"
    >
      <span aria-hidden="true" className="mt-px shrink-0 text-13 text-[var(--text-tertiary)]">↩</span>
      <p className="min-w-0 flex-1 text-12 leading-[1.45] text-[var(--text-secondary)]">
        {strip.text}
        <span className="ml-1.5 whitespace-nowrap text-11 text-[var(--text-tertiary)]">
          · {strip.routeName || strip.provider}/{strip.model}
        </span>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss recap"
        className="shrink-0 rounded px-1 text-13 leading-none text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
      >
        ✕
      </button>
    </div>
  );
}