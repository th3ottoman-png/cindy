/**
 * Pure contracts for Cindy Doctor (ROADMAP 14.1, blueprint §2.1, ADR 0015).
 *
 * Zero Node-process side effects, zero Electron imports, zero network calls.
 * Implementations of checks and fixes register through `DoctorRegistry` so
 * adding a check never edits a central switch statement (AGENTS.md §6.2).
 */

import type { probeEndpoint } from '../providers/discovery.js';

export const DOCTOR_LAYERS = [
  'environment',
  'runtimes',
  'config',
  'endpoints',
  'processes',
  'data',
] as const;

export type DoctorLayer = (typeof DOCTOR_LAYERS)[number];

export type Severity = 'ok' | 'warn' | 'fail' | 'skip';

export type CheckCost = 'instant' | 'fast' | 'slow';

export const DEFAULT_DOCTOR_COSTS: readonly CheckCost[] = ['instant', 'fast'];

export const CHECK_TIMEOUT_MS: Readonly<Record<CheckCost, number>> = {
  instant: 500,
  fast: 3_000,
  slow: 30_000,
};

export type AppRuntimeRequirement = 'app-closed' | 'app-running';

export type EvidenceValue = string | number | boolean | null;

export interface CheckResult {
  id: string;
  layer: DoctorLayer;
  title: string;
  severity: Severity;
  summary: string;
  detail?: string;
  action?: string;
  fixIds?: string[];
  evidence?: Record<string, EvidenceValue>;
  durationMs: number;
}

export type CheckRunOutput = Omit<CheckResult, 'id' | 'layer' | 'title' | 'durationMs'>;

export interface DoctorCheck {
  id: string;
  layer: DoctorLayer;
  title: string;
  cost: CheckCost;
  dependsOn?: string[];
  needs?: AppRuntimeRequirement[];
  run(ctx: DoctorContext): Promise<CheckRunOutput>;
}

export interface FixPlan {
  fixId: string;
  target?: string;
  steps: string[];
  touches: string[];
  requiresAppClosed?: boolean;
  meta?: Record<string, unknown>;
}

export interface FixOutcome {
  ok: boolean;
  rolledBack: boolean;
  message: string;
  recheck: CheckResult[];
  preFixSnapshotStamp?: string;
  fixLogPath?: string;
}

export interface DoctorFix {
  id: string;
  title: string;
  risk: 'moves-files' | 'kills-process';
  needsAppClosed: boolean;
  recheck: string[];
  preview(ctx: DoctorContext, target?: string): Promise<FixPlan>;
  apply(ctx: DoctorContext, plan: FixPlan): Promise<FixOutcome>;
}

export interface DoctorPack {
  name?: string;
  checks: readonly DoctorCheck[];
  fixes?: readonly DoctorFix[];
  /** Optional dynamic check discovery (e.g., per-provider or per-MCP checks). */
  discoverChecks?(ctx: DoctorContext): Promise<readonly DoctorCheck[]> | readonly DoctorCheck[];
}

export interface DoctorRegistry {
  readonly checks: readonly DoctorCheck[];
  readonly fixes: readonly DoctorFix[];
  getCheck(id: string): DoctorCheck | undefined;
  getFix(id: string): DoctorFix | undefined;
  /** Returns static checks plus any pack-discovered checks for `ctx`. */
  resolveChecks?(ctx: DoctorContext): Promise<readonly DoctorCheck[]>;
}

export interface DoctorHostInfo {
  node: string;
  platform: string;
}

export interface DoctorReport {
  startedAt: string;
  durationMs: number;
  host: DoctorHostInfo;
  counts: Record<Severity, number>;
  results: CheckResult[];
}

export interface DoctorPaths {
  home: string;
  hermesHome: string;
  harnessDir: string;
  userDataDir: string;
  repoRoot: string;
  socketPath?: string;
}

export interface DoctorFs {
  readFile: typeof import('node:fs/promises')['readFile'];
  stat: typeof import('node:fs/promises')['stat'];
  readdir: typeof import('node:fs/promises')['readdir'];
  access: typeof import('node:fs/promises')['access'];
}

export interface DoctorExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface DoctorContext {
  paths: DoctorPaths;
  fs: DoctorFs;
  exec(cmd: string, args: string[], opts: { timeoutMs: number }): Promise<DoctorExecResult>;
  probe: typeof probeEndpoint;
  now(): Date;
  signal: AbortSignal;
  /** Optional runtime state hint for checks declaring `needs`. */
  appRunning?: boolean;
  /** Optional host metadata override for deterministic tests. */
  host?: DoctorHostInfo;
  /** Optional environment variables snapshot (defaults to `process.env` in `createNodeContext`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Pinned Hermes CLI version from `@cindy/maker-hermes-manager` (`HERMES_CLI_PINNED_VERSION`). */
  hermesPinnedVersion?: string;
  /** Pinned pnpm version from root `package.json` (`packageManager`). */
  pnpmPinnedVersion?: string;
  /** Optional platform override (`process.platform` by default). */
  platform?: NodeJS.Platform;
  /** Optional platform architecture override (`process.arch` by default). */
  arch?: string;
  /** Free-space statfs seam for `env.disk`. */
  statfs?: (targetPath: string) => Promise<{ bavail: number; bsize: number }>;
  /** Native sqlite load check seam for `env.native-sqlite`. */
  loadNativeSqlite?: () => Promise<void> | void;
  /** Probe non-local API endpoints when true (`--include-api`, default false). */
  includeApi?: boolean;
  /** Optional fetch implementation passed into `probe` (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Read-only SQLite `PRAGMA quick_check` seam for `data.sqlite` and `data.hermes-state`. */
  sqliteQuickCheck?: (dbPath: string) => Promise<string[]> | string[];
  /** Symlink-safe lstat seam for `data.storage` (defaults to `node:fs/promises` `lstat`). */
  lstat?: typeof import('node:fs/promises')['lstat'];
  /** Process signaling seam for `fix.proc.kill-orphans` (defaults to `process.kill`). */
  sendSignal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Sleep seam for `fix.proc.kill-orphans` grace wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Override for the 3000 ms SIGTERM -> SIGKILL grace period in tests. */
  orphanGraceMs?: number;
}

export interface RunChecksOptions {
  /** Filter to specific check ids or layer names. */
  only?: readonly string[];
  /** Filter to specific cost tiers. Omit to run all registered checks. */
  cost?: readonly CheckCost[];
  /** Optional per-cost timeout overrides (milliseconds). */
  timeouts?: Partial<Record<CheckCost, number>>;
  /** Max concurrent independent checks. Default 4. */
  concurrency?: number;
  /** Overrides `ctx.appRunning` for `needs` evaluation. */
  appRunning?: boolean;
}
