/**
 * Renderer adapter between `makerChatStore` and the pure 5.3a turn timeline
 * model (ROADMAP 5.3b).
 *
 * The store does not keep a timeline. It stamps `createdAt` on each tool_use /
 * tool_result message bubble when the reducer sees the event, and stamps
 * `agentStatus.startedAt` from a separate status IPC event. Both are renderer
 * clock values, so tool durations here are approximate, not SDK timings. This
 * module owns no clock and no subscription: the caller supplies `now`.
 */

import {
  buildTurnTimeline,
  type ToolTimelineEvent,
  type TurnTimeline,
  type TurnTimelineState,
} from '@cindy/maker-core/turn-timeline';

/** The only message fields this adapter reads. Structural, so `ChatMessage` fits. */
export interface TimelineMessage {
  role: string;
  toolUseId?: string;
  toolName?: string;
  createdAt?: string;
}

export interface TurnStateSnapshot {
  isRunning: boolean;
  startedAt: number | null;
  turnStoppedByUser: boolean;
  hasError: boolean;
  messages: readonly TimelineMessage[];
}

/** State retained across renderer ticks. Never mutated in place. */
export interface TurnFrame {
  turnStartedAt: number | null;
  frozenNow: number | null;
  cancelRequested: boolean;
  /** Lower bound on tool-bubble timestamps for this turn. */
  eventsFrom?: number;
}

export const INITIAL_TURN_FRAME: TurnFrame = {
  turnStartedAt: null,
  frozenNow: null,
  cancelRequested: false,
};

/**
 * A status event can arrive just after the first tool_use reducer ran, so a
 * small grace window keeps those spans. Everything is clamped to the turn
 * start so no span can appear to predate its turn.
 */
const TOOL_EVENT_GRACE_MS = 2_000;

/** Bounds applied to bubble timestamps when normalising one turn's events. */
export interface ToolEventWindow {
  /** Exclude bubbles stamped before this epoch (previous-turn scoping). */
  from?: number;
  /** Exclude bubbles stamped after this epoch (the frozen clock at turn end). */
  to?: number;
}

function nonBlank(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Map store message bubbles to the normalised, timestamped events that
 * `buildTurnTimeline` consumes. Duplicate ids, unmatched completions and
 * ordering are the pure model's job, not this adapter's.
 *
 * A merged `tool_result` carries only the PRIMARY `toolUseId` (the store drops
 * the rest of `toolUseIds[]`), and an orphan result can carry none at all. The
 * house rule in `packages/maker-shared/src/messageNormalize.ts` settles the
 * secondary tools by adjacency: a result closes the consecutive block of
 * `tool_use` bubbles immediately before it. Without that, finished tools would
 * stay `running` forever and `activeToolUseId` would point at a finished tool.
 */
export function normaliseToolTimelineEvents(
  messages: readonly TimelineMessage[],
  turnStartedAt: number,
  window: ToolEventWindow = {},
): ToolTimelineEvent[] {
  const from = window.from ?? turnStartedAt - TOOL_EVENT_GRACE_MS;
  const to = window.to ?? Number.POSITIVE_INFINITY;
  const events: ToolTimelineEvent[] = [];
  const startedAtById = new Map<string, number>();
  const completedIds = new Set<string>();

  const inWindow = (message: TimelineMessage): number | null => {
    if (!message.createdAt) return null;
    const parsed = Date.parse(message.createdAt);
    if (!Number.isFinite(parsed) || parsed < from || parsed > to) return null;
    const clamped = Math.max(parsed, turnStartedAt);
    return Number.isFinite(to) ? Math.min(clamped, to) : clamped;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'tool_use') {
      const at = inWindow(message);
      const id = nonBlank(message.toolUseId);
      if (at === null || id === null) continue;
      events.push({
        kind: 'started',
        toolUseId: id,
        toolName: message.toolName ?? 'tool',
        at,
      });
      if (!startedAtById.has(id)) startedAtById.set(id, at);
      continue;
    }
    if (message.role !== 'tool_result') continue;

    const at = inWindow(message);
    if (at === null) continue;
    const ids = new Set<string>();
    const own = nonBlank(message.toolUseId);
    if (own) ids.add(own);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role !== 'tool_use') break;
      const adjacent = nonBlank(messages[cursor].toolUseId);
      if (adjacent) ids.add(adjacent);
    }
    for (const id of ids) {
      if (completedIds.has(id)) continue;
      completedIds.add(id);
      // A completion can never precede its own start once the pure model sorts
      // the events by timestamp.
      events.push({
        kind: 'completed',
        toolUseId: id,
        at: Math.max(at, startedAtById.get(id) ?? at),
      });
    }
  }
  return events;
}

