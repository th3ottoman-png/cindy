/**
 * ROADMAP 11.11 — Council review of a task worktree, and the gated "Merge to Main Worktree".
 *
 * - `readWorktreeCouncilFiles`: the task's own changes — committed, uncommitted and untracked —
 *   diffed against the merge-base with the base branch, so base-side progress is not reviewed.
 * - `WorktreeCouncilHost.run`: runs the 11.4 Council over those files with the owner's remembered
 *   reviewer selection. `auto` runs (after a turn ends) skip a diff that was already reviewed.
 * - `WorktreeCouncilHost.mergeAndCleanup`: re-reads the diff, requires a passing review of that
 *   exact diff (fail closed), merges with 9.2's `mergeWorktree`, then removes the worktree through
 *   the guarded recycle path and deletes the branch with `git branch -d` (refuses unless merged).
 *
 * Reviews are kept in memory: after a restart the next turn end (or "Run council") reviews again.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CouncilReviewer, CouncilVerdict } from '@cindy/maker-core/council-review';
import {
  assessCouncilGate,
  councilFilesFingerprint,
  splitUnifiedDiff,
  untrackedFilePatch,
  type CouncilGateDecision,
  type WorktreeCouncilFile,
} from '@cindy/maker-core/worktree-council';

import { createLogger } from '../logger';
import { gitExec, type GitExecOpts } from './gitExec';
import type { WorktreeMeta } from './types';
import { mergeWorktree, type WorktreeMergeResponse } from './worktreeMerge';

const log = createLogger('worktreeCouncil');

const readOpts: GitExecOpts = { timeoutMs: 15_000, extraEnv: { LC_ALL: 'C' } };
const writeOpts: GitExecOpts = {
  timeoutMs: 30_000,
  extraEnv: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
};
const MAX_UNTRACKED_BYTES = 200_000;

async function baseBranchOf(meta: WorktreeMeta, runGit: typeof gitExec): Promise<string> {
  try {
    const head = (
      await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], meta.baseRepo, readOpts)
    ).stdout.trim();
    if (head && head !== 'HEAD') return head;
  } catch {
    // fall through to the branch the worktree was cut from
  }
  return meta.sourceBranch;
}

export async function readWorktreeCouncilFiles(
  meta: WorktreeMeta,
  runGit: typeof gitExec = gitExec,
): Promise<WorktreeCouncilFile[]> {
  const baseBranch = await baseBranchOf(meta, runGit);
  const mergeBase = (
    await runGit(['merge-base', `refs/heads/${baseBranch}`, 'HEAD'], meta.path, readOpts)
  ).stdout.trim();
  // Working tree vs merge-base: the branch's commits plus uncommitted edits to tracked files.
  const diff = (
    await runGit(['diff', '--no-color', '--no-ext-diff', mergeBase], meta.path, readOpts)
  ).stdout;
  const files = splitUnifiedDiff(diff);
  const untracked = (
    await runGit(['ls-files', '--others', '--exclude-standard', '-z'], meta.path, readOpts)
  ).stdout
    .split('\0')
    .filter(Boolean);
  for (const rel of untracked) {
    try {
      const abs = path.join(meta.path, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue;
      const content = await fs.readFile(abs, 'utf8');
      if (content.includes('\0')) continue; // binary
      files.push({ path: rel, patch: untrackedFilePatch(rel, content) });
    } catch {
      // vanished between listing and reading: nothing to review
    }
  }
  return files;
}

export type WorktreeCouncilRunResult =
  { ok: true; verdict: CouncilVerdict } | { ok: false; errors: string[] };

export interface WorktreeCouncilHostDeps {
  getForSession: (sessionId: string) => WorktreeMeta | null | Promise<WorktreeMeta | null>;
  /** The owner's remembered Council selection (routing.yaml). Empty = feature not configured. */
  readSelection: () => Promise<CouncilReviewer[]>;
  /** Runs the 11.4 Council over these files with that selection. */
  runCouncil: (
    files: WorktreeCouncilFile[],
    reviewers: CouncilReviewer[],
  ) => Promise<WorktreeCouncilRunResult>;
  /** Removes the session's worktree through the guarded recycle path. */
  removeWorktree: (sessionId: string) => Promise<void>;
  gitExecFn?: typeof gitExec;
  merge?: (sessionId: string) => Promise<WorktreeMergeResponse>;
}

interface StoredReview {
  fingerprint: string;
  verdict: CouncilVerdict;
  reviewedAt: number;
}

interface Snapshot {
  meta: WorktreeMeta | null;
  files: WorktreeCouncilFile[];
  fingerprint: string | null;
  reviewers: CouncilReviewer[];
}

export interface WorktreeCouncilStatus {
  hasWorktree: boolean;
  configured: boolean;
  fileCount: number;
  gate: CouncilGateDecision;
  review?: {
    fingerprint: string;
    reviewedAt: number;
    usableReviewers: number;
    failedReviewers: number;
    findings: Array<{
      file: string;
      line: number;
      severity: string;
      title: string;
      agreement: number;
      of: number;
    }>;
  };
  error?: string;
}

export interface WorktreeMergeCleanupResult {
  ok: boolean;
  merged: boolean;
  cleaned: boolean;
  branchDeleted: boolean;
  message: string;
  /** The repository the worktree came from; the session moves back here once it is removed. */
  baseRepo?: string;
}

export class WorktreeCouncilHost {
  private readonly reviews = new Map<string, StoredReview>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastErrors = new Map<string, string>();

