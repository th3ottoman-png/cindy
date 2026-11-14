/**
 * Storage housekeeping planner (ROADMAP 13.2b, ADR 0014).
 *
 * Pure by design: no I/O, no clock, no Electron. The desktop host scans the roots, lstats every
 * candidate and resolves who owns it; this module only decides keep/delete and says why.
 *
 * ADR 0014 tiers: re-creatable bulk and orphan homes may go; a transcript that a still-existing
 * conversation could need never does. The cross-restart resume defect (ROADMAP §Debt) is NOT a
 * licence to delete `state.db` — the planner stays safe if that defect is fixed.
 */

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same shape guard as `reapOrphanHomes`: a real home directory named `<id>-<10 hex>`. */
const SESSION_HOME_NAME = /^.+-[0-9a-f]{10}$/;

export type HousekeepingKind =
  | 'session-home'
  | 'home-model-catalog'
  | 'home-uv-cache'
  | 'home-cache-catalog'
  | 'home-logs'
  | 'base-uv-cache'
  | 'base-cache-catalog'
  | 'harness-backup'
  | 'dev-terminal-log'
  | 'home-artifact-dir';

/** Kinds that live inside a session home and therefore inherit its protection. */
const HOME_KINDS: ReadonlySet<HousekeepingKind> = new Set([
  'session-home',
  'home-model-catalog',
  'home-uv-cache',
  'home-cache-catalog',
  'home-logs',
  'home-artifact-dir',
]);

/**
 * ADR 0014 Tier 3, enforced here as well as in the host: the agent's transcript is never a
 * candidate, whatever kind it was labelled with.
 */
const TRANSCRIPT_NAMES: ReadonlySet<string> = new Set(['state.db', 'state.db-wal', 'state.db-shm']);

export type ConversationStatus = 'active' | 'archived' | 'deleted';

export interface HousekeepingCandidate {
  /** Absolute path of the candidate. */
  path: string;
  /** Absolute root the candidate must sit under; anything else is refused. */
  root: string;
  kind: HousekeepingKind;
  sizeBytes: number;
  /**
   * Reference time for retention. For home entries the host passes the HOME's newest mtime, not
   * the file's own, so an old catalog inside a home used yesterday is not pruned.
   */
  idleSinceMs: number;
  /** lstat facts. The planner never stats and never follows a link. */
  isSymlink: boolean;
  isDirectory: boolean;
  isRegularFile: boolean;
  /** Daemon session id that owns the home, when the registry still lists one. */
  ownerSessionId?: string;
  /** Cindy conversation status behind that owner, when it is known. */
  conversationStatus?: ConversationStatus;
  /** For backups: the base file this is a backup of (newest per base is always kept). */
  backupBase?: string;
  /** For artifact dirs: generated content inside. Non-empty means never prune (ADR 0014). */
  containsFiles?: boolean;
}

export interface HousekeepingDecision {
  path: string;
  kind: HousekeepingKind;
  action: 'keep' | 'delete';
  /** Stable machine-readable reason, shown in the preview and the result. */
  reason: string;
  sizeBytes: number;
}

export interface HousekeepingPlan {
  decisions: HousekeepingDecision[];
  deleteCount: number;
  keepCount: number;
  /** Sum of the delete candidates' sizes. A `du` estimate, not measured free space (ADR 0014). */
  estimatedFreedBytes: number;
}

/** Clamps a user-supplied retention to the supported range; anything unusable falls back to 30. */
export function normalizeRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.floor(value));
}

/** POSIX separators for comparison, so a Windows host path behaves the same. */
function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

/** True when `target` sits strictly below `root`, without escaping through `..`. */
function isWithinRoot(target: string, root: string): boolean {
  const t = normalizeSeparators(target);
  const r = normalizeSeparators(root);
  if (!t || !r || t === r) return false;
  const prefix = r.endsWith('/') ? r : r + '/';
  if (!t.startsWith(prefix)) return false;
  const rel = t.slice(prefix.length);
  return rel.length > 0 && !rel.split('/').includes('..');
}

