/**
 * Storage housekeeping host (ROADMAP 13.2b, ADR 0014).
 *
 * Read-only: it measures the storage roots, persists `retentionDays`, and runs the pure planner to
 * show what a prune WOULD remove. Nothing here deletes — the Prune action is 13.2c. No network.
 *
 * Roots are injected so tests can point them at a temp tree. Symlinks are lstat'ed and never
 * followed, and the walk is deadline-bounded so a huge home cannot hang Settings.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_RETENTION_DAYS,
  normalizeRetentionDays,
  planHousekeeping,
  type ConversationStatus,
  type HousekeepingCandidate,
  type HousekeepingDecision,
  type HousekeepingKind,
} from '@cindy/maker-core/housekeeping';
import { stopSessionGateway, type StopGatewayResult } from '@cindy/maker-hermes-manager';

/**
 * Cindy conversation facts, keyed by `sessions.sdk_session_id`. The host joins them to the
 * daemon registry's `hermesSessionId`, because a home is named by the DAEMON session id
 * (ADR 0014). `protected` means open, running, scheduled or pinned.
 */
export interface ConversationFacts {
  bySdkSessionId: Readonly<Record<string, { status: ConversationStatus; protected: boolean }>>;
}

/**
 * The walk is synchronous on the main process, so the cap bounds UI blocking. Measured 1.1 s for
 * 169 homes / 4.4 GB on 2026-11-14; 4 s leaves headroom without freezing Settings for long.
 */
export const HOUSEKEEPING_SCAN_BUDGET_MS = 4000;

/** Same shape guard as `reapOrphanHomes`: the owner id is the home name minus `-<10 hex>`. */
const HOME_NAME = /^(.+)-[0-9a-f]{10}$/;
const BACKUP_NAME = /^(.+)\.bak[-.]/;
const DEV_TERMINAL_LOG = /^dev-terminal.*\.log$/;
/** ADR 0014 Tier 3: the agent's transcript is never removed, whatever else goes. */
const TRANSCRIPT_BASENAMES = new Set(['state.db', 'state.db-wal', 'state.db-shm']);

export interface HousekeepingSettings {
  retentionDays: number;
  /** Optional startup prune. Off by default (blueprint §4); the action itself is 13.2c. */
  pruneAtStartup: boolean;
}

export interface StorageBucket {
  count: number;
  totalBytes: number;
  newestMs?: number;
  oldestMs?: number;
}

export interface StorageView {
  settings: HousekeepingSettings;
  sessionHomes: StorageBucket;
  /** Homes no daemon registry record owns — the reaper's own contract. */
  orphanHomes: StorageBucket;
  /** `models_dev_cache.json` copies across homes: the biggest reclaimable item (ADR 0014). */
  modelCatalogCopies: StorageBucket;
  hermesCache: StorageBucket;
  hermesUvCache: StorageBucket;
  harnessBackups: StorageBucket;
  appLogs: StorageBucket;
  devTerminalLogs: StorageBucket;
  /** What the planner would remove right now. A preview, not an action. */
  preview: HousekeepingDecision[];
  /** Every keep with its reason. Empty unless `includeKeeps` was set. */
  keeps: HousekeepingDecision[];
  reclaimableItems: number;
  /** A size estimate, not measured free space (ADR 0014: uv may APFS-clone). */
  estimatedFreedBytes: number;
  scannedAt: number;
  /** True when the walk hit its deadline; the numbers are then a lower bound. */
  truncated: boolean;
}

export interface HousekeepingRoots {
  /** `~/.hermes-cindy`. */
  hermesHome: string;
  /** `~/.cindy-harness`. */
  harnessDir: string;
  /** The app's own log directory (`getLogDir()`). */
  appLogDir: string;
}

export function defaultHousekeepingRoots(appLogDir: string, home: string = os.homedir()): HousekeepingRoots {
  return {
    hermesHome: path.join(home, '.hermes-cindy'),
    harnessDir: path.join(home, '.cindy-harness'),
    appLogDir,
  };
}