/**
 * The state is declared, never derived from persisted rows: a cancelled Hermes
 * turn is still persisted with `turnCompleted: true` (ROADMAP Debt), so the
 * store's `turnStoppedByUser` flag is the only trustworthy signal.
 */
export function deriveTurnTimelineState(input: {
  isRunning: boolean;
  turnStoppedByUser: boolean;
  cancelRequested: boolean;
  hasError: boolean;
}): TurnTimelineState {
  if (input.cancelRequested && input.isRunning) return 'cancelling';
  if (input.isRunning) return 'running';
  if (input.turnStoppedByUser) return 'cancelled';
  if (input.hasError) return 'failed';
  return 'completed';
}

/**
 * Fold one fresh store snapshot into the retained frame and build the display
 * timeline. A new `startedAt` resets the turn. Once the turn ends the clock is
 * frozen, so a long-running turn stays visible in its terminal state until the
 * next turn starts and late results cannot mutate its spans.
 */
export function projectTurnTimeline(
  frame: TurnFrame,
  snapshot: TurnStateSnapshot,
  now: number,
  longRunningAfterMs?: number,
): { frame: TurnFrame; timeline: TurnTimeline | null } {
  const next: TurnFrame = {
    turnStartedAt: frame.turnStartedAt,
    frozenNow: frame.frozenNow,
    cancelRequested: frame.cancelRequested,
    ...(frame.eventsFrom === undefined ? {} : { eventsFrom: frame.eventsFrom }),
  };

  if (snapshot.startedAt != null && snapshot.startedAt !== next.turnStartedAt) {
    // The previous turn's frozen clock is the lower bound for this turn's
    // bubbles. Without it a rapid second turn could inherit trailing tool
    // bubbles from the first one through the 2 s grace window.
    const previousEnd = frame.frozenNow;
    next.turnStartedAt = snapshot.startedAt;
    next.frozenNow = null;
    next.cancelRequested = false;
    next.eventsFrom = Math.max(
      snapshot.startedAt - TOOL_EVENT_GRACE_MS,
      previousEnd == null ? Number.NEGATIVE_INFINITY : previousEnd + 1,
    );
  }
  if (next.turnStartedAt == null) return { frame: next, timeline: null };

  let effectiveNow: number;
  if (snapshot.isRunning) {
    next.frozenNow = null;
    effectiveNow = now;
  } else {
    if (next.frozenNow == null) next.frozenNow = now;
    effectiveNow = next.frozenNow;
  }
  effectiveNow = Math.max(effectiveNow, next.turnStartedAt);

  const state = deriveTurnTimelineState({
    isRunning: snapshot.isRunning,
    turnStoppedByUser: snapshot.turnStoppedByUser,
    cancelRequested: next.cancelRequested,
    hasError: snapshot.hasError,
  });
  const toolEvents = normaliseToolTimelineEvents(snapshot.messages, next.turnStartedAt, {
    from: next.eventsFrom,
    to: effectiveNow,
  });
  const timeline = buildTurnTimeline({
    turnStartedAt: next.turnStartedAt,
    now: effectiveNow,
    state,
    toolEvents,
    ...(longRunningAfterMs === undefined ? {} : { longRunningAfterMs }),
  });
  return { frame: next, timeline };
}

/** Elapsed turn time as `mm:ss`. Minutes are not capped at 59. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Compact per-tool duration for the timeline rows. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1_000) return `${Math.floor(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export const TURN_TIMELINE_STATE_LABELS: Record<TurnTimelineState, string> = {
  running: 'Running',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
};
