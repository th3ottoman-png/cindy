/**
 * ROADMAP 9.2b — Worktree diff and merge-back host implementation.
 * ---------------------------------------------------------------------------
 * Provides two operations for coding task worktrees:
 *  1. readWorktreeDiff: checks base repo & worktree status, ahead/behind counts,
 *     whether base is an ancestor, parses `git diff --numstat` between the base
 *     branch and the worktree, and runs `assessWorktreeMerge` to provide safe UI advice.
 *  2. mergeWorktree: auto-commits uncommitted worktree changes, verifies base repo
 *     cleanliness, validates with `assessWorktreeMerge`, runs the exact argv in the
 *     base repo, and rolls back with `git merge --abort` on conflict when abortOnFailure is true.
 */

import { gitExec, GitExecError, type GitExecOpts } from './gitExec';
import {
  assessWorktreeMerge,
  parseWorktreeNumstat,
  summariseWorktreeDiff,
  type WorktreeDiffSummary,
  type WorktreeMergeDecision,
  type WorktreeMergeMethod,
} from '@cindy/maker-core/worktree-merge';
import type { WorktreeMeta } from './types';
import { createLogger } from '../logger';

const log = createLogger('worktreeMerge');

const localOpts: GitExecOpts = { timeoutMs: 10_000, extraEnv: { LC_ALL: 'C' } };
const writeOpts: GitExecOpts = {
  timeoutMs: 30_000,
  extraEnv: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
};

export interface WorktreeDiffResponse {
  ok: boolean;
  hasWorktree: boolean;
  meta?: WorktreeMeta;
  baseBranch?: string;
  worktreeBranch?: string;
  ahead?: number;
  behind?: number;
  baseIsAncestor?: boolean;
  targetDirtyFiles?: number;
  worktreeDirtyFiles?: number;
  decision?: WorktreeMergeDecision;
  summary?: WorktreeDiffSummary;
  rawDiff?: string;
  message?: string;
}

export interface WorktreeMergeResponse {
  ok: boolean;
  method: WorktreeMergeMethod;
  message: string;
  decision: WorktreeMergeDecision;
  details?: string;
}

export type WorktreeSessionResolver = (
  sessionId: string,
) => WorktreeMeta | null | Promise<WorktreeMeta | null>;

export interface WorktreeMergeDeps {
  getForSession?: WorktreeSessionResolver;
  gitExecFn?: typeof gitExec;
}

async function resolveWorktree(
  sessionId: string,
  deps?: WorktreeMergeDeps,
): Promise<WorktreeMeta | null> {
  if (deps?.getForSession) {
    return deps.getForSession(sessionId);
  }
  const manager = await import('./WorktreeManager');
  return manager.getForSession(sessionId);
}

/**
 * Read the diff and merge safety assessment for the worktree bound to sessionId.
 */
