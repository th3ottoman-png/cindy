import { describe, expect, it, vi } from 'vitest';
import {
  OperationsRailHost,
  registerOperationsRailHandlers,
} from '../operationsRail.js';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels.js';

describe('OperationsRailHost (ROADMAP 8.6b)', () => {
  it('aggregates turns, workers, bots, and schedules into ordered rail rows', async () => {
    const broadcastMock = vi.fn();
    const host = new OperationsRailHost({
      getTurnFacts: async () => [
        {
          id: 'turn-1',
          title: 'Reviewing auth PR',
          streaming: true,
          lastOutput: 'Running git diff...',
          startedAtMs: 1000,
        },
      ],
      getWorkerFacts: async () => [
        {
          id: 'worker-1',
          title: 'Database migration worker',
          status: 'idle',
          lastOutput: 'Completed schema migration',
          atMs: 500,
        },
      ],
      getBotFacts: async () => [
        {
          id: 'bot-1',
          title: 'Telegram Alert Bot',
          availability: 'ready',
          atMs: 200,
        },
      ],
      broadcast: broadcastMock,
      now: () => 2000,
    });

    const result = await host.listOperations();

    expect(result.rows).toHaveLength(3);
    // Running turn ranks first
    expect(result.rows[0].id).toBe('turn-1');
    expect(result.rows[0].status).toBe('running');
    expect(result.rows[0].actions).toContain('cancel');
    expect(result.hasRunning).toBe(true);

    expect(result.summary).toEqual(
      expect.arrayContaining([
        { kind: 'turn', count: 1, running: 1 },
        { kind: 'worker', count: 1, running: 0 },
        { kind: 'bot', count: 1, running: 0 },
      ]),
    );
  });

  it('cancels active operations and broadcasts change event', async () => {
    const cancelTurnMock = vi.fn().mockResolvedValue({ ok: true });
    const broadcastMock = vi.fn();

    const host = new OperationsRailHost({
      onCancelTurn: cancelTurnMock,
      broadcast: broadcastMock,
    });

    const res = await host.cancelOperation('turn', 'session-123');
    expect(res.ok).toBe(true);
    expect(cancelTurnMock).toHaveBeenCalledWith('session-123');
    expect(broadcastMock).toHaveBeenCalledWith(MAKER_PUSH.OPERATIONS_CHANGED, {
      id: 'session-123',
      kind: 'turn',
      status: 'cancelled',
    });

    // Unsupported kind
    const unsupported = await host.cancelOperation('bot', 'bot-1');
    expect(unsupported.ok).toBe(false);
  });

  it('replays operations and broadcasts change event', async () => {
    const replayTurnMock = vi.fn().mockResolvedValue({ ok: true });
    const broadcastMock = vi.fn();

    const host = new OperationsRailHost({
      onReplayTurn: replayTurnMock,
      broadcast: broadcastMock,
    });

    const res = await host.replayOperation('turn', 'session-456');
    expect(res.ok).toBe(true);
    expect(replayTurnMock).toHaveBeenCalledWith('session-456');
    expect(broadcastMock).toHaveBeenCalledWith(MAKER_PUSH.OPERATIONS_CHANGED, {
      id: 'session-456',
      kind: 'turn',
      status: 'replaying',
    });
  });

  it('delegates schedule dry-run to scheduledSessionsHost', async () => {
    const dryRunMock = vi.fn().mockResolvedValue({
      status: 'success',
      at: 1000,
      notePath: 'Cindy/Research/test.md',
      dryRun: true,
      output: 'All tests passed',
    });
    const broadcastMock = vi.fn();

    const mockScheduledSessionsHost = {
      listSchedules: () => [],
      getState: () => ({ lastRunMs: {}, firstSeenMs: {} }),
      dryRunSchedule: dryRunMock,
    } as any;

    const host = new OperationsRailHost({
      scheduledSessionsHost: mockScheduledSessionsHost,
      broadcast: broadcastMock,
    });

    const result = await host.dryRunSchedule('nightly-test');
    expect(result.dryRun).toBe(true);
    expect(dryRunMock).toHaveBeenCalledWith('nightly-test');
    expect(broadcastMock).toHaveBeenCalledWith(MAKER_PUSH.OPERATIONS_CHANGED, {
      id: 'nightly-test',
      kind: 'schedule',
      result,
    });
  });

  it('registers IPC handlers for list, cancel, and replay', async () => {
    const registry = {
      handle: vi.fn(),
    };
    const host = new OperationsRailHost();
    const assertTrusted = vi.fn();

    registerOperationsRailHandlers(registry as any, {
      host,
      assertTrusted,
    });

    expect(registry.handle).toHaveBeenCalledWith(MAKER_INVOKE.OPERATIONS_LIST, expect.any(Function));
    expect(registry.handle).toHaveBeenCalledWith(MAKER_INVOKE.OPERATIONS_CANCEL, expect.any(Function));
    expect(registry.handle).toHaveBeenCalledWith(MAKER_INVOKE.OPERATIONS_REPLAY, expect.any(Function));
  });
});
