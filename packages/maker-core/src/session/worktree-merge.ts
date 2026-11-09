/**
 * ROADMAP 9.2a — worktree merge safety and diff summary.
 * ---------------------------------------------------------------------------
 * A worktree session already runs in its own checkout, so the owner's working
 * copy stays clean. What is missing is the way back: a reviewed diff and a merge
 * into the base branch. Merging into someone's working tree is the one genuinely
 * destructive action in this feature, so the decision is pure, exhaustive and
 * testable before any git command runs.
 *
 * Nothing here executes git. `assessWorktreeMerge` returns the exact argv the
 * caller should run, so the decision and the command cannot drift apart.
 */

export type WorktreeMergeMethod = 'fast-forward' | 'merge' | 'none';

export type WorktreeMergeReason =
  | 'ok'
  | 'same-branch'
  | 'target-dirty'
  | 'nothing-to-merge'
  | 'known-conflict';

export interface WorktreeMergeInput {
  /** Branch checked out in the base repo, e.g. `main`. */
  baseBranch: string;
  /** Branch checked out in the worktree, e.g. `cindy/task-abc`. */
  worktreeBranch: string;
  /** Uncommitted files in the base working tree (`git status --porcelain` count). */
  targetDirtyFiles: number;
  /** Commits on the worktree branch that base does not have. */
  aheadCount: number;
  /** Commits on base that the worktree branch does not have. */
  behindCount: number;
  /** True when base is an ancestor of the worktree branch, so `--ff-only` works. */
  baseIsAncestor: boolean;
  /** Set when a dry-run merge already reported conflicts. */
  knownConflict?: boolean;
}

export interface WorktreeMergeDecision {
  allowed: boolean;
  method: WorktreeMergeMethod;
  reason: WorktreeMergeReason;
  /** One sentence for the UI. Never claims more than the inputs prove. */
  message: string;
  /** argv for `git -C <baseRepo>`. Empty when the merge is refused. */
  args: readonly string[];
  /** True when a failed merge must be rolled back with `merge --abort`. */
  abortOnFailure: boolean;
}

/**
 * Decide whether the worktree branch can be merged into the base branch.
 *
 * Order matters. Identity and cleanliness are checked before anything else,
 * because those refusals are cheap and certain. A dirty base is always refused:
 * a merge into uncommitted work is how changes get lost.
 */
export function assessWorktreeMerge(input: WorktreeMergeInput): WorktreeMergeDecision {
  const base = input.baseBranch.trim();
  const branch = input.worktreeBranch.trim();

  if (base === '' || branch === '' || base === branch) {
    return refuse('same-branch', 'The worktree branch is the base branch. Nothing to merge.');
  }

  if (!Number.isFinite(input.targetDirtyFiles) || input.targetDirtyFiles > 0) {
    return refuse(
      'target-dirty',
      `${input.targetDirtyFiles} uncommitted file(s) in ${base}. Commit or stash them first.`,
    );
  }

  if (!Number.isFinite(input.aheadCount) || input.aheadCount <= 0) {
    return refuse('nothing-to-merge', `${branch} has no commits that ${base} is missing.`);
  }

  if (input.knownConflict) {
    return refuse(
      'known-conflict',
      `Merging ${branch} into ${base} conflicts. Resolve it in the worktree first.`,
    );
  }

  if (input.baseIsAncestor) {
    return {
      allowed: true,
      method: 'fast-forward',
      reason: 'ok',
      message: `Fast-forward ${base} to ${branch} (${input.aheadCount} commit(s)).`,
      args: ['merge', '--ff-only', '--no-edit', branch],
      abortOnFailure: false,
    };
  }

  return {
    allowed: true,
    method: 'merge',
    reason: 'ok',
    message: `Merge ${branch} into ${base} (${input.aheadCount} ahead, ${input.behindCount} behind). A conflict aborts and changes nothing.`,
    args: ['merge', '--no-edit', branch],
    abortOnFailure: true,
  };
}

function refuse(reason: WorktreeMergeReason, message: string): WorktreeMergeDecision {
  return { allowed: false, method: 'none', reason, message, args: [], abortOnFailure: false };
}

// ---------------------------------------------------------------------------
// Diff summary
// ---------------------------------------------------------------------------

export interface WorktreeDiffFile {
  /** Path relative to the repo root. For a rename this is the new path. */
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface WorktreeDiffSummary {
  fileCount: number;
  added: number;
  removed: number;
  binaryCount: number;
  /** Bounded list, so a huge diff cannot flood the UI. */
  files: WorktreeDiffFile[];
  truncated: boolean;
}

export const DEFAULT_DIFF_FILE_LIMIT = 200;

/**
 * Parse `git diff --numstat` output. Machine format, one file per line:
 * `added<TAB>removed<TAB>path`, with `-` for both counters on a binary file.
 */
export function parseWorktreeNumstat(text: string): WorktreeDiffFile[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const files: WorktreeDiffFile[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = Number.parseInt(parts[0], 10);
    const removed = Number.parseInt(parts[1], 10);
    const binary = Number.isNaN(added) || Number.isNaN(removed);
    const path = normaliseDiffPath(parts.slice(2).join('\t'));
    if (path === '') continue;
    files.push({
      path,
      added: binary ? 0 : added,
      removed: binary ? 0 : removed,
      binary,
    });
  }
  return files;
}

/**
 * `git diff --numstat` writes a rename as `old => new`, and inside a shared
 * directory as `dir/{old => new}/file`. Keep the destination path, because that
 * is the file that exists after the merge.
 */
export function normaliseDiffPath(raw: string): string {
  const path = raw.trim();
  if (path === '') return '';
  const braced = path.replace(/\{([^{}]*) => ([^{}]*)\}/u, '$2');
  if (braced !== path) return braced.replace(/\/{2,}/gu, '/');
  const arrow = path.lastIndexOf(' => ');
  return arrow >= 0 ? path.slice(arrow + 4).trim() : path;
}

export function summariseWorktreeDiff(
  files: readonly WorktreeDiffFile[],
  options?: { maxFiles?: number },
): WorktreeDiffSummary {
  const limit = Math.max(0, options?.maxFiles ?? DEFAULT_DIFF_FILE_LIMIT);
  let added = 0;
  let removed = 0;
  let binaryCount = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
    if (file.binary) binaryCount += 1;
  }
  return {
    fileCount: files.length,
    added,
    removed,
    binaryCount,
    files: files.slice(0, limit),
    truncated: files.length > limit,
  };
}
