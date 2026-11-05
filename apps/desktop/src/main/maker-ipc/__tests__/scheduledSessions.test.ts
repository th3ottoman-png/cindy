import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextRun, parseCron } from '@cindy/maker-scheduler/cron';
import type { Maker, Session } from '@cindy/maker-core';
import { ExpertSessionStore } from '../expertSessions';
import {
  ScheduledSessionsHost,
  registerScheduledSessionsHandlers,
  type ScheduleEntryView,
} from '../scheduledSessions';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import type { IpcHandlerRegistry } from '../ipcHandlerRegistry';

describe('ScheduledSessionsHost (ROADMAP 5.4b)', () => {
  let root: string;
  let expertsDir: string;
  let bindingsFile: string;
  let schedulesDir: string;
  let vaultDir: string;
  let configFile: string;
  let stateFile: string;
  let vaultConfigFile: string;
  let expertStore: ExpertSessionStore;

  const cron = { parseCron, nextRun };
  const FIXED_NOW = new Date('2026-11-05T10:00:00.000Z');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-host-test-'));
    expertsDir = path.join(root, 'experts');
    fs.mkdirSync(expertsDir, { recursive: true });
    bindingsFile = path.join(root, 'bindings.json');
    schedulesDir = path.join(root, 'schedules');
    fs.mkdirSync(schedulesDir, { recursive: true });
    vaultDir = path.join(root, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    configFile = path.join(root, 'schedules-config.json');
    stateFile = path.join(root, 'schedules-state.json');
    vaultConfigFile = path.join(root, 'vault.json');

    // Create a mock expert
    const researcherDir = path.join(expertsDir, 'researcher');
    fs.mkdirSync(researcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(researcherDir, 'expert.md'),
      '---\nname: Researcher\nagent: hermes\nmodel: hermes-default\n---\nYou are a researcher.\n',
    );

    // Write vault config
    fs.writeFileSync(vaultConfigFile, JSON.stringify({ vaultDir }) + '\n');
    // Write schedules config
    fs.writeFileSync(configFile, JSON.stringify({ schedulesDir }) + '\n');

    expertStore = new ExpertSessionStore({
      rootDir: expertsDir,
      bindingsFile,
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createFakeSession(opts: {
    replyText?: string;
    shouldError?: boolean;
    errorMessage?: string;
  } = {}): {
    session: Session;
    emitEvent: (ev: unknown) => void;
  } {
    const listeners: ((ev: unknown) => void)[] = [];
    const emitEvent = (ev: unknown) => {
      for (const l of listeners) l(ev);
    };

    const session = {
      onEvent: (l: (ev: unknown) => void) => {
        listeners.push(l);
        return () => {
          const idx = listeners.indexOf(l);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      send: async () => {
        // Asynchronously emit reply or error
        setTimeout(() => {
          if (opts.shouldError) {
            emitEvent({
              type: 'error',
              data: { isTerminal: true, message: opts.errorMessage ?? 'Fake agent failed' },
            });
          } else {
            emitEvent({
              type: 'text',
              data: { text: opts.replyText ?? 'Research summary completed.' },
            });
            emitEvent({ type: 'done' });
          }
        }, 10);
      },
    } as unknown as Session;

    return { session, emitEvent };
  }

  it('reads config and reflects vault configuration status', () => {
    const host = new ScheduledSessionsHost({
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
    });

    const cfg = host.getConfig();
    expect(cfg.schedulesDir).toBe(schedulesDir);
    expect(cfg.vaultDir).toBe(vaultDir);
    expect(cfg.vaultConfigured).toBe(true);

    // When vault config is removed
    fs.rmSync(vaultConfigFile);
    const cfg2 = host.getConfig();
    expect(cfg2.vaultConfigured).toBe(false);
    expect(cfg2.vaultDir).toBe('');
  });

  it('sets custom schedulesDir and triggers notifyChanged', () => {
    const notify = vi.fn();
    const host = new ScheduledSessionsHost({
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      notifyChanged: notify,
    });

    const newDir = path.join(root, 'custom-schedules');
    host.setConfig(newDir);
    expect(host.getConfig().schedulesDir).toBe(newDir);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('lists schedules, handles invalid files, and initializes firstSeenMs', () => {
    // Write good schedule
    fs.writeFileSync(
      path.join(schedulesDir, 'morning.md'),
      '---\nexpert: researcher\ncron: "0 8 * * *"\noutput: "briefs/{date}.md"\n---\nMorning summary\n',
    );
    // Write bad schedule
    fs.writeFileSync(
      path.join(schedulesDir, 'bad.md'),
      '---\nexpert: researcher\n---\nMissing cron\n',
    );

    const host = new ScheduledSessionsHost({
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      now: () => FIXED_NOW,
    });

    const list = host.listSchedules();
    expect(list).toHaveLength(2);

    const bad = list.find((s) => s.id === 'bad');
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toMatch(/cron/);

    const morning = list.find((s) => s.id === 'morning');
    expect(morning?.ok).toBe(true);
    expect(morning?.expert).toBe('researcher');
    expect(morning?.cron).toBe('0 8 * * *');
    expect(morning?.output).toBe('briefs/{date}.md');
    expect(morning?.nextRunMs).toBeDefined();

    // Verify firstSeenMs was persisted in stateFile
    const state = host.getState();
    expect(state.firstSeenMs.morning).toBe(FIXED_NOW.getTime());
  });

  it('runs schedule successfully: creates session, binds expert, writes note to vault, updates state', async () => {
    fs.writeFileSync(
      path.join(schedulesDir, 'morning.md'),
      '---\nexpert: researcher\ncron: "0 8 * * *"\noutput: "briefs/{date}.md"\n---\nSummarise notes.\n',
    );

    const { session } = createFakeSession({ replyText: 'Here is the summary.' });
    const createSession = vi.fn().mockResolvedValue(session);
    const fakeMaker = { createSession } as unknown as Maker;

    const notify = vi.fn();
    const host = new ScheduledSessionsHost({
      maker: fakeMaker,
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      now: () => FIXED_NOW,
      notifyChanged: notify,
    });

    const result = await host.runScheduleNow('morning');
    expect(result.status).toBe('success');
    expect(result.notePath).toBe('briefs/2026-11-05.md');
    expect(result.sessionId).toBeDefined();

    // Verify maker.createSession was called with correct parameters
    expect(createSession).toHaveBeenCalledOnce();
    const callArgs = createSession.mock.calls[0][0];
    expect(callArgs.title).toBe('Scheduled: morning');
    expect(callArgs.agentKind).toBe('hermes');
    expect(callArgs.workingDir).toBe(vaultDir);
    expect(callArgs.permissionMode).toBe('bypassPermissions');

    // Verify session was bound to expert
    expect(expertStore.getBoundSlug(result.sessionId!)).toBe('researcher');

    // Verify note was written to vault
    const noteFile = path.join(vaultDir, 'briefs', '2026-11-05.md');
    expect(fs.existsSync(noteFile)).toBe(true);
    const content = fs.readFileSync(noteFile, 'utf8');
    expect(content).toContain('## 2026-11-05T10:00:00.000Z');
    expect(content).toContain('Here is the summary.');

    // Verify state was recorded
    const state = host.getState();
    expect(state.lastRunMs.morning).toBe(FIXED_NOW.getTime());
    expect(state.lastRuns?.morning).toEqual({
      status: 'success',
      at: FIXED_NOW.getTime(),
      notePath: 'briefs/2026-11-05.md',
      sessionId: result.sessionId,
    });
    expect(notify).toHaveBeenCalled();
  });

  it('fails closed when notes vault is not configured', async () => {
    fs.writeFileSync(
      path.join(schedulesDir, 'morning.md'),
      '---\nexpert: researcher\ncron: "0 8 * * *"\n---\nSummarise notes.\n',
    );

    // Remove vault config
    fs.writeFileSync(vaultConfigFile, JSON.stringify({ vaultDir: '' }));

    const host = new ScheduledSessionsHost({
      maker: {} as Maker,
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      now: () => FIXED_NOW,
    });

    const result = await host.runScheduleNow('morning');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/vault is not configured/i);
    expect(host.getState().lastRuns?.morning?.status).toBe('error');
  });

  it('fails closed when expert does not exist or is not a Hermes expert', async () => {
    fs.writeFileSync(
      path.join(schedulesDir, 'unknown.md'),
      '---\nexpert: nonexistent-expert\ncron: "0 8 * * *"\n---\nSummarise notes.\n',
    );

    const host = new ScheduledSessionsHost({
      maker: {} as Maker,
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      now: () => FIXED_NOW,
    });

    const result = await host.runScheduleNow('unknown');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cannot be loaded/i);
    expect(host.getState().lastRuns?.unknown?.status).toBe('error');
  });

  it('handles agent terminal error and records failure in state', async () => {
    fs.writeFileSync(
      path.join(schedulesDir, 'morning.md'),
      '---\nexpert: researcher\ncron: "0 8 * * *"\noutput: "briefs/{date}.md"\n---\nSummarise notes.\n',
    );

    const { session } = createFakeSession({ shouldError: true, errorMessage: 'Provider quota exhausted' });
    const createSession = vi.fn().mockResolvedValue(session);
    const fakeMaker = { createSession } as unknown as Maker;

    const host = new ScheduledSessionsHost({
      maker: fakeMaker,
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      now: () => FIXED_NOW,
    });

    const result = await host.runScheduleNow('morning');
    expect(result.status).toBe('error');
    expect(result.error).toBe('Provider quota exhausted');
    expect(host.getState().lastRuns?.morning?.status).toBe('error');
    expect(host.getState().lastRuns?.morning?.error).toBe('Provider quota exhausted');
  });

  it('prevents overlapping runs of the same schedule', async () => {
    fs.writeFileSync(
      path.join(schedulesDir, 'slow.md'),
      '---\nexpert: researcher\ncron: "0 8 * * *"\n---\nSlow job\n',
    );

    let eventListener: ((ev: unknown) => void) | undefined;
    let resolveSend: () => void = () => {};
    const slowSession = {
      onEvent: (l: (ev: unknown) => void) => {
        eventListener = l;
        return () => {};
      },
      send: () =>
        new Promise<void>((res) => {
          resolveSend = () => {
            eventListener?.({ type: 'text', data: { text: 'Done' } });
            eventListener?.({ type: 'done' });
            res();
          };
        }),
    } as unknown as Session;

    const host = new ScheduledSessionsHost({
      maker: { createSession: vi.fn().mockResolvedValue(slowSession) } as unknown as Maker,
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      now: () => FIXED_NOW,
    });

    const run1Promise = host.runScheduleNow('slow');
    const run2 = await host.runScheduleNow('slow');
    expect(run2.status).toBe('error');
    expect(run2.error).toMatch(/already running/);

    resolveSend();
    const run1 = await run1Promise;
    expect(run1.status).toBe('success');
  });

  it('runs due schedules in checkDueAndRun', async () => {
    fs.writeFileSync(
      path.join(schedulesDir, 'daily.md'),
      '---\nexpert: researcher\ncron: "0 8 * * *"\n---\nDaily job\n',
    );

    const { session } = createFakeSession({ replyText: 'Daily result' });
    const createSession = vi.fn().mockResolvedValue(session);

    // Initial state: first seen yesterday, so today 10:00 is due
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        lastRunMs: { daily: Date.parse('2026-11-04T08:00:00.000Z') },
        firstSeenMs: { daily: Date.parse('2026-11-04T08:00:00.000Z') },
      }),
    );

    const host = new ScheduledSessionsHost({
      maker: { createSession } as unknown as Maker,
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
      now: () => FIXED_NOW,
    });

    const results = await host.checkDueAndRun();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('starts and stops ticker interval', () => {
    vi.useFakeTimers();
    try {
      const host = new ScheduledSessionsHost({
        expertSessionStore: expertStore,
        cron,
        configFile,
        stateFile,
        vaultConfigFile,
        tickerIntervalMs: 15_000,
      });

      const checkSpy = vi.spyOn(host, 'checkDueAndRun').mockResolvedValue([]);
      host.startTicker();
      // calling start again is a no-op
      host.startTicker();

      vi.advanceTimersByTime(15_000);
      expect(checkSpy).toHaveBeenCalledOnce();

      host.stopTicker();
      vi.advanceTimersByTime(30_000);
      expect(checkSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers IPC handlers and responds to invoke requests', async () => {
    const host = new ScheduledSessionsHost({
      expertSessionStore: expertStore,
      cron,
      configFile,
      stateFile,
      vaultConfigFile,
    });

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const registry: IpcHandlerRegistry = {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      },
    };

    const assertTrusted = vi.fn();
    const broadcast = vi.fn();

    registerScheduledSessionsHandlers(registry, { host, assertTrusted, broadcast });

    expect(handlers.has(MAKER_INVOKE.SCHEDULED_SESSIONS_GET_CONFIG)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.SCHEDULED_SESSIONS_SET_CONFIG)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.SCHEDULED_SESSIONS_PICK_FOLDER)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.SCHEDULED_SESSIONS_LIST)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.SCHEDULED_SESSIONS_RUN_NOW)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.SCHEDULED_SESSIONS_GET_STATE)).toBe(true);

    // Call GET_CONFIG handler
    const getConfigHandler = handlers.get(MAKER_INVOKE.SCHEDULED_SESSIONS_GET_CONFIG)!;
    const configResult = await getConfigHandler({});
    expect(assertTrusted).toHaveBeenCalled();
    expect((configResult as Record<string, unknown>).vaultConfigured).toBe(true);
  });
});
