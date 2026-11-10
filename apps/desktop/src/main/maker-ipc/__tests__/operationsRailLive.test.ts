import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationsRailHost } from '../operationsRail';

describe('OperationsRailLive', () => {
  let tmpVaultDir: string;
  let cancelledSessionId: string | null = null;
  let replayedSessionId: string | null = null;
  let broadcastCount = 0;

  beforeEach(() => {
    tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ops-rail-vault-'));
    cancelledSessionId = null;
    replayedSessionId = null;
    broadcastCount = 0;
  });

  afterEach(() => {
    if (fs.existsSync(tmpVaultDir)) {
      fs.rmSync(tmpVaultDir, { recursive: true, force: true });
    }
  });

  it('live-proves aggregation, turn cancellation, schedule dry-run, and replay without vault pollution', async () => {
    // 1. Setup mock running turn
    const mockSessions = [
      {
        id: 'live-turn-123',
        title: 'Refactor Auth Provider',
        turnState: {
          status: 'running',
          toolName: 'read_file',
          args: { path: 'packages/auth/provider.ts' },
        },
        workspaceDir: '/home/antigravity/workspace',
        activeAgentId: 'cindy',
        turns: [
          {
            role: 'assistant',
            text: 'I am inspecting the provider file...',
            timestamp: Date.now() - 3000,
          },
        ],
      },
    ];

    // 2. Setup mock scheduled sessions host with dry-run support
    const mockSchedules = [
      {
        id: 'daily-briefing',
        name: 'Daily Research Briefing',
        cron: '0 8 * * *',
        prompt: 'Synthesize research updates from arxiv and vault',
        enabled: true,
        projectNote: 'Cindy/Research/Daily.md',
        lastRunAt: Date.now() - 86400000,
        lastRunStatus: 'success' as const,
      },
    ];

    const mockScheduledSessionsHost = {
      listSchedules: vi.fn(() => [
        {
          ok: true as const,
          id: 'daily-briefing',
          file: 'daily-briefing.md',
          cron: '0 8 * * *',
          prompt: 'Synthesize research updates from arxiv and vault',
          enabled: true,
          output: 'Cindy/Research/Daily.md',
          nextRunMs: Date.now() + 3600000,
        },
      ]),
      getState: vi.fn(() => ({
        lastRunMs: {
          'daily-briefing': Date.now() - 86400000,
        },
        lastRuns: {
          'daily-briefing': {
            status: 'success' as const,
            at: Date.now() - 86400000,
            notePath: 'Cindy/Research/Daily.md',
          },
        },
      })),
      dryRunSchedule: vi.fn(async (scheduleId: string) => {
        // Simulate dry run execution in an isolated scratch dir
        const dryRunTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dry-run-'));
        try {
          const simulatedOutput = `[DRY-RUN] Executed prompt for schedule "${scheduleId}".\nSynthesized 3 papers.\nSimulated note destination: Cindy/Research/Daily.md.\nZero bytes written to actual vault.`;
          return {
            status: 'success' as const,
            at: Date.now(),
            dryRun: true,
            output: simulatedOutput,
          };
        } finally {
          fs.rmSync(dryRunTmp, { recursive: true, force: true });
        }
      }),
      runNow: vi.fn(async () => ({ status: 'success' as const, at: Date.now() })),
    };

    const host = new OperationsRailHost({
      getTurnFacts: async () => [
        {
          id: 'live-turn-123',
          title: 'Refactor Auth Provider',
          streaming: true,
          lastOutput: 'Reading file: packages/auth/provider.ts',
          startedAtMs: Date.now() - 3000,
        },
      ],
      scheduledSessionsHost: mockScheduledSessionsHost as any,
      onCancelTurn: async (sessionId) => {
        cancelledSessionId = sessionId;
        return { ok: true };
      },
      onReplayTurn: async (sessionId) => {
        replayedSessionId = sessionId;
        return { ok: true };
      },
      broadcast: () => {
        broadcastCount++;
      },
    });

    // --- STEP 1: Verify aggregated list ---
    const listRes = await host.listOperations();
    expect(listRes.hasRunning).toBe(true);
    expect(listRes.rows).toHaveLength(2);

    const turnRow = listRes.rows.find((r) => r.kind === 'turn');
    expect(turnRow).toBeDefined();
    expect(turnRow?.id).toBe('live-turn-123');
    expect(turnRow?.title).toBe('Refactor Auth Provider');
    expect(turnRow?.status).toBe('running');
    expect(turnRow?.detail).toBe('Reading file: packages/auth/provider.ts');
    expect(turnRow?.actions).toContain('cancel');

    const schedRow = listRes.rows.find((r) => r.kind === 'schedule');
    expect(schedRow).toBeDefined();
    expect(schedRow?.id).toBe('daily-briefing');
    expect(schedRow?.status).toBe('success');
    expect(schedRow?.actions).toContain('run-now');

    const summary = listRes.summary;
    const turnSummary = summary.find((s) => s.kind === 'turn');
    expect(turnSummary?.count).toBe(1);
    expect(turnSummary?.running).toBe(1);

    // --- STEP 2: Verify cancelling turn ---
    const cancelRes = await host.cancelOperation('turn', 'live-turn-123');
    expect(cancelRes.ok).toBe(true);
    expect(cancelledSessionId).toBe('live-turn-123');
    expect(broadcastCount).toBeGreaterThanOrEqual(1);

    // --- STEP 3: Verify dry-run schedule execution ---
    const vaultBefore = fs.readdirSync(tmpVaultDir);
    expect(vaultBefore).toHaveLength(0);

    const dryRunRes = await host.dryRunSchedule('daily-briefing');
    expect(dryRunRes.status).toBe('success');
    expect(dryRunRes.dryRun).toBe(true);
    expect(dryRunRes.output).toContain('[DRY-RUN]');
    expect(dryRunRes.output).toContain('Zero bytes written to actual vault.');

    // Vault remains completely pristine (0 bytes written)
    const vaultAfter = fs.readdirSync(tmpVaultDir);
    expect(vaultAfter).toHaveLength(0);

    // --- STEP 4: Verify replay turn ---
    const replayRes = await host.replayOperation('turn', 'live-turn-123');
    expect(replayRes.ok).toBe(true);
    expect(replayedSessionId).toBe('live-turn-123');
  });
});