export function defaultHousekeepingFile(home: string = os.homedir()): string {
  return path.join(home, '.cindy-harness', 'housekeeping.json');
}

export function readHousekeepingSettings(file: string): HousekeepingSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return {
      retentionDays: normalizeRetentionDays(raw?.retentionDays),
      pruneAtStartup: raw?.pruneAtStartup === true,
    };
  } catch {
    return { retentionDays: DEFAULT_RETENTION_DAYS, pruneAtStartup: false };
  }
}

/** Atomic write: a temp file beside the target, then rename (AGENTS.md §4). */
export function writeHousekeepingSettings(file: string, next: HousekeepingSettings): HousekeepingSettings {
  const settings: HousekeepingSettings = {
    retentionDays: normalizeRetentionDays(next.retentionDays),
    pruneAtStartup: next.pruneAtStartup === true,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return settings;
}

interface WalkResult {
  bytes: number;
  newestMs: number;
  oldestMs: number;
}

const EMPTY_WALK: WalkResult = { bytes: 0, newestMs: 0, oldestMs: 0 };

/** Sums regular-file sizes below `dir`. Symlinks are never traversed. */
function walkSizes(dir: string, deadline: number, state: { truncated: boolean }, clock: () => number): WalkResult {
  let bytes = 0;
  let newestMs = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  const stack = [dir];
  while (stack.length > 0) {
    if (clock() > deadline) {
      state.truncated = true;
      break;
    }
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        bytes += st.size;
      }
    }
  }
  return { bytes, newestMs, oldestMs: Number.isFinite(oldestMs) ? oldestMs : 0 };
}

function bucketOf(result: WalkResult, count: number): StorageBucket {
  return {
    count,
    totalBytes: result.bytes,
    ...(result.newestMs > 0 ? { newestMs: result.newestMs } : {}),
    ...(result.oldestMs > 0 ? { oldestMs: result.oldestMs } : {}),
  };
}

/**
 * Newest mtime of a home dir and its direct entries, ignoring files that a mere OPEN refreshes.
 * SQLite touches `state.db-shm` (and the `.lock` files) whenever a process opens the database,
 * so counting them made every home look used today and retention never fired (observed live
 * 2026-11-14: all 169 homes < 1 day idle while their transcripts were 9 days old). `-wal` is kept:
 * it only moves on a real write.
 */
const OPEN_TOUCHED = /(?:-shm|\.lock)$/;

