import { describe, expect, it } from 'vitest';

import { buildTurnTimeline } from '../turn-timeline';

const TURN_STARTED_AT = 1_000_000;

describe('buildTurnTimeline', () => {
  it('marks the exact two-minute boundary as long-running', () => {
    expect(buildTurnTimeline({
      turnStartedAt: TURN_STARTED_AT,
      now: TURN_STARTED_AT + 119_999,
      state: 'running',
      toolEvents: [],
    })).toMatchObject({
      state: 'running',
      elapsedMs: 119_999,
      isLongRunning: false,
      spans: [],
    });

    expect(buildTurnTimeline({
      turnStartedAt: TURN_STARTED_AT,
      now: TURN_STARTED_AT + 120_000,
      state: 'running',
      toolEvents: [],
    })).toMatchObject({
      state: 'running',
      elapsedMs: 120_000,
      isLongRunning: true,
      spans: [],
    });
  });

  it('orders spans by start time, keeps completed durations and identifies the newest active span', () => {
    const timeline = buildTurnTimeline({
      turnStartedAt: TURN_STARTED_AT,
      now: TURN_STARTED_AT + 10_500,
      state: 'cancelling',
      toolEvents: [
        { kind: 'completed', toolUseId: 'read', at: TURN_STARTED_AT + 5_000 },
        { kind: 'started', toolUseId: 'curl', toolName: 'curl', at: TURN_STARTED_AT + 7_000 },
        { kind: 'started', toolUseId: 'write', toolName: 'write', at: TURN_STARTED_AT + 4_000 },
        { kind: 'started', toolUseId: 'read', toolName: 'read', at: TURN_STARTED_AT + 3_000 },
        { kind: 'started', toolUseId: 'search', toolName: 'search', at: TURN_STARTED_AT + 6_000 },
      ],
    });

    expect(timeline.state).toBe('cancelling');
    expect(timeline.activeToolUseId).toBe('curl');
    expect(timeline.spans).toEqual([
      { toolUseId: 'read', toolName: 'read', startedAt: TURN_STARTED_AT + 3_000, completedAt: TURN_STARTED_AT + 5_000, durationMs: 2_000, state: 'completed' },
      { toolUseId: 'write', toolName: 'write', startedAt: TURN_STARTED_AT + 4_000, durationMs: 6_500, state: 'running' },
      { toolUseId: 'search', toolName: 'search', startedAt: TURN_STARTED_AT + 6_000, durationMs: 4_500, state: 'running' },
      { toolUseId: 'curl', toolName: 'curl', startedAt: TURN_STARTED_AT + 7_000, durationMs: 3_500, state: 'running' },
    ]);
  });

  it('ignores blank, uncorrelated and duplicate events without exposing negative elapsed time', () => {
    const timeline = buildTurnTimeline({
      turnStartedAt: TURN_STARTED_AT,
      now: TURN_STARTED_AT - 1,
      state: 'cancelled',
      toolEvents: [
        { kind: 'completed', toolUseId: 'orphan', at: TURN_STARTED_AT + 200 },
        { kind: 'started', toolUseId: '', toolName: 'ignored', at: TURN_STARTED_AT + 300 },
        { kind: 'started', toolUseId: 'once', toolName: 'first name wins', at: TURN_STARTED_AT + 400 },
        { kind: 'started', toolUseId: 'once', toolName: 'duplicate', at: TURN_STARTED_AT + 500 },
      ],
    });

    expect(timeline).toMatchObject({
      state: 'cancelled',
      elapsedMs: 0,
      isLongRunning: false,
      activeToolUseId: 'once',
      spans: [{
        toolUseId: 'once',
        toolName: 'first name wins',
        startedAt: TURN_STARTED_AT + 400,
        durationMs: 0,
        state: 'running',
      }],
    });
  });
});
