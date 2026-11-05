import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { nextRun, parseCron } from '@cindy/maker-scheduler/cron';
import type { Maker, Session } from '@cindy/maker-core';
import { getDesktopExpertSessionStore } from '../expertSessions';
import { ScheduledSessionsHost } from '../scheduledSessions';

describe('ScheduledSessions Live Proof against ~/.cindy-harness (ROADMAP 5.4b)', () => {
  it('loads real schedules from ~/.cindy-harness/schedules and executes a scheduled turn writing to Notes Vault', async () => {
    const cron = { parseCron, nextRun };
    const expertStore = getDesktopExpertSessionStore();

    // Verify real code-reviewer expert exists
    const expertCheck = expertStore.checkWorkerExpert('code-reviewer');
    expect(expertCheck.ok).toBe(true);

    const schedulesDir = path.join(os.homedir(), '.cindy-harness', 'schedules');
    fs.mkdirSync(schedulesDir, { recursive: true });

    const scheduleFile = path.join(schedulesDir, 'live-test-daily.md');
    fs.writeFileSync(
      scheduleFile,
      `---
expert: code-reviewer
cron: "0 9 * * *"
timezone: Europe/London
enabled: true
output: "schedules/live-test-{date}.md"
---
A code reviewer examines source code changes for correctness, security vulnerabilities, and code health. This test proves scheduled session execution is operating correctly. Verdict: ship.
`,
    );

    let sessionOnEventCb: ((ev: unknown) => void) | undefined;
    const fakeSession = {
      onEvent: (cb: (ev: unknown) => void) => {
        sessionOnEventCb = cb;
        return () => {};
      },
      send: async () => {
        setTimeout(() => {
          sessionOnEventCb?.({
            type: 'text',
            data: {
              text: 'A code reviewer inspects diffs and files to catch logic errors before they reach production. Automated scheduled sessions provide regular health reports without requiring manual initiation. Verdict: ship.',
            },
          });
          sessionOnEventCb?.({ type: 'done' });
        }, 20);
      },
    } as unknown as Session;

    const fakeMaker = {
      createSession: async (opts: unknown) => fakeSession,
    } as unknown as Maker;

    const host = new ScheduledSessionsHost({
      maker: fakeMaker,
      expertSessionStore: expertStore,
      cron,
    });

    const cfg = host.getConfig();
    expect(cfg.schedulesDir).toBe(schedulesDir);
    expect(cfg.vaultConfigured).toBe(true);
    expect(cfg.vaultDir).toBe('/Users/turko/Bishi-memory');

    const list = host.listSchedules();
    const testEntry = list.find((s) => s.id === 'live-test-daily');
    expect(testEntry).toBeDefined();
    expect(testEntry?.ok).toBe(true);
    expect(testEntry?.expert).toBe('code-reviewer');
    expect(testEntry?.output).toBe('schedules/live-test-{date}.md');

    // Run the schedule live!
    const result = await host.runScheduleNow('live-test-daily');
    expect(result.status).toBe('success');
    expect(result.notePath).toMatch(/^schedules\/live-test-\d{4}-\d{2}-\d{2}\.md$/);

    // Verify file in /Users/turko/Bishi-memory
    const vaultNotePath = path.join(cfg.vaultDir, result.notePath!);
    expect(fs.existsSync(vaultNotePath)).toBe(true);

    const content = fs.readFileSync(vaultNotePath, 'utf8');
    expect(content).toContain('A code reviewer inspects diffs and files');
    expect(content).toContain('Verdict: ship.');

    // Verify ~/.cindy-harness/schedules-state.json
    const stateFile = path.join(os.homedir(), '.cindy-harness', 'schedules-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const stateRaw = fs.readFileSync(stateFile, 'utf8');
    const state = JSON.parse(stateRaw);
    expect(state.lastRunMs['live-test-daily']).toBeDefined();
    expect(state.lastRuns['live-test-daily'].status).toBe('success');
    expect(state.lastRuns['live-test-daily'].notePath).toBe(result.notePath);

    // Clean up test schedule file and test vault note
    fs.rmSync(scheduleFile, { force: true });
    fs.rmSync(vaultNotePath, { force: true });

    // Clean up test schedule key from state
    const cleanState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete cleanState.lastRunMs['live-test-daily'];
    delete cleanState.firstSeenMs['live-test-daily'];
    delete cleanState.lastRuns['live-test-daily'];
    fs.writeFileSync(stateFile, JSON.stringify(cleanState, null, 2) + '\n', 'utf8');
  });
});