function homeIdleMs(home: string): number {
  let newest = 0;
  try {
    newest = fs.lstatSync(home).mtimeMs;
    for (const name of fs.readdirSync(home)) {
      if (OPEN_TOUCHED.test(name)) continue;
      try {
        const st = fs.lstatSync(path.join(home, name));
        if (!st.isSymbolicLink() && st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // An unreadable entry must not make the home look idle.
      }
    }
  } catch {
    return 0;
  }
  return newest;
}

interface RegistryRecord {
  sessionId: string;
  hermesSessionId?: string;
  running: boolean;
}

function readRegistry(file: string): RegistryRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const list = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>);
    const out: RegistryRecord[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Record<string, unknown>;
      if (typeof r.sessionId !== 'string' || !r.sessionId) continue;
      out.push({
        sessionId: r.sessionId,
        running: r.running === true,
        ...(typeof r.hermesSessionId === 'string' && r.hermesSessionId ? { hermesSessionId: r.hermesSessionId } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

export interface ScanDeps {
  roots: HousekeepingRoots;
  settingsFile: string;
  /** Daemon session ids that are open or running right now, supplied by the caller. */
  protectedSessionIds?: () => readonly string[];
  /** Cindy conversation status + protection, joined through the registry (13.2c). */
  facts?: ConversationFacts;
  /** Populate `keeps` too. Only the prune path needs them; a Settings scan stays small. */
  includeKeeps?: boolean;
  now?: () => number;
  budgetMs?: number;
}

/** Measures the roots and plans (never performs) a prune. */
export function scanStorage(deps: ScanDeps): StorageView {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const deadline = now + (deps.budgetMs ?? HOUSEKEEPING_SCAN_BUDGET_MS);
  const state = { truncated: false };
  const settings = readHousekeepingSettings(deps.settingsFile);
  const { hermesHome, harnessDir, appLogDir } = deps.roots;
  const homesRoot = path.join(hermesHome, 'session-homes');
  const registryFile = path.join(hermesHome, 'hermes-mgr', 'sessions.json');
  const registry = readRegistry(registryFile);
  // A registry written after a home's last activity proves the missing record is authoritative,
  // so the reaper's 24 h unflushed-record guard is not needed for that home (ADR 0014 addendum).
  const registryWrittenMs = lstatOrNull(registryFile)?.mtimeMs ?? 0;
  const owners = new Set(registry.map((r) => r.sessionId));
  const protectedIds = new Set(registry.filter((r) => r.running).map((r) => r.sessionId));
  for (const id of deps.protectedSessionIds?.() ?? []) protectedIds.add(id);
  // The home is named by the daemon id; Cindy's row is reached through hermesSessionId.
  const statusByDaemonId = new Map<string, ConversationStatus>();
  for (const record of registry) {
    const fact = record.hermesSessionId ? deps.facts?.bySdkSessionId[record.hermesSessionId] : undefined;
    if (!fact) continue;
    if (fact.protected) protectedIds.add(record.sessionId);
    statusByDaemonId.set(record.sessionId, fact.status);
  }
  const statusOf = (owner: string | undefined): { conversationStatus?: ConversationStatus } => {
    const status = owner ? statusByDaemonId.get(owner) : undefined;
    return status ? { conversationStatus: status } : {};
  };

  const candidates: HousekeepingCandidate[] = [];
  let homeCount = 0;
  let homeBytes = 0;
  let homeNewest = 0;
  let homeOldest = Number.POSITIVE_INFINITY;
  let orphanCount = 0;
  let orphanBytes = 0;
  let catalogCount = 0;
  let catalogBytes = 0;

  for (const name of readdirOrEmpty(homesRoot)) {
    if (clock() > deadline) {
      state.truncated = true;
      break;
    }
    const home = path.join(homesRoot, name);
    const st = lstatOrNull(home);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    const idle = homeIdleMs(home);
    const sized = walkSizes(home, deadline, state, clock);
    homeCount += 1;
    homeBytes += sized.bytes;
    if (idle > homeNewest) homeNewest = idle;
    if (idle < homeOldest) homeOldest = idle;

    const owner = HOME_NAME.exec(name)?.[1];
    const isOrphan = !owner || !owners.has(owner);
    if (isOrphan) {
      orphanCount += 1;
      orphanBytes += sized.bytes;
      candidates.push({
        path: home, root: homesRoot, kind: 'session-home', sizeBytes: sized.bytes,
        idleSinceMs: idle, isSymlink: false, isDirectory: true, isRegularFile: false,
        registryFlushedAfterIdle: registryWrittenMs > idle,
      });
    }
    // Re-creatable bulk inside the home. The home's idle time governs, not the file's own age.
    // An orphan home is planned as a whole; listing its interior too would double-count it.
    if (!isOrphan) {
      // The etag must go with the catalog: a surviving validator could make Hermes accept a
      // 304 for a file that is no longer there.
      for (const entry of ['models_dev_cache.json', 'models_dev_cache.etag']) {
        const target = path.join(home, entry);
        const cst = lstatOrNull(target);
        if (!cst || !cst.isFile() || cst.isSymbolicLink()) continue;
        if (entry === 'models_dev_cache.json') {
          catalogCount += 1;
          catalogBytes += cst.size;
        }
        candidates.push({
          path: target, root: homesRoot, kind: 'home-model-catalog', sizeBytes: cst.size,
          idleSinceMs: idle, isSymlink: false, isDirectory: false, isRegularFile: true,
          ...(owner ? { ownerSessionId: owner } : {}), ...statusOf(owner),
        });
      }
    }
    if (isOrphan) continue;
    for (const [rel, kind] of [['cache/uv', 'home-uv-cache'], ['logs', 'home-logs']] as const) {
      const target = path.join(home, rel);
      const tst = lstatOrNull(target);
      if (!tst || tst.isSymbolicLink() || !tst.isDirectory()) continue;
      const walked = walkSizes(target, deadline, state, clock);
      candidates.push({
        path: target, root: homesRoot, kind, sizeBytes: walked.bytes,
        idleSinceMs: idle, isSymlink: false, isDirectory: true, isRegularFile: false,
        ...(owner ? { ownerSessionId: owner } : {}), ...statusOf(owner),
      });
    }
    for (const entry of readdirOrEmpty(path.join(home, 'cache'))) {
      if (!entry.endsWith('.json')) continue;
      const target = path.join(home, 'cache', entry);
      const cst = lstatOrNull(target);
      if (!cst || !cst.isFile() || cst.isSymbolicLink()) continue;
      candidates.push({
        path: target, root: homesRoot, kind: 'home-cache-catalog', sizeBytes: cst.size,
        idleSinceMs: idle, isSymlink: false, isDirectory: false, isRegularFile: true,
        ...(owner ? { ownerSessionId: owner } : {}), ...statusOf(owner),
      });
    }
  }

  const cacheRoot = path.join(hermesHome, 'cache');
  const hermesCache = bucketOf(walkSizes(cacheRoot, deadline, state, clock), 1);
  const uvRoot = path.join(cacheRoot, 'uv');
  const uvWalk = walkSizes(uvRoot, deadline, state, clock);
  const hermesUvCache = bucketOf(uvWalk, 1);
  const uvStat = lstatOrNull(uvRoot);
  if (uvStat && uvStat.isDirectory() && !uvStat.isSymbolicLink()) {
    candidates.push({
      path: uvRoot, root: hermesHome, kind: 'base-uv-cache', sizeBytes: uvWalk.bytes,
      idleSinceMs: uvWalk.newestMs, isSymlink: false, isDirectory: true, isRegularFile: false,
    });
  }
  // Remote-fetched or recomputed catalogs beside the uv cache (ADR 0014 Tier 1).
  for (const entry of readdirOrEmpty(cacheRoot)) {
    if (!entry.endsWith('.json')) continue;
    const target = path.join(cacheRoot, entry);
    const cst = lstatOrNull(target);
    if (!cst || !cst.isFile() || cst.isSymbolicLink()) continue;
    candidates.push({
      path: target, root: hermesHome, kind: 'base-cache-catalog', sizeBytes: cst.size,
      idleSinceMs: cst.mtimeMs, isSymlink: false, isDirectory: false, isRegularFile: true,
    });
  }

  let backupCount = 0;
  let backupBytes = 0;
  for (const name of readdirOrEmpty(harnessDir)) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;
    const full = path.join(harnessDir, name);
    const st = lstatOrNull(full);
    if (!st) continue;
    const bytes = st.isDirectory() && !st.isSymbolicLink()
      ? walkSizes(full, deadline, state, clock).bytes
      : st.size;
    backupCount += 1;
    backupBytes += bytes;
    candidates.push({
      path: full, root: harnessDir, kind: 'harness-backup', sizeBytes: bytes,
      idleSinceMs: st.mtimeMs, isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(),
      isRegularFile: st.isFile(), backupBase: match[1]!,
    });
  }

  const appLogs = bucketOf(walkSizes(appLogDir, deadline, state, clock), 1);
  let devLogCount = 0;
  let devLogBytes = 0;
  for (const name of readdirOrEmpty(appLogDir)) {
    if (!DEV_TERMINAL_LOG.test(name)) continue;
    const full = path.join(appLogDir, name);
    const st = lstatOrNull(full);
    if (!st) continue;
    devLogCount += 1;
    const bytes = st.isFile() ? st.size : 0;
    devLogBytes += bytes;
    candidates.push({
      path: full, root: appLogDir, kind: 'dev-terminal-log', sizeBytes: bytes,
      idleSinceMs: st.mtimeMs, isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(),
      isRegularFile: st.isFile(),
    });
  }

  const plan = planHousekeeping(candidates, now, settings.retentionDays, protectedIds);
  return {
    settings,
    sessionHomes: {
      count: homeCount,
      totalBytes: homeBytes,
      ...(homeNewest > 0 ? { newestMs: homeNewest } : {}),
      ...(Number.isFinite(homeOldest) ? { oldestMs: homeOldest } : {}),
    },
    orphanHomes: { count: orphanCount, totalBytes: orphanBytes },
    modelCatalogCopies: { count: catalogCount, totalBytes: catalogBytes },
    hermesCache,
    hermesUvCache,
    harnessBackups: { count: backupCount, totalBytes: backupBytes },
    appLogs,
    devTerminalLogs: { count: devLogCount, totalBytes: devLogBytes },
    preview: plan.decisions.filter((d) => d.action === 'delete'),
    keeps: deps.includeKeeps ? plan.decisions.filter((d) => d.action === 'keep') : [],
    reclaimableItems: plan.deleteCount,
    estimatedFreedBytes: plan.estimatedFreedBytes,
    scannedAt: now,
    truncated: state.truncated,
  };
}

// ── Prune (ROADMAP 13.2c) ──────────────────────────────────────────────────────────────────────

export interface PruneDeps {
  roots: HousekeepingRoots;
  settingsFile: string;
  protectedSessionIds?: () => readonly string[];
  facts?: ConversationFacts;
  now?: () => number;
  /** Test seam. Defaults to the reaper's own guarded stop, which verifies the pid is Hermes. */
  stopGateway?: (home: string) => Promise<StopGatewayResult>;
  /** Test seam. Defaults to a recursive removal that never follows a symlink. */
  remove?: (target: string) => void;
}

export interface PruneRequest {
  /** The exact paths the owner saw in the preview and confirmed. Nothing else is touched. */
  confirmedPaths: readonly string[];
}

export interface PruneResult {
  deleted: HousekeepingDecision[];
  /** Every keep, every unconfirmed item and every refusal, each with its reason. */
  skipped: HousekeepingDecision[];
  errors: { path: string; message: string }[];
  /** Sum of the removed candidates' sizes: a du estimate, not measured free space (ADR 0014). */
  freedBytes: number;
  /** Real free-space delta on the Hermes volume. APFS clones can make this smaller. */
  measuredFreedBytes: number | null;
  prunedAt: number;
}

/** Tier 3 refusals keep their own wording; anything else that dropped out is simply stale. */
const HARD_REFUSALS: ReadonlySet<string> = new Set([
  'symlink-never-followed',
  'not-a-regular-file-or-directory',
  'transcript-never-pruned',
  'outside-root',
  'unexpected-home-name',
]);

function defaultRemove(target: string): void {
  fs.rmSync(target, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
}

function availableBytes(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

/**
 * Classifies a confirmed path the fresh plan no longer wants to remove, so the result can say
 * WHY it was skipped instead of silently dropping it. The planner stays the authority.
 */
function unplannedCandidate(target: string, roots: HousekeepingRoots, st: fs.Stats): HousekeepingCandidate | null {
  const homesRoot = path.join(roots.hermesHome, 'session-homes');
  const parent = path.dirname(target);
  const name = path.basename(target);
  const base = {
    path: target,
    sizeBytes: st.isDirectory() ? 0 : st.size,
    idleSinceMs: st.mtimeMs,
    isSymlink: st.isSymbolicLink(),
    isDirectory: st.isDirectory(),
    isRegularFile: st.isFile(),
  };
  if (parent === homesRoot) return { ...base, root: homesRoot, kind: 'session-home' };
  if (target.startsWith(homesRoot + path.sep)) return { ...base, root: homesRoot, kind: 'home-logs' };
  if (parent === roots.harnessDir) {
    const backupBase = BACKUP_NAME.exec(name)?.[1];
    return { ...base, root: roots.harnessDir, kind: 'harness-backup', ...(backupBase ? { backupBase } : {}) };
  }
  if (parent === roots.appLogDir) return { ...base, root: roots.appLogDir, kind: 'dev-terminal-log' };
  if (parent === path.join(roots.hermesHome, 'cache')) return { ...base, root: roots.hermesHome, kind: 'base-cache-catalog' };
  return null;
}

function skipReasonFor(target: string, deps: PruneDeps, now: number, retentionDays: number): HousekeepingDecision {
  const st = lstatOrNull(target);
  const fallback: HousekeepingDecision = {
    path: target, kind: 'session-home', action: 'keep', reason: 'no-longer-eligible', sizeBytes: 0,
  };
  if (!st) return { ...fallback, reason: 'already-gone' };
  const candidate = unplannedCandidate(target, deps.roots, st);
  if (!candidate) return { ...fallback, reason: 'outside-root', sizeBytes: st.size };
  const decision = planHousekeeping([candidate], now, retentionDays).decisions[0]!;
  if (decision.action === 'delete' || !HARD_REFUSALS.has(decision.reason)) {
    return { ...decision, action: 'keep', reason: 'no-longer-eligible' };
  }
  return decision;
}

async function executePrune(view: StorageView, deps: PruneDeps, confirmedPaths: readonly string[]): Promise<PruneResult> {
  const now = (deps.now ?? Date.now)();
  const confirmed = new Set(confirmedPaths);
  const stopGateway = deps.stopGateway ?? ((home: string) => stopSessionGateway(home));
  const remove = deps.remove ?? defaultRemove;
  const deleted: HousekeepingDecision[] = [];
  const skipped: HousekeepingDecision[] = [...view.keeps];
  const errors: { path: string; message: string }[] = [];
  let freedBytes = 0;
  const before = availableBytes(deps.roots.hermesHome);

  for (const decision of view.preview) {
    if (!confirmed.has(decision.path)) {
      skipped.push({ ...decision, action: 'keep', reason: 'not-confirmed' });
      continue;
    }
    // Re-check at execution time: the preview the owner confirmed may be minutes old.
    const st = lstatOrNull(decision.path);
    if (!st) {
      skipped.push({ ...decision, action: 'keep', reason: 'already-gone' });
      continue;
    }
    if (st.isSymbolicLink()) {
      skipped.push({ ...decision, action: 'keep', reason: 'symlink-never-followed' });
      continue;
    }
    if (TRANSCRIPT_BASENAMES.has(path.basename(decision.path))) {
      skipped.push({ ...decision, action: 'keep', reason: 'transcript-never-pruned' });
      continue;
    }
    if (decision.kind === 'session-home') {
      if (!HOME_NAME.test(path.basename(decision.path))) {
        skipped.push({ ...decision, action: 'keep', reason: 'unexpected-home-name' });
        continue;
      }
      const stop = await stopGateway(decision.path);
      if (!stop.stopped && stop.reason !== 'no-pid-file' && stop.reason !== 'not-running') {
        skipped.push({ ...decision, action: 'keep', reason: 'gateway-still-running' });
        continue;
      }
    }
    try {
      remove(decision.path);
      deleted.push(decision);
      freedBytes += decision.sizeBytes;
    } catch (error) {
      errors.push({ path: decision.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const planned = new Set(view.preview.map((d) => d.path));
  for (const target of confirmed) {
    if (planned.has(target)) continue;
    skipped.push(skipReasonFor(target, deps, now, view.settings.retentionDays));
  }

  const after = availableBytes(deps.roots.hermesHome);
  return {
    deleted,
    skipped,
    errors,
    freedBytes,
    measuredFreedBytes: before !== null && after !== null ? after - before : null,
    prunedAt: now,
  };
}

/**
 * Prunes what the owner confirmed. The plan is rebuilt from disk first, so a stale preview can
 * never authorise a removal the current state does not allow.
 */
export async function pruneStorage(deps: PruneDeps, request: PruneRequest): Promise<PruneResult> {
  const view = scanStorage({ ...deps, includeKeeps: true });
  return executePrune(view, deps, request.confirmedPaths);
}

/**
 * Optional startup run, off by default. No window is open yet, so "open in the UI" cannot be
 * known: every registered session is protected (fail closed on safety, AGENTS.md §6.3). Orphan
 * homes, base caches and old backups still go. Returns null when the owner has not enabled it.
 */
export async function runStartupHousekeeping(deps: PruneDeps): Promise<PruneResult | null> {
  if (!readHousekeepingSettings(deps.settingsFile).pruneAtStartup) return null;
  const registry = readRegistry(path.join(deps.roots.hermesHome, 'hermes-mgr', 'sessions.json'));
  const registered = registry.map((r) => r.sessionId);
  const view = scanStorage({
    ...deps,
    includeKeeps: true,
    protectedSessionIds: () => [...registered, ...(deps.protectedSessionIds?.() ?? [])],
  });
  return executePrune(view, deps, view.preview.map((d) => d.path));
}

// ── IPC ────────────────────────────────────────────────────────────────────────────────────────

export interface HousekeepingHandlerDeps extends PruneDeps {
  assertTrusted: (event: unknown) => void;
  channels: { SCAN: string; SET_RETENTION: string; PRUNE: string; SET_PRUNE_AT_STARTUP: string };
  /** Async DB read, supplied by the caller; the scan itself stays synchronous. */
  conversationFacts?: () => Promise<ConversationFacts>;
}

interface HandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

function parseConfirmedPaths(request: unknown): string[] {
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const paths = r.confirmedPaths;
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new Error('confirmedPaths must be an array of strings');
  }
  return paths as string[];
}

export function registerHousekeepingHandlers(registry: HandlerRegistry, deps: HousekeepingHandlerDeps): void {
  const facts = async (): Promise<ConversationFacts | undefined> => {
    if (!deps.conversationFacts) return undefined;
    try {
      return await deps.conversationFacts();
    } catch {
      // Without the join we cannot tell a soft-deleted home from a live one. Fail closed:
      // an empty fact set leaves every registered home's status unknown, so no whole home
      // of a registered session is ever removed.
      return { bySdkSessionId: {} };
    }
  };

  const scan = async (): Promise<StorageView> => {
    const resolved = await facts();
    return scanStorage({
      roots: deps.roots,
      settingsFile: deps.settingsFile,
      ...(deps.protectedSessionIds ? { protectedSessionIds: deps.protectedSessionIds } : {}),
      ...(resolved ? { facts: resolved } : {}),
    });
  };

  registry.handle(deps.channels.SCAN, async (event) => {
    deps.assertTrusted(event);
    return scan();
  });

  registry.handle(deps.channels.SET_RETENTION, async (event, request) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    if (typeof r.retentionDays !== 'number' || !Number.isFinite(r.retentionDays)) {
      throw new Error('retentionDays must be a number');
    }
    const current = readHousekeepingSettings(deps.settingsFile);
    writeHousekeepingSettings(deps.settingsFile, { ...current, retentionDays: r.retentionDays });
    // Re-scan so the preview reflects the retention the owner just chose.
    return scan();
  });

  registry.handle(deps.channels.PRUNE, async (event, request) => {
    deps.assertTrusted(event);
    const confirmedPaths = parseConfirmedPaths(request);
    const resolved = await facts();
    return pruneStorage({ ...deps, ...(resolved ? { facts: resolved } : {}) }, { confirmedPaths });
  });

  registry.handle(deps.channels.SET_PRUNE_AT_STARTUP, async (event, request) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const current = readHousekeepingSettings(deps.settingsFile);
    writeHousekeepingSettings(deps.settingsFile, { ...current, pruneAtStartup: r.enabled === true });
    return scan();
  });
}
