import { describe, expect, it } from 'vitest';

import {
  buildOperationsRail,
  formatRelative,
  hasRunningOperation,
  operationRailSummary,
  type OperationsInput,
} from '../operations-rail';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function input(overrides: Partial<OperationsInput> = {}): OperationsInput {
  return { nowMs: NOW, ...overrides };
}

describe('formatRelative', () => {
  it('says now inside a minute', () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe('now');
    expect(formatRelative(NOW + 10_000, NOW)).toBe('now');
  });

  it('counts minutes, hours and days in the past', () => {
    expect(formatRelative(NOW - 5 * MINUTE, NOW)).toBe('5m ago');
    expect(formatRelative(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(formatRelative(NOW - 2 * DAY, NOW)).toBe('2d ago');
  });

  it('counts forward for a next run', () => {
    expect(formatRelative(NOW + 2 * HOUR, NOW)).toBe('in 2h');
  });

  it('is empty for an unknown time', () => {
    expect(formatRelative(null, NOW)).toBe('');
    expect(formatRelative(Number.NaN, NOW)).toBe('');
  });
});

describe('buildOperationsRail', () => {
  it('marks a streaming turn as running with cancel and open', () => {
    const rows = buildOperationsRail(
      input({ turns: [{ id: 's1', title: 'Refactor pass', streaming: true, lastOutput: 'Editing' }] }),
    );
    expect(rows[0]).toMatchObject({
      kind: 'turn',
      status: 'running',
      actions: ['cancel', 'open'],
      detail: 'Editing',
    });
  });

  it('offers only open for an idle turn', () => {
    const rows = buildOperationsRail(input({ turns: [{ id: 's1', title: 'Done', streaming: false }] }));
    expect(rows[0].status).toBe('idle');
    expect(rows[0].actions).toEqual(['open']);
    expect(rows[0].detail).toBe('No output yet');
  });

  it('maps worker status', () => {
    const rows = buildOperationsRail(
      input({
        workers: [
          { id: 'w1', title: 'Worker A', status: 'active' },
          { id: 'w2', title: 'Worker B', status: 'failed', lastOutput: 'boom' },
          { id: 'w3', title: 'Worker C', status: 'idle' },
        ],
      }),
    );
    expect(rows.map((row) => row.status)).toEqual(['running', 'failed', 'idle']);
    expect(rows[1].detail).toBe('boom');
  });

  it('maps bot availability', () => {
    const rows = buildOperationsRail(
      input({
        bots: [
          { id: 'b1', title: 'Ready bot', availability: 'ready' },
          { id: 'b2', title: 'Broken bot', availability: 'unavailable' },
          { id: 'b3', title: 'Unknown bot' },
        ],
      }),
    );
    // A failed bot outranks a healthy one, which is the point of the rail.
    expect(rows.map((row) => row.status)).toEqual(['failed', 'success', 'unknown']);
    expect(rows[2].detail).toBe('Availability unknown');
  });

  it('describes a successful schedule with its note', () => {
    const rows = buildOperationsRail(
      input({
        schedules: [
          {
            id: 'daily-review',
            title: 'Daily review',
            enabled: true,
            lastStatus: 'success',
            lastRunMs: NOW - 2 * HOUR,
            nextRunMs: NOW + 22 * HOUR,
            notePath: 'schedules/daily-review-2026-11-08.md',
          },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({
      kind: 'schedule',
      status: 'success',
      actions: ['run-now', 'open'],
      atMs: NOW - 2 * HOUR,
    });
    expect(rows[0].detail).toContain('schedules/daily-review-2026-11-08.md');
  });

  it('marks a never-run schedule as scheduled and a disabled one as idle', () => {
    const rows = buildOperationsRail(
      input({
        schedules: [
          { id: 'a', title: 'A', enabled: true, nextRunMs: NOW + HOUR },
          { id: 'b', title: 'B', enabled: false },
        ],
      }),
    );
    const a = rows.find((row) => row.id === 'a');
    const b = rows.find((row) => row.id === 'b');
    expect(a?.status).toBe('scheduled');
    expect(a?.detail).toContain('next in 1h');
    expect(b?.status).toBe('idle');
    expect(b?.actions).toEqual(['open']);
    expect(b?.detail).toContain('disabled');
  });

  it('reports a failed schedule run', () => {
    const rows = buildOperationsRail(
      input({
        schedules: [
          { id: 'x', title: 'X', enabled: true, lastStatus: 'failed', lastRunMs: NOW - DAY },
        ],
      }),
    );
    expect(rows[0].status).toBe('failed');
  });

  it('orders running, then failed, then scheduled, then the rest', () => {
    const rows = buildOperationsRail(
      input({
        turns: [{ id: 't1', title: 'Turn', streaming: false }],
        workers: [{ id: 'w1', title: 'Worker', status: 'failed' }],
        bots: [{ id: 'b1', title: 'Bot', availability: 'ready' }],
        schedules: [
          { id: 's1', title: 'Sched', enabled: true, nextRunMs: NOW + HOUR },
          { id: 's2', title: 'Running sched', enabled: true, lastStatus: 'success', lastRunMs: NOW },
        ],
      }),
    );
    // Failed worker first, then scheduled work, then the successes and idle
    // rows, newest event first inside that last group.
    expect(rows.map((row) => row.id)).toEqual(['w1', 's1', 's2', 't1', 'b1']);
  });

  it('returns an empty rail for no facts', () => {
    expect(buildOperationsRail(input())).toEqual([]);
  });

  it('truncates a long output line', () => {
    const rows = buildOperationsRail(
      input({ turns: [{ id: 't', title: 'T', streaming: true, lastOutput: 'x'.repeat(400) }] }),
    );
    expect(rows[0].detail.length).toBe(160);
    expect(rows[0].detail.endsWith('...')).toBe(true);
  });
});

describe('summary helpers', () => {
  const rows = buildOperationsRail(
    input({
      turns: [{ id: 't', title: 'T', streaming: true }],
      workers: [{ id: 'w', title: 'W', status: 'active' }],
      schedules: [{ id: 's', title: 'S', enabled: true, lastStatus: 'success', lastRunMs: NOW }],
    }),
  );

  it('counts per kind in display order', () => {
    expect(operationRailSummary(rows)).toEqual([
      { kind: 'turn', count: 1, running: 1 },
      { kind: 'worker', count: 1, running: 1 },
      { kind: 'schedule', count: 1, running: 0 },
    ]);
  });

  it('knows when something is running', () => {
    expect(hasRunningOperation(rows)).toBe(true);
    expect(hasRunningOperation([])).toBe(false);
    expect(
      hasRunningOperation(
        buildOperationsRail(input({ turns: [{ id: 't', title: 'T', streaming: false }] })),
      ),
    ).toBe(false);
  });
});