function baseName(target: string): string {
  const parts = normalizeSeparators(target).split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Newest backup per base file. Ties break on the path so the plan is deterministic regardless of
 * scan order.
 */
function newestBackupPaths(candidates: readonly HousekeepingCandidate[]): Set<string> {
  const best = new Map<string, HousekeepingCandidate>();
  for (const c of candidates) {
    if (c.kind !== 'harness-backup' || !c.backupBase) continue;
    const current = best.get(c.backupBase);
    if (
      !current
      || c.idleSinceMs > current.idleSinceMs
      || (c.idleSinceMs === current.idleSinceMs && c.path > current.path)
    ) {
      best.set(c.backupBase, c);
    }
  }
  return new Set([...best.values()].map((c) => c.path));
}

function decide(
  candidate: HousekeepingCandidate,
  now: number,
  retentionDays: number,
  protectedIds: ReadonlySet<string>,
  newestBackups: ReadonlySet<string>,
): HousekeepingDecision {
  const base = {
    path: candidate.path,
    kind: candidate.kind,
    sizeBytes: candidate.sizeBytes,
  };
  const keep = (reason: string): HousekeepingDecision => ({ ...base, action: 'keep', reason });
  const del = (reason: string): HousekeepingDecision => ({ ...base, action: 'delete', reason });

  // Tier 3 first: a link is never followed and never resolved, whatever it points at.
  if (candidate.isSymlink) return keep('symlink-never-followed');
  // FIFOs, sockets and device nodes are not storage we may reclaim.
  if (!candidate.isDirectory && !candidate.isRegularFile) return keep('not-a-regular-file-or-directory');
  if (TRANSCRIPT_NAMES.has(baseName(candidate.path))) return keep('transcript-never-pruned');
  if (!isWithinRoot(candidate.path, candidate.root)) return keep('outside-root');
  if (candidate.kind === 'session-home' && !SESSION_HOME_NAME.test(baseName(candidate.path))) {
    return keep('unexpected-home-name');
  }
  if (now - candidate.idleSinceMs < retentionDays * DAY_MS) return keep('newer-than-retention');

  if (HOME_KINDS.has(candidate.kind)) {
    const owner = candidate.ownerSessionId;
    if (owner && protectedIds.has(owner)) return keep('protected-session');
    if (candidate.kind === 'session-home') {
      // No registry record: unreachable, exactly the reaper's own contract.
      if (!owner) return del('orphan-home');
      // Soft delete keeps the messages, so the conversation can come back (ADR 0014 Tier 2).
      if (candidate.conversationStatus === 'deleted') return keep('soft-deleted-transcript-kept');
      return keep('conversation-still-exists');
    }
    if (candidate.kind === 'home-artifact-dir' && candidate.containsFiles) {
      return keep('artifact-dir-not-empty');
    }
    // Re-creatable bulk inside an idle, unprotected home.
    return del('recreatable-home-bulk');
  }

  if (candidate.kind === 'harness-backup') {
    if (!candidate.backupBase) return keep('backup-base-unknown');
    if (newestBackups.has(candidate.path)) return keep('newest-backup-kept');
    return del('old-backup');
  }
  if (candidate.kind === 'dev-terminal-log') return del('old-dev-terminal-log');
  return del('recreatable-cache');
}

/**
 * Plans a prune. `protectedIds` are daemon session ids that are open, running, scheduled or
 * pinned; their homes and everything inside them are kept regardless of age.
 */
export function planHousekeeping(
  candidates: readonly HousekeepingCandidate[],
  now: number,
  retentionDays: number,
  protectedIds: Iterable<string> = [],
): HousekeepingPlan {
  const days = normalizeRetentionDays(retentionDays);
  const protectedSet = new Set(protectedIds);
  const newestBackups = newestBackupPaths(candidates);
  const decisions = candidates.map((c) => decide(c, now, days, protectedSet, newestBackups));
  let deleteCount = 0;
  let estimatedFreedBytes = 0;
  for (const d of decisions) {
    if (d.action !== 'delete') continue;
    deleteCount += 1;
    estimatedFreedBytes += d.sizeBytes;
  }
  return {
    decisions,
    deleteCount,
    keepCount: decisions.length - deleteCount,
    estimatedFreedBytes,
  };
}
