/**
 * Long-running task timeline model (ROADMAP 5.3a).
 *
 * This module turns normalised turn and tool timestamps into display-ready data. It owns no clock,
 * does not subscribe to an agent event stream and cannot cancel a turn. The desktop adapter and
 * renderer belong to 5.3b.
 */

export const DEFAULT_LONG_RUNNING_AFTER_MS = 120_000;

export type TurnTimelineState = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';

export type ToolTimelineEvent =
  | {
      kind: 'started';
      toolUseId: string;
      toolName: string;
      at: number;
    }
  | {
      kind: 'completed';
      toolUseId: string;
      at: number;
    };

export interface TurnTimelineInput {
  turnStartedAt: number;
  now: number;
  state: TurnTimelineState;
  toolEvents: readonly ToolTimelineEvent[];
  longRunningAfterMs?: number;
}

export interface ToolTimelineSpan {
  toolUseId: string;
  toolName: string;
  startedAt: number;
  completedAt?: number;
  durationMs: number;
  state: 'running' | 'completed';
}

export interface TurnTimeline {
  state: TurnTimelineState;
  elapsedMs: number;
  isLongRunning: boolean;
  spans: ToolTimelineSpan[];
  activeToolUseId?: string;
}

interface OpenSpan {
  toolUseId: string;
  toolName: string;
  startedAt: number;
  completedAt?: number;
  sequence: number;
}

function durationMs(startedAt: number, endedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, endedAt - startedAt);
}

function validId(value: string): boolean {
  return value.trim().length > 0;
}

function thresholdMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_LONG_RUNNING_AFTER_MS;
}

/**
 * Produces a stable timeline from individual normalised tool events. Events are ordered by their
 * timestamp before correlation, so a transport that delivers a later event first cannot reorder the
 * display. The first start for an id wins; only its matching first completion can close the span.
 */
export function buildTurnTimeline(input: TurnTimelineInput): TurnTimeline {
  const events = input.toolEvents
    .map((event, sequence) => ({ event, sequence }))
    .filter(({ event }) => Number.isFinite(event.at))
    .sort((a, b) => a.event.at - b.event.at || a.sequence - b.sequence);
  const byId = new Map<string, OpenSpan>();

  for (const { event, sequence } of events) {
    if (!validId(event.toolUseId)) continue;
    if (event.kind === 'started') {
      if (byId.has(event.toolUseId)) continue;
      byId.set(event.toolUseId, {
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        startedAt: event.at,
        sequence,
      });
      continue;
    }
    const span = byId.get(event.toolUseId);
    if (span && span.completedAt === undefined) span.completedAt = event.at;
  }

  const spans = [...byId.values()]
    .sort((a, b) => a.startedAt - b.startedAt || a.sequence - b.sequence)
    .map<ToolTimelineSpan>((span) => {
      const completedAt = span.completedAt;
      const endedAt = completedAt ?? input.now;
      return {
        toolUseId: span.toolUseId,
        toolName: span.toolName,
        startedAt: span.startedAt,
        ...(completedAt === undefined ? {} : { completedAt }),
        durationMs: durationMs(span.startedAt, endedAt),
        state: completedAt === undefined ? 'running' : 'completed',
      };
    });
  const active = spans.filter((span) => span.state === 'running').at(-1);
  const elapsedMs = durationMs(input.turnStartedAt, input.now);

  return {
    state: input.state,
    elapsedMs,
    isLongRunning: elapsedMs >= thresholdMs(input.longRunningAfterMs),
    spans,
    ...(active ? { activeToolUseId: active.toolUseId } : {}),
  };
}
