/**
 * Desktop main-process host & IPC handlers for Cindy Doctor (ROADMAP 14.8, blueprint §8).
 *
 * Runs diagnostic checks, fix previews/applies, LKG snapshots, and the non-blocking
 * post-startup health check (+ 24h daily LKG snapshot on zero fails) strictly in Main.
 */

import { execFile } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import {
  ALL_PACKS,
  applyFix,
  createIncidentBundle,
  createLkgSnapshot,
  createNodeContext,
  createRegistry,
  listLkgSnapshots,
  loadDoctorSettings,
  previewFix,
  runChecks,
  saveDoctorSettings,
  type CheckCost,
  type CheckResult,
  type DoctorContext,
  type DoctorPack,
  type DoctorRegistry,
  type DoctorReport,
  type FixOutcome,
  type FixPlan,
  type IncidentBundleResult,
  type LkgSnapshotManifest,
  type LkgSnapshotRecord,
  type Severity,
} from '@cindy/maker-core/doctor';

import type {
  DoctorFixApplyParams,
  DoctorFixDescriptor,
  DoctorFixPreviewParams,
  DoctorRunParams,
  DoctorSetConfigParams,
  DoctorSnapshotParams,
  DoctorUiState,
} from '../../shared/doctor.js';
import { resolveBetterSqliteNativeBinding } from '../localDb/betterSqliteFactory.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const DEFAULT_STARTUP_DELAY_MS = 20_000;
const DAILY_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NODE_PROBE_TIMEOUT_MS = 2_000;

export interface DesktopDoctorHostDeps {
  home?: string;
  hermesHome?: string;
  harnessDir?: string;
  userDataDir?: string | (() => string);
  repoRoot?: string;
  socketPath?: string;
  appRunning?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  hostNode?: string;
  loadNativeSqlite?: DoctorContext['loadNativeSqlite'];
  sqliteQuickCheck?: DoctorContext['sqliteQuickCheck'];
  packs?: readonly DoctorPack[];
  now?: () => Date;
  startupDelayMs?: number;
  onStateChanged?: (state: DoctorUiState) => void;
}

