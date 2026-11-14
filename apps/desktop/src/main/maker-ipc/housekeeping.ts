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
  type HousekeepingCandidate,
  type HousekeepingDecision,
} from '@cindy/maker-core/housekeeping';

/**
 * The walk is synchronous on the main process, so the cap bounds UI blocking. Measured 1.1 s for
 * 169 homes / 4.4 GB on 2026-11-14; 4 s leaves headroom without freezing Settings for long.
 */
export const HOUSEKEEPING_SCAN_BUDGET_MS = 4000;

/** Same shape guard as `reapOrphanHomes`: the owner id is the home name minus `-<10 hex>`. */
const HOME_NAME = /^(.+)-[0-9a-f]{10}$/;
const BACKUP_NAME = /^(.+)\.bak[-.]/;
const DEV_TERMINAL_LOG = /^dev-terminal.*\.log$/;

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

function readRegistry(file: string): { sessionId: string; running: boolean }[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const list = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>);
    const out: { sessionId: string; running: boolean }[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Record<string, unknown>;
      if (typeof r.sessionId !== 'string' || !r.sessionId) continue;
      out.push({ sessionId: r.sessionId, running: r.running === true });
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
  /** Cindy session ids that are open or running right now, mapped to their daemon ids by the caller. */
  protectedSessionIds?: () => readonly string[];
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
  const registry = readRegistry(path.join(hermesHome, 'hermes-mgr', 'sessions.json'));
  const owners = new Set(registry.map((r) => r.sessionId));
  const protectedIds = new Set(registry.filter((r) => r.running).map((r) => r.sessionId));
  for (const id of deps.protectedSessionIds?.() ?? []) protectedIds.add(id);

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
      });
    }
    // Re-creatable bulk inside the home. The home's idle time governs, not the file's own age.
    const catalog = path.join(home, 'models_dev_cache.json');
    const cst = lstatOrNull(catalog);
    if (cst && cst.isFile() && !cst.isSymbolicLink()) {
      catalogCount += 1;
      catalogBytes += cst.size;
      // An orphan home is planned as a whole; listing its interior too would double-count it.
      if (!isOrphan) {
        candidates.push({
          path: catalog, root: homesRoot, kind: 'home-model-catalog', sizeBytes: cst.size,
          idleSinceMs: idle, isSymlink: false, isDirectory: false, isRegularFile: true,
          ...(owner ? { ownerSessionId: owner } : {}),
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
        ...(owner ? { ownerSessionId: owner } : {}),
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
    reclaimableItems: plan.deleteCount,
    estimatedFreedBytes: plan.estimatedFreedBytes,
    scannedAt: now,
    truncated: state.truncated,
  };
}

// ── IPC ────────────────────────────────────────────────────────────────────────────────────────

export interface HousekeepingHandlerDeps {
  roots: HousekeepingRoots;
  settingsFile: string;
  assertTrusted: (event: unknown) => void;
  channels: { SCAN: string; SET_RETENTION: string };
  protectedSessionIds?: () => readonly string[];
}

interface HandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export function registerHousekeepingHandlers(registry: HandlerRegistry, deps: HousekeepingHandlerDeps): void {
  const scan = (): StorageView => scanStorage({
    roots: deps.roots,
    settingsFile: deps.settingsFile,
    ...(deps.protectedSessionIds ? { protectedSessionIds: deps.protectedSessionIds } : {}),
  });

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
}