export async function readWorktreeDiff(
  sessionId: string,
  deps?: WorktreeMergeDeps,
): Promise<WorktreeDiffResponse> {
  const meta = await resolveWorktree(sessionId, deps);
  if (!meta) {
    return {
      ok: true,
      hasWorktree: false,
      message: 'No worktree bound to session',
    };
  }

  const runGit = deps?.gitExecFn ?? gitExec;

  // 1. Detect base branch currently checked out in baseRepo
  let baseBranch = meta.sourceBranch;
  try {
    const headRef = (
      await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], meta.baseRepo, localOpts)
    ).stdout.trim();
    if (headRef && headRef !== 'HEAD') {
      baseBranch = headRef;
    }
  } catch (err) {
    log.warn('Could not detect base repo branch, falling back to sourceBranch:', err);
  }

  // 2. Count uncommitted files in base repo (dirty check)
  let targetDirtyFiles = 0;
  try {
    const basePorcelain = (
      await runGit(
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        meta.baseRepo,
        localOpts,
      )
    ).stdout;
    targetDirtyFiles = basePorcelain.split('\0').filter(Boolean).length;
  } catch (err) {
    log.warn('Could not read base repo dirty status:', err);
    targetDirtyFiles = Number.NaN;
  }

  // 3. Count uncommitted files in worktree
  let worktreeDirtyFiles = 0;
  let worktreePorcelain = '';
  try {
    worktreePorcelain = (
      await runGit(
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        meta.path,
        localOpts,
      )
    ).stdout;
    worktreeDirtyFiles = worktreePorcelain.split('\0').filter(Boolean).length;
  } catch (err) {
    log.warn('Could not read worktree dirty status:', err);
  }

  // 4. Ahead & behind count between baseBranch and worktree branch
  let ahead = 0;
  let behind = 0;
  try {
    const revCounts = (
      await runGit(
        [
          'rev-list',
          '--left-right',
          '--count',
          `refs/heads/${baseBranch}...refs/heads/${meta.branch}`,
        ],
        meta.baseRepo,
        localOpts,
      )
    ).stdout.trim();
    const parts = revCounts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    if (parts.length >= 2) {
      behind = parts[0];
      ahead = parts[1];
    }
  } catch {
    try {
      const revCounts = (
        await runGit(
          ['rev-list', '--left-right', '--count', `${baseBranch}...${meta.branch}`],
          meta.baseRepo,
          localOpts,
        )
      ).stdout.trim();
      const parts = revCounts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
      if (parts.length >= 2) {
        behind = parts[0];
        ahead = parts[1];
      }
    } catch (err) {
      log.warn('Could not read ahead/behind count:', err);
    }
  }

  // 5. Check if base is ancestor of worktree branch (enables --ff-only)
  let baseIsAncestor = false;
  try {
    await runGit(
      ['merge-base', '--is-ancestor', `refs/heads/${baseBranch}`, `refs/heads/${meta.branch}`],
      meta.baseRepo,
      localOpts,
    );
    baseIsAncestor = true;
  } catch {
    baseIsAncestor = false;
  }

  // 6. Check for known merge conflicts if not an ancestor
  let knownConflict = false;
  if (ahead > 0 && behind > 0 && !baseIsAncestor) {
    try {
      await runGit(
        ['merge-tree', '--write-tree', `refs/heads/${baseBranch}`, `refs/heads/${meta.branch}`],
        meta.baseRepo,
        localOpts,
      );
    } catch (err) {
      if (err instanceof GitExecError && err.exitCode === 1) {
        knownConflict = true;
      }
    }
  }

  // 7. Parse diff
  let diffNumstat = '';
  let rawDiff = '';
  try {
    diffNumstat = (
      await runGit(['diff', '--numstat', `refs/heads/${baseBranch}`], meta.path, localOpts)
    ).stdout;
    rawDiff = (
      await runGit(['diff', '--stat', `refs/heads/${baseBranch}`], meta.path, localOpts)
    ).stdout;
  } catch {
    try {
      diffNumstat = (
        await runGit(
          ['diff', '--numstat', `refs/heads/${baseBranch}...refs/heads/${meta.branch}`],
          meta.baseRepo,
          localOpts,
        )
      ).stdout;
      rawDiff = (
        await runGit(
          ['diff', '--stat', `refs/heads/${baseBranch}...refs/heads/${meta.branch}`],
          meta.baseRepo,
          localOpts,
        )
      ).stdout;
    } catch (err) {
      log.warn('Could not generate diff output:', err);
    }
  }

  const diffFiles = parseWorktreeNumstat(diffNumstat);

  // If there are untracked files in worktree, include them in diffFiles
  for (const item of worktreePorcelain.split('\0')) {
    if (item.startsWith('?? ')) {
      const untrackedPath = item.slice(3).trim();
      if (untrackedPath && !diffFiles.some((f) => f.path === untrackedPath)) {
        diffFiles.push({
          path: untrackedPath,
          added: 1,
          removed: 0,
          binary: false,
        });
      }
    }
  }

  const summary = summariseWorktreeDiff(diffFiles);

  // 8. Compute merge decision
  const effectiveAhead = ahead > 0 ? ahead : (worktreeDirtyFiles > 0 ? 1 : 0);
  const decision = assessWorktreeMerge({
    baseBranch,
    worktreeBranch: meta.branch,
    targetDirtyFiles,
    aheadCount: effectiveAhead,
    behindCount: behind,
    baseIsAncestor,
    knownConflict,
  });

  return {
    ok: true,
    hasWorktree: true,
    meta,
    baseBranch,
    worktreeBranch: meta.branch,
    ahead,
    behind,
    baseIsAncestor,
    targetDirtyFiles,
    worktreeDirtyFiles,
    decision,
    summary,
    rawDiff,
  };
}

/**
 * Merge the worktree branch into the base repository's active branch.
 */
