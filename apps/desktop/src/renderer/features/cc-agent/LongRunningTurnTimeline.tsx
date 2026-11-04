import { useCallback, useEffect, useRef, useState } from 'react';
import type { TurnTimeline } from '@cindy/maker-core/turn-timeline';

import { Button } from '@/components/ui/button';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  formatDuration,
  formatElapsed,
  INITIAL_TURN_FRAME,
  projectTurnTimeline,
  TURN_TIMELINE_STATE_LABELS,
  type TimelineMessage,
  type TurnFrame,
  type TurnStateSnapshot,
} from './turn-timeline-adapter';

/** Pure view. English-only by decision (AGENTS.md §2), so no i18n keys. */
export function LongRunningTurnTimelineView({
  timeline,
  onCancel,
  style,
  className,
}: {
  timeline: TurnTimeline;
  onCancel: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  const completed = timeline.spans.filter((span) => span.state === 'completed').length;
  const canCancel = timeline.state === 'running';

  return (
    <div
      data-testid="long-running-turn-timeline"
      data-state={timeline.state}
      data-elapsed-ms={String(timeline.elapsedMs)}
      data-long-running={timeline.isLongRunning ? 'true' : 'false'}
      className={className ?? 'mx-1 shrink-0'}
      style={style ?? WINDOW_NO_DRAG_STYLE}
    >
      <div className="border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-[var(--text-primary)]">Long-running turn</span>
            <span
              data-testid="long-running-turn-elapsed"
              className="tabular-nums text-[var(--text-secondary)]"
            >
              {formatElapsed(timeline.elapsedMs)}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            compact
            variant="secondary"
            disabled={!canCancel}
            data-testid="long-running-turn-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
        <div
          data-testid="long-running-turn-summary"
          className="mt-1 text-[var(--text-tertiary)]"
        >
          {TURN_TIMELINE_STATE_LABELS[timeline.state]} · {timeline.spans.length}{' '}
          {timeline.spans.length === 1 ? 'tool call' : 'tool calls'} · {completed} done
        </div>
        {timeline.spans.length > 0 && (
          <ul
            data-testid="long-running-turn-spans"
            className="mt-1.5 space-y-0.5 border-t border-[var(--border-default)] pt-1.5"
          >
            {timeline.spans.map((span) => (
              <li
                key={span.toolUseId}
                data-testid={`tool-timeline-span-${span.toolUseId}`}
                data-span-state={span.state}
                data-duration-ms={String(span.durationMs)}
                className="flex items-center justify-between gap-2 tabular-nums"
              >
                <span className="truncate text-[var(--text-secondary)]">
                  {span.toolName}
                  {timeline.activeToolUseId === span.toolUseId ? ' (active)' : ''}
                </span>
                <span className="shrink-0 text-[var(--text-tertiary)]">
                  {formatDuration(span.durationMs)} · {span.state}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * ROADMAP 5.3b container. Reads `makerChatStore` once a second instead of
 * subscribing to the streaming pipe: a tool timeline only needs 1 s resolution,
 * and the store notifies on every token delta. Nothing here writes to the store,
 * changes the chat loop, or adds an IPC channel.
 *
 * The panel appears once a turn crosses `DEFAULT_LONG_RUNNING_AFTER_MS` (120 s)
 * and stays in its terminal state until the next turn starts, so a cancel is
 * observable. `longRunningAfterMs` is exposed for component tests only; the
 * production mount uses the default.
 */
export function LongRunningTurnTimeline({
  sessionId,
  onCancel,
  longRunningAfterMs,
  style,
  className,
}: {
  sessionId: string;
  onCancel: () => void;
  longRunningAfterMs?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [view, setView] = useState<{ frame: TurnFrame; timeline: TurnTimeline | null }>({
    frame: INITIAL_TURN_FRAME,
    timeline: null,
  });
  // Guards against two clicks in the same frame. It resets when a new turn
  // starts, so the next long-running turn can be cancelled again.
  const cancelRequestedRef = useRef(false);
  useEffect(() => {
    cancelRequestedRef.current = false;
  }, [view.frame.turnStartedAt]);
  // If Stop was refused (for example a remote session that is unavailable),
  // the store stays running and the next tick resolves back to `running`.
  // Clear the guard so the user can try again instead of staring at a stuck
  // "Cancelling" label.
  useEffect(() => {
    if (view.timeline?.state === 'running' && cancelRequestedRef.current) {
      cancelRequestedRef.current = false;
    }
  }, [view.timeline?.state]);

  useEffect(() => {
    if (!sessionId) return undefined;
    const tick = () => {
      const snap = makerChatStore.getSnapshot(sessionId);
      const state: TurnStateSnapshot = {
        isRunning: snap.agentStatus.isRunning,
        startedAt: snap.agentStatus.startedAt,
        turnStoppedByUser: snap.turnStoppedByUser,
        hasError: Boolean(snap.error || snap.recoverableError),
        messages: snap.messages as readonly TimelineMessage[],
      };
      setView((prev) => {
        const next = projectTurnTimeline(prev.frame, state, Date.now(), longRunningAfterMs);
        if (next.timeline === null && prev.timeline === null) return prev;
        return next;
      });
    };
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [longRunningAfterMs, sessionId]);

  const handleCancel = useCallback(() => {
    if (cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    // `stopSession` flips the store optimistically, so the next 1 s tick would
    // jump straight to `cancelled`. Declare `cancelling` in this frame instead:
    // the button disables at once and the user gets immediate feedback while
    // the abort IPC is still in flight.
    setView((prev) =>
      prev.timeline
        ? { frame: prev.frame, timeline: { ...prev.timeline, state: 'cancelling' } }
        : prev,
    );
    onCancel();
  }, [onCancel]);

  if (!view.timeline || !view.timeline.isLongRunning) return null;

  return (
    <LongRunningTurnTimelineView
      timeline={view.timeline}
      onCancel={handleCancel}
      style={style}
      className={className}
    />
  );
}
