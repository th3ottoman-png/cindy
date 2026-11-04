import { describe, expect, it } from 'vitest';
import { buildTurnTimeline } from '@cindy/maker-core/turn-timeline';

import {
  deriveTurnTimelineState,
  formatDuration,
  formatElapsed,
  INITIAL_TURN_FRAME,
  normaliseToolTimelineEvents,
  projectTurnTimeline,
  type TimelineMessage,
  type TurnStateSnapshot,
} from '@/features/cc-agent/turn-timeline-adapter';

const START = 1_700_000_000_000;
const iso = (at: number) => new Date(at).toISOString();

const snapshot = (overrides: Partial<TurnStateSnapshot> = {}): TurnStateSnapshot => ({
  isRunning: true,
  startedAt: START,
  turnStoppedByUser: false,
  hasError: false,
  messages: [],
  ...overrides,
});

describe('normaliseToolTimelineEvents', () => {
  it('maps tool_use and tool_result bubbles to normalised events', () => {
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'a', toolName: 'read_file', createdAt: iso(START + 100) },
      { role: 'tool_result', toolUseId: 'a', createdAt: iso(START + 350) },
      { role: 'tool_use', toolUseId: 'b', createdAt: iso(START + 400) },
    ];
    expect(normaliseToolTimelineEvents(messages, START)).toEqual([
      { kind: 'started', toolUseId: 'a', toolName: 'read_file', at: START + 100 },
      { kind: 'completed', toolUseId: 'a', at: START + 350 },
      { kind: 'started', toolUseId: 'b', toolName: 'tool', at: START + 400 },
    ]);
  });

  it('ignores other roles, blank ids and invalid or missing timestamps', () => {
    const messages: TimelineMessage[] = [
      { role: 'user', toolUseId: 'x', createdAt: iso(START) },
      { role: 'assistant', toolUseId: 'x', createdAt: iso(START) },
      { role: 'tool_use', toolUseId: '  ', createdAt: iso(START) },
      { role: 'tool_result', createdAt: iso(START) },
      { role: 'tool_use', toolUseId: 'no-time' },
      { role: 'tool_use', toolUseId: 'bad-time', createdAt: 'not-a-date' },
    ];
    expect(normaliseToolTimelineEvents(messages, START)).toEqual([]);
  });

  it('drops messages outside the 2 s grace and clamps early ones to the turn start', () => {
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'old', createdAt: iso(START - 2_001) },
      { role: 'tool_use', toolUseId: 'early', createdAt: iso(START - 1_500) },
    ];
    expect(normaliseToolTimelineEvents(messages, START)).toEqual([
      { kind: 'started', toolUseId: 'early', toolName: 'tool', at: START },
    ]);
  });

  it('does not mutate the input and keeps array order for equal timestamps', () => {
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'first', createdAt: iso(START) },
      { role: 'tool_use', toolUseId: 'second', createdAt: iso(START) },
    ];
    const before = JSON.stringify(messages);
    const events = normaliseToolTimelineEvents(messages, START);
    expect(events.map((event) => event.toolUseId)).toEqual(['first', 'second']);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('closes secondary tools of a merged result by adjacency', () => {
    // The store keeps only the primary id of a merged toolUseIds[] result.
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'a', toolName: 'read_file', createdAt: iso(START + 100) },
      { role: 'tool_use', toolUseId: 'b', toolName: 'read_file', createdAt: iso(START + 150) },
      { role: 'tool_result', toolUseId: 'a', createdAt: iso(START + 300) },
    ];
    const events = normaliseToolTimelineEvents(messages, START);
    expect(events.filter((event) => event.kind === 'completed').map((event) => event.toolUseId).sort()).toEqual(['a', 'b']);
    const timeline = buildTurnTimeline({
      turnStartedAt: START,
      now: START + 1_000,
      state: 'running',
      toolEvents: events,
    });
    expect(timeline.spans.every((span) => span.state === 'completed')).toBe(true);
    expect(timeline.activeToolUseId).toBeUndefined();
  });

  it('closes an id-less result by adjacency and ignores an orphan result', () => {
    const withAdjacent: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'a', toolName: 'write_file', createdAt: iso(START + 100) },
      { role: 'tool_result', createdAt: iso(START + 400) },
    ];
    expect(normaliseToolTimelineEvents(withAdjacent, START)).toEqual([
      { kind: 'started', toolUseId: 'a', toolName: 'write_file', at: START + 100 },
      { kind: 'completed', toolUseId: 'a', at: START + 400 },
    ]);

    const orphan: TimelineMessage[] = [
      { role: 'assistant', createdAt: iso(START) },
      { role: 'tool_result', toolUseId: 'orphan', createdAt: iso(START + 100) },
    ];
    const events = normaliseToolTimelineEvents(orphan, START);
    const timeline = buildTurnTimeline({
      turnStartedAt: START,
      now: START + 1_000,
      state: 'running',
      toolEvents: events,
    });
    expect(timeline.spans).toEqual([]);
  });

  it('honours an explicit lower bound so a rapid next turn cannot inherit old bubbles', () => {
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'old', createdAt: iso(START - 500) },
      { role: 'tool_use', toolUseId: 'new', createdAt: iso(START + 100) },
    ];
    expect(
      normaliseToolTimelineEvents(messages, START, { from: START })
        .map((event) => event.toolUseId),
    ).toEqual(['new']);
  });

  it('honours the frozen upper bound so late results cannot close a frozen span', () => {
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'a', createdAt: iso(START + 100) },
      { role: 'tool_result', toolUseId: 'a', createdAt: iso(START + 900) },
    ];
    expect(normaliseToolTimelineEvents(messages, START, { to: START + 500 })).toEqual([
      { kind: 'started', toolUseId: 'a', toolName: 'tool', at: START + 100 },
    ]);
  });
});