export async function mergeWorktree(
  sessionId: string,
  deps?: WorktreeMergeDeps,
): Promise<WorktreeMergeResponse> {
  const meta = await resolveWorktree(sessionId, deps);
  if (!meta) {
    return {
      ok: false,
      method: 'none',
      message: 'No worktree bound to session',
      decision: {
        allowed: false,
        method: 'none',
        reason: 'nothing-to-merge',
        message: 'No worktree found',
        args: [],
        abortOnFailure: false,
      },
    };
  }

  const runGit = deps?.gitExecFn ?? gitExec;

  // 1. Commit uncommitted worktree changes if any, so nothing is lost
  try {
    const worktreePorcelain = (
      await runGit(
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        meta.path,
        localOpts,
      )
    ).stdout;
    const worktreeDirtyFiles = worktreePorcelain.split('\0').filter(Boolean).length;
    if (worktreeDirtyFiles > 0) {
      await runGit(['add', '-A'], meta.path, writeOpts);
      await runGit(
        ['commit', '-m', `cindy: session edits on ${meta.branch}`, '--no-verify'],
        meta.path,
        writeOpts,
      );
    }
  } catch (err) {
    log.warn('Could not auto-commit pending worktree changes:', err);
  }

  // 2. Read base branch
  let baseBranch = meta.sourceBranch;
  try {
    const headRef = (
      await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], meta.baseRepo, localOpts)
    ).stdout.trim();
    if (headRef && headRef !== 'HEAD') {
      baseBranch = headRef;
    }
  } catch (err) {
    log.warn('Could not read base branch:', err);
  }

  // 3. Check base cleanliness (must be clean to prevent losing uncommitted base work)
  let targetDirtyFiles = 0;
  try {
    const basePorcelain = (
      await runGit(
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        meta.baseRepo,
        localOpts,
      )
    ).stdout;
    targetDirtyFiles = basePorcelain.split('\0').filter(Boolean).length;
  } catch (err) {
    log.warn('Could not read base dirty files:', err);
    targetDirtyFiles = Number.NaN;
  }

  // 4. Read ahead/behind
  let aheadCount = 0;
  let behindCount = 0;
  try {
    const revCounts = (
      await runGit(
        [
          'rev-list',
          '--left-right',
          '--count',
          `refs/heads/${baseBranch}...refs/heads/${meta.branch}`,
        ],
        meta.baseRepo,
        localOpts,
      )
    ).stdout.trim();
    const parts = revCounts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    if (parts.length >= 2) {
      behindCount = parts[0];
      aheadCount = parts[1];
    }
  } catch (err) {
    log.warn('Could not read ahead/behind count:', err);
  }

  // 5. Check baseIsAncestor
  let baseIsAncestor = false;
  try {
    await runGit(
      ['merge-base', '--is-ancestor', `refs/heads/${baseBranch}`, `refs/heads/${meta.branch}`],
      meta.baseRepo,
      localOpts,
    );
    baseIsAncestor = true;
  } catch {
    baseIsAncestor = false;
  }

  // 6. Check known conflict
  let knownConflict = false;
  if (aheadCount > 0 && behindCount > 0 && !baseIsAncestor) {
    try {
      await runGit(
        ['merge-tree', '--write-tree', `refs/heads/${baseBranch}`, `refs/heads/${meta.branch}`],
        meta.baseRepo,
        localOpts,
      );
    } catch (err) {
      if (err instanceof GitExecError && err.exitCode === 1) {
        knownConflict = true;
      }
    }
  }

  // 7. Assess merge
  const decision = assessWorktreeMerge({
    baseBranch,
    worktreeBranch: meta.branch,
    targetDirtyFiles,
    aheadCount,
    behindCount,
    baseIsAncestor,
    knownConflict,
  });

  if (!decision.allowed) {
    return {
      ok: false,
      method: decision.method,
      message: decision.message,
      decision,
    };
  }

  // 8. Execute merge args in baseRepo
  try {
    const result = await runGit(decision.args, meta.baseRepo, writeOpts);
    return {
      ok: true,
      method: decision.method,
      message: decision.message,
      decision,
      details: result.stdout.trim(),
    };
  } catch (err) {
    if (decision.abortOnFailure) {
      try {
        await runGit(['merge', '--abort'], meta.baseRepo, localOpts);
      } catch (abortErr) {
        log.warn('git merge --abort failed:', abortErr);
      }
    }
    const stderr =
      err instanceof GitExecError ? err.stderr : (err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      method: decision.method,
      message: `Merge failed: ${stderr.trim() || 'conflict detected'}`,
      decision,
    };
  }
}