  constructor(private readonly deps: WorktreeCouncilHostDeps) {}

  private git(): typeof gitExec {
    return this.deps.gitExecFn ?? gitExec;
  }

  private async snapshot(sessionId: string): Promise<Snapshot> {
    const meta = await this.deps.getForSession(sessionId);
    const reviewers = await this.deps.readSelection().catch(() => [] as CouncilReviewer[]);
    if (!meta) return { meta: null, files: [], fingerprint: null, reviewers };
    const files = await readWorktreeCouncilFiles(meta, this.git());
    return {
      meta,
      files,
      fingerprint: files.length ? councilFilesFingerprint(files) : null,
      reviewers,
    };
  }

  private toStatus(sessionId: string, snap: Snapshot): WorktreeCouncilStatus {
    const stored = this.reviews.get(sessionId);
    const gate = assessCouncilGate({
      configured: snap.reviewers.length > 0,
      running: this.running.has(sessionId),
      currentFingerprint: snap.fingerprint,
      review: stored
        ? {
            fingerprint: stored.fingerprint,
            usableReviewers: stored.verdict.usableReviewers,
            failedReviewers: stored.verdict.failedReviewers,
            findings: stored.verdict.findings,
          }
        : null,
    });
    const error = this.lastErrors.get(sessionId);
    return {
      hasWorktree: Boolean(snap.meta),
      configured: snap.reviewers.length > 0,
      fileCount: snap.files.length,
      gate,
      ...(stored
        ? {
            review: {
              fingerprint: stored.fingerprint,
              reviewedAt: stored.reviewedAt,
              usableReviewers: stored.verdict.usableReviewers,
              failedReviewers: stored.verdict.failedReviewers,
              findings: stored.verdict.findings.map((f) => ({
                file: f.file,
                line: f.line,
                severity: f.severity,
                title: f.title,
                agreement: f.agreement,
                of: f.of,
              })),
            },
          }
        : {}),
      ...(error ? { error } : {}),
    };
  }

  async status(sessionId: string): Promise<WorktreeCouncilStatus> {
    return this.toStatus(sessionId, await this.snapshot(sessionId));
  }

  /** `auto`: called when a turn ends — skips a diff that already has a review. */
  async run(sessionId: string, options: { auto?: boolean } = {}): Promise<WorktreeCouncilStatus> {
    const inFlight = this.running.get(sessionId);
    if (inFlight) {
      await inFlight;
      return this.status(sessionId);
    }
    const snap = await this.snapshot(sessionId);
    if (!snap.meta || snap.reviewers.length === 0 || snap.fingerprint === null)
      return this.toStatus(sessionId, snap);
    if (options.auto && this.reviews.get(sessionId)?.fingerprint === snap.fingerprint) {
      return this.toStatus(sessionId, snap);
    }
    const fingerprint = snap.fingerprint;
    const work = (async () => {
      try {
        const result = await this.deps.runCouncil(snap.files, snap.reviewers);
        if (result.ok) {
          this.reviews.set(sessionId, {
            fingerprint,
            verdict: result.verdict,
            reviewedAt: Date.now(),
          });
          this.lastErrors.delete(sessionId);
        } else {
          this.lastErrors.set(sessionId, result.errors.join('; ').slice(0, 300));
        }
      } catch (error) {
        this.lastErrors.set(
          sessionId,
          error instanceof Error ? error.message.slice(0, 300) : 'council failed',
        );
      }
    })();
    this.running.set(sessionId, work);
    try {
      await work;
    } finally {
      this.running.delete(sessionId);
    }
    return this.status(sessionId);
  }

  async mergeAndCleanup(sessionId: string): Promise<WorktreeMergeCleanupResult> {
    const fail = (message: string): WorktreeMergeCleanupResult => ({
      ok: false,
      merged: false,
      cleaned: false,
      branchDeleted: false,
      message,
    });
    const status = await this.status(sessionId);
    if (!status.hasWorktree) return fail('No worktree bound to this session.');
    // Fail closed: this path always needs a passing review of the diff as it is right now.
    if (status.gate.state !== 'passed') return fail(status.gate.message);
    const meta = await this.deps.getForSession(sessionId);
    if (!meta) return fail('No worktree bound to this session.');

    const merge = this.deps.merge
      ? await this.deps.merge(sessionId)
      : await mergeWorktree(sessionId, {
          getForSession: this.deps.getForSession,
          gitExecFn: this.git(),
        });
    if (!merge.ok) return fail(merge.message);
    this.reviews.delete(sessionId);

    let cleaned = false;
    try {
      await this.deps.removeWorktree(sessionId);
      cleaned = !(await this.deps.getForSession(sessionId));
    } catch (error) {
      log.warn('worktree cleanup after merge failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let branchDeleted = false;
    if (cleaned) {
      try {
        // -d (not -D): git refuses unless the branch is fully merged.
        await this.git()(['branch', '-d', meta.branch], meta.baseRepo, writeOpts);
        branchDeleted = true;
      } catch (error) {
        log.warn('branch delete after merge failed', {
          branch: meta.branch,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const parts = [`Merged ${meta.branch}.`];
    parts.push(cleaned ? 'Worktree removed.' : 'Worktree kept (cleanup deferred).');
    if (cleaned) parts.push(branchDeleted ? 'Branch deleted.' : 'Branch kept.');
    return {
      ok: true,
      merged: true,
      cleaned,
      branchDeleted,
      message: parts.join(' '),
      baseRepo: meta.baseRepo,
    };
  }
}