describe('deriveTurnTimelineState', () => {
  it('declares every state and keeps the intended precedence', () => {
    expect(deriveTurnTimelineState({ isRunning: true, turnStoppedByUser: false, cancelRequested: false, hasError: false })).toBe('running');
    expect(deriveTurnTimelineState({ isRunning: true, turnStoppedByUser: false, cancelRequested: true, hasError: false })).toBe('cancelling');
    expect(deriveTurnTimelineState({ isRunning: false, turnStoppedByUser: true, cancelRequested: true, hasError: true })).toBe('cancelled');
    expect(deriveTurnTimelineState({ isRunning: false, turnStoppedByUser: false, cancelRequested: false, hasError: true })).toBe('failed');
    expect(deriveTurnTimelineState({ isRunning: false, turnStoppedByUser: false, cancelRequested: false, hasError: false })).toBe('completed');
  });
});

describe('projectTurnTimeline', () => {
  it('returns no timeline until a turn start is observed', () => {
    const result = projectTurnTimeline(
      INITIAL_TURN_FRAME,
      snapshot({ startedAt: null, isRunning: false }),
      START + 5_000,
    );
    expect(result.timeline).toBeNull();
    expect(result.frame.turnStartedAt).toBeNull();
  });

  it('resets the retained frame when a new turn starts', () => {
    const retained = { turnStartedAt: START - 10_000, frozenNow: START, cancelRequested: true };
    const result = projectTurnTimeline(retained, snapshot(), START + 1_000);
    expect(result.frame).toEqual({
      turnStartedAt: START,
      frozenNow: null,
      cancelRequested: false,
      eventsFrom: START + 1,
    });
    expect(result.timeline?.elapsedMs).toBe(1_000);
  });

  it('advances the clock while running and freezes it once the turn ends', () => {
    const first = projectTurnTimeline(INITIAL_TURN_FRAME, snapshot(), START + 30_000);
    expect(first.timeline?.elapsedMs).toBe(30_000);
    const stopped = projectTurnTimeline(
      first.frame,
      snapshot({ isRunning: false, startedAt: null, turnStoppedByUser: true }),
      START + 31_000,
    );
    expect(stopped.timeline?.elapsedMs).toBe(31_000);
    expect(stopped.timeline?.state).toBe('cancelled');
    const later = projectTurnTimeline(
      stopped.frame,
      snapshot({ isRunning: false, startedAt: null, turnStoppedByUser: true }),
      START + 900_000,
    );
    expect(later.timeline?.elapsedMs).toBe(31_000);
  });

  it('uses the inclusive 120,000 ms default and honours an override', () => {
    const before = projectTurnTimeline(INITIAL_TURN_FRAME, snapshot(), START + 119_999);
    expect(before.timeline?.isLongRunning).toBe(false);
    const at = projectTurnTimeline(INITIAL_TURN_FRAME, snapshot(), START + 120_000);
    expect(at.timeline?.isLongRunning).toBe(true);
    const overridden = projectTurnTimeline(INITIAL_TURN_FRAME, snapshot(), START + 500, 500);
    expect(overridden.timeline?.isLongRunning).toBe(true);
  });

  it('correlates tool spans by id and reports the active tool', () => {
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'a', toolName: 'read_file', createdAt: iso(START + 100) },
      { role: 'tool_result', toolUseId: 'a', createdAt: iso(START + 400) },
      { role: 'tool_use', toolUseId: 'b', toolName: 'write_file', createdAt: iso(START + 600) },
    ];
    const result = projectTurnTimeline(
      INITIAL_TURN_FRAME,
      snapshot({ messages }),
      START + 2_600,
    );
    expect(result.timeline?.spans).toEqual([
      { toolUseId: 'a', toolName: 'read_file', startedAt: START + 100, completedAt: START + 400, durationMs: 300, state: 'completed' },
      { toolUseId: 'b', toolName: 'write_file', startedAt: START + 600, durationMs: 2_000, state: 'running' },
    ]);
    expect(result.timeline?.activeToolUseId).toBe('b');
  });

  it('scopes a second turn to after the previous turn ended', () => {
    const firstMessages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'old', toolName: 'read_file', createdAt: iso(START + 100) },
      { role: 'tool_result', toolUseId: 'old', createdAt: iso(START + 200) },
    ];
    const first = projectTurnTimeline(
      INITIAL_TURN_FRAME,
      snapshot({ messages: firstMessages }),
      START + 1_000,
    );
    const ended = projectTurnTimeline(
      first.frame,
      snapshot({ isRunning: false, startedAt: null }),
      START + 1_100,
    );
    const secondStart = START + 1_200; // less than 2 s after the previous turn ended
    const second = projectTurnTimeline(
      ended.frame,
      snapshot({ startedAt: secondStart, messages: firstMessages }),
      secondStart + 500,
    );
    expect(second.frame.eventsFrom).toBe(START + 1_101);
    expect(second.timeline?.spans).toEqual([]);
  });

  it('does not let a late result mutate a frozen terminal timeline', () => {
    const messages: TimelineMessage[] = [
      { role: 'tool_use', toolUseId: 'a', toolName: 'read_file', createdAt: iso(START + 100) },
    ];
    const running = projectTurnTimeline(INITIAL_TURN_FRAME, snapshot({ messages }), START + 5_000);
    const ended = projectTurnTimeline(
      running.frame,
      snapshot({ isRunning: false, startedAt: null, messages }),
      START + 6_000,
    );
    expect(ended.timeline?.spans[0].state).toBe('running');
    const withLateResult = projectTurnTimeline(
      ended.frame,
      snapshot({
        isRunning: false,
        startedAt: null,
        messages: [
          ...messages,
          { role: 'tool_result', toolUseId: 'a', createdAt: iso(START + 9_000) },
        ],
      }),
      START + 10_000,
    );
    expect(withLateResult.timeline?.spans[0].state).toBe('running');
    expect(withLateResult.timeline?.elapsedMs).toBe(6_000);
  });

  it('declares cancelling, failed and completed terminal states', () => {
    const frame = { turnStartedAt: START, frozenNow: null, cancelRequested: false };
    const cancelling = projectTurnTimeline(
      { ...frame, cancelRequested: true },
      snapshot(),
      START + 1_000,
    );
    expect(cancelling.timeline?.state).toBe('cancelling');
    const failed = projectTurnTimeline(
      frame,
      snapshot({ isRunning: false, startedAt: null, hasError: true }),
      START + 1_000,
    );
    expect(failed.timeline?.state).toBe('failed');
    const completed = projectTurnTimeline(
      frame,
      snapshot({ isRunning: false, startedAt: null }),
      START + 1_000,
    );
    expect(completed.timeline?.state).toBe('completed');
  });

  it('never mutates the frame it was given', () => {
    const frame = { turnStartedAt: START, frozenNow: null, cancelRequested: false };
    const before = JSON.stringify(frame);
    projectTurnTimeline(frame, snapshot({ isRunning: false, startedAt: null }), START + 1_000);
    expect(JSON.stringify(frame)).toBe(before);
  });
});

describe('formatters', () => {
  it('formats elapsed time as mm:ss without capping minutes', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(999)).toBe('00:00');
    expect(formatElapsed(61_000)).toBe('01:01');
    expect(formatElapsed(7_503_000)).toBe('125:03');
    expect(formatElapsed(-5)).toBe('00:00');
  });

  it('formats tool durations in ms, seconds, or minutes', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(1_000)).toBe('1.0s');
    expect(formatDuration(59_999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(72_400)).toBe('1m 12s');
    expect(formatDuration(-10)).toBe('0ms');
  });
});
