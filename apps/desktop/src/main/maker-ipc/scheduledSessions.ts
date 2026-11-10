/**
 * Scheduled sessions host and IPC support (ROADMAP 5.4b).
 *
 * Runs file-backed scheduled sessions on a cron schedule with a fixed prompt,
 * saving the results to the configured notes vault.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Maker, Session } from '@cindy/maker-core';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import { appendNote, readVaultConfig } from '@cindy/maker-core/vault-notes';
import { defaultVaultConfigFile } from './vaultNotes.js';
import {
  buildScheduledPrompt,
  defaultSchedulesConfigFile,
  defaultSchedulesDir,
  defaultSchedulesStateFile,
  dueSchedules,
  loadSchedules,
  readScheduleState,
  readSchedulesConfig,
  recordScheduleRun,
  resolveOutputPath,
  updateFirstSeenSchedules,
  writeScheduleState,
  writeSchedulesConfig,
  type CronApi,
  type Schedule,
  type ScheduleRunRecord,
  type ScheduleState,
} from '@cindy/maker-core/scheduled-sessions';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import type { ExpertSessionStore } from './expertSessions.js';

export interface ScheduleEntryView {
  id: string;
  file: string;
  ok: boolean;
  error?: string;
  expert?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  output?: string;
  prompt?: string;
  lastRun?: ScheduleRunRecord;
  nextRunMs?: number;
}

export interface ScheduledSessionsConfigView {
  schedulesDir: string;
  vaultDir: string;
  vaultConfigured: boolean;
  vaultIssue?: string;
  issue?: string;
}

export interface ScheduledSessionsHostDeps {
  maker?: Maker | (() => Maker | null | undefined);
  expertSessionStore: ExpertSessionStore;
  cron: CronApi;
  configFile?: string;
  stateFile?: string;
  vaultConfigFile?: string;
  now?: () => Date;
  tickerIntervalMs?: number;
  showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  notifyChanged?: () => void;
}

export class ScheduledSessionsHost {
  private readonly maker?: Maker | (() => Maker | null | undefined);
  private readonly expertSessionStore: ExpertSessionStore;
  private readonly cron: CronApi;
  private readonly configFile: string;
  private readonly stateFile: string;
  private readonly vaultConfigFile: string;
  private readonly now: () => Date;
  private readonly tickerIntervalMs: number;
  private readonly showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  private readonly notifyChanged?: () => void;

  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();

  constructor(deps: ScheduledSessionsHostDeps) {
    this.maker = deps.maker;
    this.expertSessionStore = deps.expertSessionStore;
    this.cron = deps.cron;
    this.configFile = deps.configFile ?? defaultSchedulesConfigFile();
    this.stateFile = deps.stateFile ?? defaultSchedulesStateFile();
    this.vaultConfigFile = deps.vaultConfigFile ?? defaultVaultConfigFile();
    this.now = deps.now ?? (() => new Date());
    this.tickerIntervalMs = deps.tickerIntervalMs ?? 30_000;
    this.showOpenDialog = deps.showOpenDialog;
    this.notifyChanged = deps.notifyChanged;
  }

  getConfig(): ScheduledSessionsConfigView {
    const { config: sCfg, issue: sIssue } = readSchedulesConfig(this.configFile);
    const { config: vCfg, issue: vIssue } = readVaultConfig(this.vaultConfigFile);
    return {
      schedulesDir: sCfg.schedulesDir,
      vaultDir: vCfg.vaultDir ?? '',
      vaultConfigured: Boolean(vCfg.vaultDir),
      ...(sIssue ? { issue: sIssue } : {}),
      ...(vIssue ? { vaultIssue: vIssue } : {}),
    };
  }

  setConfig(schedulesDir: string): ScheduledSessionsConfigView {
    if (typeof schedulesDir !== 'string') {
      throw new Error('schedulesDir must be a string');
    }
    writeSchedulesConfig(this.configFile, { schedulesDir: schedulesDir.trim() });
    this.notifyChanged?.();
    return this.getConfig();
  }

  async pickFolder(): Promise<string | null> {
    if (!this.showOpenDialog) return null;
    const res = await this.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0];
  }

  getState(): ScheduleState {
    return readScheduleState(this.stateFile);
  }

  listSchedules(): ScheduleEntryView[] {
    const { schedulesDir } = this.getConfig();
    const entries = loadSchedules(schedulesDir, this.cron);
    const state = this.getState();
    const now = this.now();
    const nowMs = now.getTime();

    const validSchedules = entries
      .filter((e): e is { ok: true; schedule: Schedule } => e.ok)
      .map((e) => e.schedule);

    if (updateFirstSeenSchedules(validSchedules, state, nowMs)) {
      writeScheduleState(this.stateFile, state);
    }

    return entries.map((entry): ScheduleEntryView => {
      if (!entry.ok) {
        return {
          id: entry.id,
          file: entry.file,
          ok: false,
          error: entry.error,
        };
      }
      const s = entry.schedule;
      const lastRun = state.lastRuns?.[s.id];
      let nextRunMs: number | undefined;
      if (s.enabled) {
        const since = state.lastRunMs[s.id] ?? state.firstSeenMs[s.id] ?? nowMs;
        try {
          nextRunMs = this.cron.nextRun(s.cron, since, s.timezone);
        } catch {
          // ignore invalid cron calculation
        }
      }

      return {
        id: s.id,
        file: s.file,
        ok: true,
        expert: s.expert,
        cron: s.cron,
        timezone: s.timezone,
        enabled: s.enabled,
        output: s.output,
        prompt: s.prompt,
        lastRun,
        nextRunMs,
      };
    });
  }

  async checkDueAndRun(): Promise<ScheduleRunRecord[]> {
    const { schedulesDir } = this.getConfig();
    const entries = loadSchedules(schedulesDir, this.cron);
    const state = this.getState();
    const now = this.now();
    const nowMs = now.getTime();

    const validSchedules = entries
      .filter((e): e is { ok: true; schedule: Schedule } => e.ok)
      .map((e) => e.schedule);

    if (updateFirstSeenSchedules(validSchedules, state, nowMs)) {
      writeScheduleState(this.stateFile, state);
    }

    const due = dueSchedules(validSchedules, state.lastRunMs, nowMs, this.cron, state.firstSeenMs);
    const results: ScheduleRunRecord[] = [];
    for (const schedule of due) {
      const res = await this.runSchedule(schedule, now);
      results.push(res);
    }
    return results;
  }

  async runScheduleNow(scheduleId: string): Promise<ScheduleRunRecord> {
    const { schedulesDir } = this.getConfig();
    const entries = loadSchedules(schedulesDir, this.cron);
    const match = entries.find((e) => (e.ok ? e.schedule.id : e.id) === scheduleId);
    if (!match) {
      throw new Error(`Schedule "${scheduleId}" not found in ${schedulesDir}`);
    }
    if (!match.ok) {
      throw new Error(`Schedule "${scheduleId}" is invalid: ${match.error}`);
    }
    return this.runSchedule(match.schedule, this.now());
  }

  async dryRunSchedule(scheduleId: string): Promise<ScheduleRunRecord> {
    const { schedulesDir } = this.getConfig();
    const entries = loadSchedules(schedulesDir, this.cron);
    const match = entries.find((e) => (e.ok ? e.schedule.id : e.id) === scheduleId);
    if (!match) {
      throw new Error(`Schedule "${scheduleId}" not found in ${schedulesDir}`);
    }
    if (!match.ok) {
      throw new Error(`Schedule "${scheduleId}" is invalid: ${match.error}`);
    }
    const throwawayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-schedule-dry-run-'));
    try {
      return await this.runSchedule(match.schedule, this.now(), { dryRun: true, throwawayHome });
    } finally {
      try {
        fs.rmSync(throwawayHome, { recursive: true, force: true });
      } catch {}
    }
  }

  async runSchedule(
    schedule: Schedule,
    now: Date,
    opts?: { dryRun?: boolean; throwawayHome?: string },
  ): Promise<ScheduleRunRecord> {
    const isDryRun = opts?.dryRun === true;
    const nowMs = now.getTime();
    if (this.inFlight.has(schedule.id)) {
      return {
        status: 'error',
        at: nowMs,
        error: `Schedule "${schedule.id}" is already running`,
      };
    }

    this.inFlight.add(schedule.id);
    try {
      const state = this.getState();
      const vaultConfig = readVaultConfig(this.vaultConfigFile);
      const vaultDir = isDryRun
        ? (opts?.throwawayHome || vaultConfig.config.vaultDir || os.tmpdir())
        : vaultConfig.config.vaultDir;

      // 1. Vault validation
      if (!vaultDir) {
        const error = 'Notes vault is not configured; set it in Settings → Notes Vault';
        const record: ScheduleRunRecord = { status: 'error', at: nowMs, error };
        if (!isDryRun) {
          recordScheduleRun(state, schedule.id, record);
          writeScheduleState(this.stateFile, state);
          this.notifyChanged?.();
        }
        return record;
      }

      // 2. Expert validation
      const expertCheck = this.expertSessionStore.checkWorkerExpert(schedule.expert);
      if (!expertCheck.ok) {
        const error = expertCheck.message;
        const record: ScheduleRunRecord = { status: 'error', at: nowMs, error };
        if (!isDryRun) {
          recordScheduleRun(state, schedule.id, record);
          writeScheduleState(this.stateFile, state);
          this.notifyChanged?.();
        }
        return record;
      }

      // 3. Maker resolution
      const maker = typeof this.maker === 'function' ? this.maker() : this.maker;
      if (!maker) {
        const error = 'Maker engine is not ready or unavailable';
        const record: ScheduleRunRecord = { status: 'error', at: nowMs, error };
        if (!isDryRun) {
          recordScheduleRun(state, schedule.id, record);
          writeScheduleState(this.stateFile, state);
          this.notifyChanged?.();
        }
        return record;
      }

      // 4. Create session
      const sessionId = randomUUID();
      let session: Session;
      try {
        session = await maker.createSession({
          id: sessionId,
          title: `Scheduled: ${schedule.id}${isDryRun ? ' (dry-run)' : ''}`,
          agentKind: 'hermes',
          model: expertCheck.model ?? 'hermes-default',
          workingDir: vaultDir,
          permissionMode: 'bypassPermissions',
        });
      } catch (err) {
        const error = `Failed to create session: ${err instanceof Error ? err.message : String(err)}`;
        const record: ScheduleRunRecord = { status: 'error', at: nowMs, error, sessionId };
        if (!isDryRun) {
          recordScheduleRun(state, schedule.id, record);
          writeScheduleState(this.stateFile, state);
          this.notifyChanged?.();
        }
        return record;
      }

      // Bind session to expert
      this.expertSessionStore.bindSession(sessionId, schedule.expert);

      // 5. Run turn: listen for text and wait for done
      let assistantText = '';
      const turnPromise = new Promise<string>((resolve, reject) => {
        let settled = false;
        const unsub = session.onEvent((ev) => {
          if (settled) return;
          if (ev.type === 'text') {
            const data = ev.data as { text?: string; isFinal?: boolean } | null;
            if (data && typeof data.text === 'string') {
              if (data.isFinal) {
                assistantText = data.text;
              } else if (!ev.standaloneText) {
                assistantText += data.text;
              }
            }
          } else if (ev.type === 'done') {
            settled = true;
            unsub();
            resolve(assistantText);
          } else if (ev.type === 'error' && isTerminalAgentErrorEvent(ev)) {
            settled = true;
            unsub();
            const msg = (ev.data as Record<string, unknown> | undefined)?.message;
            reject(new Error(typeof msg === 'string' ? msg : 'Turn failed'));
          }
        });
      });

      try {
        await session.send({
          type: 'user',
          content: buildScheduledPrompt(schedule, now),
        });

        const rawResult = await turnPromise;
        const resultText = rawResult.trim() || '(No output returned by agent)';

        // 6. Write note to vault (only if not dry run)
        const relPath = resolveOutputPath(schedule, now);
        if (!isDryRun) {
          const appendResult = appendNote(vaultDir, relPath, resultText, { now });
          if (!appendResult.ok) {
            throw new Error(`Failed to append note to vault (${relPath}): ${appendResult.message}`);
          }
        }

        // 7. Update state with success (only if not dry run)
        const record: ScheduleRunRecord = {
          status: 'success',
          at: nowMs,
          notePath: relPath,
          sessionId,
          ...(isDryRun ? { dryRun: true, output: resultText } : {}),
        };
        if (!isDryRun) {
          recordScheduleRun(state, schedule.id, record);
          writeScheduleState(this.stateFile, state);
          this.notifyChanged?.();
        }
        return record;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const record: ScheduleRunRecord = {
          status: 'error',
          at: nowMs,
          error,
          sessionId,
        };
        if (!isDryRun) {
          recordScheduleRun(state, schedule.id, record);
          writeScheduleState(this.stateFile, state);
          this.notifyChanged?.();
        }
        return record;
      }
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  startTicker(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.checkDueAndRun().catch(() => {
        // isolated background failure
      });
    }, this.tickerIntervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stopTicker(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

let desktopScheduledSessionsHost: ScheduledSessionsHost | undefined;

export function getDesktopScheduledSessionsHost(
  deps?: ScheduledSessionsHostDeps,
): ScheduledSessionsHost {
  if (!desktopScheduledSessionsHost) {
    if (!deps) {
      throw new Error('getDesktopScheduledSessionsHost called without deps before initialization');
    }
    desktopScheduledSessionsHost = new ScheduledSessionsHost(deps);
  }
  return desktopScheduledSessionsHost;
}

export interface ScheduledSessionsHandlerDeps {
  host: ScheduledSessionsHost;
  assertTrusted(event: unknown): void;
  broadcast(channel: string, payload?: unknown): void;
}

export function registerScheduledSessionsHandlers(
  registry: IpcHandlerRegistry,
  deps: ScheduledSessionsHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.SCHEDULED_SESSIONS_GET_CONFIG, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });

  registry.handle(MAKER_INVOKE.SCHEDULED_SESSIONS_SET_CONFIG, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const schedulesDir = typeof r.schedulesDir === 'string' ? r.schedulesDir : '';
    return deps.host.setConfig(schedulesDir);
  });

  registry.handle(MAKER_INVOKE.SCHEDULED_SESSIONS_PICK_FOLDER, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.pickFolder();
  });

  registry.handle(MAKER_INVOKE.SCHEDULED_SESSIONS_LIST, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.listSchedules();
  });

  registry.handle(MAKER_INVOKE.SCHEDULED_SESSIONS_RUN_NOW, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    return deps.host.runScheduleNow(id);
  });

  registry.handle(MAKER_INVOKE.SCHEDULED_SESSIONS_DRY_RUN, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    return deps.host.dryRunSchedule(id);
  });

  registry.handle(MAKER_INVOKE.SCHEDULED_SESSIONS_GET_STATE, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getState();
  });
}