export function resolveDesktopRepoRoot(startDirs: readonly string[] = []): string | undefined {
  for (const rawStart of startDirs) {
    if (!rawStart) continue;
    let cursor = path.resolve(rawStart);
    for (let depth = 0; depth < 8; depth += 1) {
      if (fsSync.existsSync(path.join(cursor, 'pnpm-workspace.yaml'))) {
        return cursor;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return undefined;
}

async function resolvePathNodeVersion(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'node',
        ['--version'],
        { encoding: 'utf8', timeout: NODE_PROBE_TIMEOUT_MS, windowsHide: true, env: env as NodeJS.ProcessEnv },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          const clean = (stdout ?? '').trim().replace(/^v/, '');
          resolve(clean.length > 0 ? clean : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

function electronSqliteHandlers(): {
  loadNativeSqlite: () => void;
  sqliteQuickCheck: (dbPath: string) => string[];
} {
  const binding = resolveBetterSqliteNativeBinding();
  const baseOpts: Database.Options = binding ? { nativeBinding: binding } : {};
  return {
    loadNativeSqlite: () => {
      const db = new Database(':memory:', baseOpts);
      db.close();
    },
    sqliteQuickCheck: (dbPath: string) => {
      const db = new Database(dbPath, {
        ...baseOpts,
        readonly: true,
        fileMustExist: true,
      });
      try {
        const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
        return rows.map((row) => String(Object.values(row)[0] ?? 'unknown'));
      } finally {
        db.close();
      }
    },
  };
}

function buildFixesMetadata(registry: DoctorRegistry): Record<string, DoctorFixDescriptor> {
  const out: Record<string, DoctorFixDescriptor> = {};
  for (const fix of registry.fixes) {
    out[fix.id] = {
      id: fix.id,
      title: fix.title,
      risk: fix.risk,
      needsAppClosed: Boolean(fix.needsAppClosed),
      recheck: [...fix.recheck],
      cliCommand: `pnpm run doctor fix ${fix.id}`,
    };
  }
  return out;
}

function countResultsBySeverity(results: readonly CheckResult[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) {
    counts[r.severity] += 1;
  }
  return counts;
}

export class DesktopDoctorHost {
  private readonly packs: readonly DoctorPack[];
  private readonly registry: DoctorRegistry;
  private readonly fixesMeta: Record<string, DoctorFixDescriptor>;
  private lastReport: DoctorReport | null = null;
  private lastCosts: CheckCost[] | null = null;
  private runOnStart = true;
  private running = false;
  private lastStartupSnapshotAt: string | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightRun: Promise<DoctorReport> | null = null;
  private cachedHostNode: string | undefined;
  private deps: DesktopDoctorHostDeps;

  constructor(deps: DesktopDoctorHostDeps = {}) {
    this.deps = { ...deps };
    this.packs = this.deps.packs ?? ALL_PACKS;
    this.registry = createRegistry(this.packs);
    this.fixesMeta = buildFixesMetadata(this.registry);
    if (this.deps.hostNode) {
      this.cachedHostNode = this.deps.hostNode;
    }
    void this.initSettings();
  }

  configure(nextDeps: DesktopDoctorHostDeps): void {
    const entries = Object.entries(nextDeps).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    this.deps = { ...this.deps, ...Object.fromEntries(entries) };
    if (nextDeps.hostNode) {
      this.cachedHostNode = nextDeps.hostNode;
    }
  }

  private async initSettings(): Promise<void> {
    try {
      const ctx = await this.createContext();
      const settings = await loadDoctorSettings(ctx);
      this.runOnStart = settings.runOnStart;
    } catch {
      // Keep default on read failure
    }
  }

  private resolveUserDataDir(): string | undefined {
    if (typeof this.deps.userDataDir === 'function') {
      return this.deps.userDataDir();
    }
    return this.deps.userDataDir;
  }

  private async createContext(): Promise<DoctorContext> {
    const env = this.deps.env ?? process.env;
    const home = this.deps.home ?? os.homedir();
    const hermesHome = this.deps.hermesHome ?? path.join(home, '.hermes-cindy');
    const harnessDir = this.deps.harnessDir ?? path.join(home, '.cindy-harness');
    const repoRoot = this.deps.repoRoot ?? resolveDesktopRepoRoot([process.cwd()]);

    let hostNode = this.deps.hostNode ?? this.cachedHostNode;
    if (!hostNode && process.versions.electron) {
      hostNode = await resolvePathNodeVersion(env);
      if (hostNode) {
        this.cachedHostNode = hostNode;
      }
    }

    const sqliteHandlers =
      this.deps.loadNativeSqlite && this.deps.sqliteQuickCheck
        ? {
            loadNativeSqlite: this.deps.loadNativeSqlite,
            sqliteQuickCheck: this.deps.sqliteQuickCheck,
          }
        : electronSqliteHandlers();

    const baseCtx = createNodeContext({
      home,
      hermesHome,
      harnessDir,
      ...(this.resolveUserDataDir() ? { userDataDir: this.resolveUserDataDir() } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      ...(this.deps.socketPath ? { socketPath: this.deps.socketPath } : {}),
      appRunning: this.deps.appRunning ?? true,
      env,
      ...(hostNode ? { hostNode } : {}),
      loadNativeSqlite: this.deps.loadNativeSqlite ?? sqliteHandlers.loadNativeSqlite,
      sqliteQuickCheck: this.deps.sqliteQuickCheck ?? sqliteHandlers.sqliteQuickCheck,
    });

    if (this.deps.now) {
      return { ...baseCtx, now: this.deps.now };
    }
    return baseCtx;
  }

  private buildState(): DoctorUiState {
    const hasFailure = (this.lastReport?.counts.fail ?? 0) > 0;
    return {
      report: this.lastReport,
      hasFailure,
      running: this.running,
      runOnStart: this.runOnStart,
      lastStartupSnapshotAt: this.lastStartupSnapshotAt,
      fixesMeta: this.fixesMeta,
    };
  }

  private emitStateChanged(): void {
    this.deps.onStateChanged?.(this.buildState());
  }

  async getState(): Promise<DoctorUiState> {
    try {
      const ctx = await this.createContext();
      const settings = await loadDoctorSettings(ctx);
      this.runOnStart = settings.runOnStart;
    } catch {
      // keep cached runOnStart
    }
    return this.buildState();
  }

  async setConfig(params: DoctorSetConfigParams): Promise<DoctorUiState> {
    const ctx = await this.createContext();
    const saved = await saveDoctorSettings(ctx, { runOnStart: Boolean(params.runOnStart) });
    this.runOnStart = saved.runOnStart;
    this.emitStateChanged();
    return this.buildState();
  }

  async run(params: DoctorRunParams = {}): Promise<DoctorReport> {
    if (this.inFlightRun && (!params.cost || params.cost.length === 0) && (!params.only || params.only.length === 0)) {
      return this.inFlightRun;
    }

    const execute = async (): Promise<DoctorReport> => {
      this.running = true;
      this.emitStateChanged();
      try {
        const baseCtx = await this.createContext();
        const ctx: DoctorContext =
          params.includeApi !== undefined ? { ...baseCtx, includeApi: params.includeApi } : baseCtx;
        const cost: CheckCost[] =
          params.cost && params.cost.length > 0 ? params.cost : ['instant', 'fast'];
        const report = await runChecks(this.registry, ctx, {
          cost,
          ...(params.only && params.only.length > 0 ? { only: params.only } : {}),
        });
        if (!params.only || params.only.length === 0) {
          this.lastCosts = [...cost];
        }
        this.lastReport = report;
        return report;
      } finally {
        this.running = false;
        this.emitStateChanged();
      }
    };

    const promise = execute();
    if (!params.only || params.only.length === 0) {
      this.inFlightRun = promise.finally(() => {
        if (this.inFlightRun === promise) {
          this.inFlightRun = null;
        }
      });
    }
    return promise;
  }

  async fixPreview(params: DoctorFixPreviewParams): Promise<FixPlan> {
    if (!params || typeof params.fixId !== 'string' || params.fixId.trim().length === 0) {
      throw new Error('fixPreview requires a non-empty fixId');
    }
    const ctx = await this.createContext();
    const res = await previewFix(this.registry, ctx, params.fixId.trim(), {
      ...(typeof params.target === 'string' && params.target.trim().length > 0
        ? { target: params.target.trim() }
        : {}),
    });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.plan;
  }

  async fixApply(params: DoctorFixApplyParams): Promise<FixOutcome> {
    const plan = params?.plan;
    if (
      !plan ||
      typeof plan !== 'object' ||
      typeof plan.fixId !== 'string' ||
      !Array.isArray(plan.steps) ||
      !Array.isArray(plan.touches)
    ) {
      throw new Error('fixApply requires a valid FixPlan');
    }
    const ctx = await this.createContext();
    const outcome = await applyFix(this.registry, ctx, plan, { packs: this.packs });

    // Keep cached UI report and Settings indicator dot synchronized with post-fix state
    if (this.lastReport && outcome.recheck.length > 0) {
      const byId = new Map(outcome.recheck.map((r) => [r.id, r]));
      const mergedResults = this.lastReport.results.map((r) => byId.get(r.id) ?? r);
      this.lastReport = {
        ...this.lastReport,
        results: mergedResults,
        counts: countResultsBySeverity(mergedResults),
      };
      this.emitStateChanged();
    }
    if (outcome.ok) {
      await this.run(this.lastCosts ? { cost: this.lastCosts } : {});
    } else {
      this.emitStateChanged();
    }
    return outcome;
  }

  async listSnapshots(): Promise<LkgSnapshotRecord[]> {
    const ctx = await this.createContext();
    return listLkgSnapshots(ctx);
  }

  async createSnapshot(params: DoctorSnapshotParams = {}): Promise<LkgSnapshotManifest> {
    const ctx = await this.createContext();
    const reason =
      typeof params.reason === 'string' && params.reason.trim().length > 0
        ? params.reason.trim()
        : 'manual';
    const result = await createLkgSnapshot(ctx, { reason, packs: this.packs });
    return result.manifest;
  }

  async createBundle(): Promise<IncidentBundleResult> {
    const ctx = await this.createContext();
    return createIncidentBundle(ctx, { packs: this.packs });
  }

  /**
   * Schedule one post-startup diagnostic pass (blueprint §8: 20 s after main window is
   * ready, `instant,fast` checks, zero fail -> daily 24h LKG snapshot, any fail -> dot).
   */
  scheduleStartupRun(delayMs = this.deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS): void {
    this.cancelStartupRun();
    const waitMs = Math.max(0, delayMs);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runStartupOnce();
    }, waitMs);
    this.startupTimer.unref?.();
  }

  cancelStartupRun(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async runStartupOnce(): Promise<DoctorReport | null> {
    const ctx = await this.createContext();
    const settings = await loadDoctorSettings(ctx);
    this.runOnStart = settings.runOnStart;
    if (!settings.runOnStart) {
      this.emitStateChanged();
      return null;
    }

    const report = await this.run({ cost: ['instant', 'fast'] });
    if (report.counts.fail > 0) {
      return report;
    }

    try {
      const existing = await listLkgSnapshots(ctx);
      const nowMs = (this.deps.now ? this.deps.now() : new Date()).getTime();
      const newestDailyOrGood = existing.find(
        (rec) => rec.valid && rec.manifest && !rec.manifest.reason.startsWith('pre-fix:'),
      );
      const isDue =
        !newestDailyOrGood || nowMs - newestDailyOrGood.createdMs >= DAILY_SNAPSHOT_INTERVAL_MS;
      if (isDue) {
        const snapshotResult = await createLkgSnapshot(ctx, {
          reason: 'daily',
          report,
          packs: this.packs,
        });
        this.lastStartupSnapshotAt = snapshotResult.manifest.createdAt;
        this.emitStateChanged();
      }
    } catch {
      // Snapshot capture failure should not disrupt startup or raise dialogs/toasts
    }
    return report;
  }
}

let singletonHost: DesktopDoctorHost | null = null;

export function getDesktopDoctorHost(deps: DesktopDoctorHostDeps = {}): DesktopDoctorHost {
  if (!singletonHost) {
    singletonHost = new DesktopDoctorHost(deps);
  } else if (Object.keys(deps).length > 0) {
    singletonHost.configure(deps);
  }
  return singletonHost;
}

export function registerDoctorHandlers(
  registry: IpcHandlerRegistry,
  deps: {
    host: DesktopDoctorHost;
    assertTrusted: (event: unknown) => void;
  },
): void {
  registry.handle(MAKER_INVOKE.DOCTOR_GET_STATE, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getState();
  });
  registry.handle(MAKER_INVOKE.DOCTOR_SET_CONFIG, async (event: unknown, raw: unknown) => {
    deps.assertTrusted(event);
    const params = (raw && typeof raw === 'object' ? raw : {}) as DoctorSetConfigParams;
    return deps.host.setConfig(params);
  });
  registry.handle(MAKER_INVOKE.DOCTOR_RUN, async (event: unknown, raw: unknown) => {
    deps.assertTrusted(event);
    const params = (raw && typeof raw === 'object' ? raw : {}) as DoctorRunParams;
    return deps.host.run(params);
  });
  registry.handle(MAKER_INVOKE.DOCTOR_FIX_PREVIEW, async (event: unknown, raw: unknown) => {
    deps.assertTrusted(event);
    const params = (raw && typeof raw === 'object' ? raw : {}) as DoctorFixPreviewParams;
    return deps.host.fixPreview(params);
  });
  registry.handle(MAKER_INVOKE.DOCTOR_FIX_APPLY, async (event: unknown, raw: unknown) => {
    deps.assertTrusted(event);
    const params = (raw && typeof raw === 'object' ? raw : {}) as DoctorFixApplyParams;
    return deps.host.fixApply(params);
  });
  registry.handle(MAKER_INVOKE.DOCTOR_SNAPSHOTS, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.listSnapshots();
  });
  registry.handle(MAKER_INVOKE.DOCTOR_SNAPSHOT, async (event: unknown, raw: unknown) => {
    deps.assertTrusted(event);
    const params = (raw && typeof raw === 'object' ? raw : {}) as DoctorSnapshotParams;
    return deps.host.createSnapshot(params);
  });
  registry.handle(MAKER_INVOKE.DOCTOR_BUNDLE, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.createBundle();
  });
}

export const DOCTOR_PUSH_CHANNEL = MAKER_PUSH.DOCTOR_UPDATED;
