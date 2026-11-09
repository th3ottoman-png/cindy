import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readWorktreeDiff, mergeWorktree } from '../worktreeMerge';
import type { WorktreeMeta } from '../types';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let rootDir: string;
let baseRepoDir: string;
let worktreeDir: string;
let meta: WorktreeMeta;

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Cindy Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim();
}

function commitFile(cwd: string, filename: string, content: string) {
  fs.writeFileSync(path.join(cwd, filename), content);
  git(cwd, 'add', '--', filename);
  git(cwd, 'commit', '-m', `add ${filename}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-merge-test-'));
  baseRepoDir = path.join(rootDir, 'base-repo');
  worktreeDir = path.join(rootDir, 'worktrees', 'task-merge');

  fs.mkdirSync(baseRepoDir, { recursive: true });
  git(baseRepoDir, 'init', '-b', 'main');
  commitFile(baseRepoDir, 'base.txt', 'base content line 1\n');

  // Create real worktree
  git(baseRepoDir, 'worktree', 'add', '-b', 'cindy/task-merge', worktreeDir, 'main');

  meta = {
    sessionId: 'session-merge-1',
    name: 'task-merge',
    path: worktreeDir,
    baseRepo: baseRepoDir,
    branch: 'cindy/task-merge',
    sourceBranch: 'main',
    createdAt: new Date().toISOString(),
  };
});

afterAll(() => {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('worktreeMerge host implementation', () => {
  it('returns hasWorktree: false when session is not bound to a worktree', async () => {
    const deps = { getForSession: () => null };
    const diff = await readWorktreeDiff('non-existent', deps);
    expect(diff.ok).toBe(true);
    expect(diff.hasWorktree).toBe(false);

    const merge = await mergeWorktree('non-existent', deps);
    expect(merge.ok).toBe(false);
    expect(merge.decision.allowed).toBe(false);
    expect(merge.decision.reason).toBe('nothing-to-merge');
  });

  it('detects uncommitted changes in worktree and reports clean base repo', async () => {
    const deps = { getForSession: (id: string) => (id === meta.sessionId ? meta : null) };

    // Write a new file in the worktree
    fs.writeFileSync(path.join(worktreeDir, 'new-feature.txt'), 'hello from worktree\nline 2\n');

    const diff = await readWorktreeDiff(meta.sessionId, deps);
    expect(diff.ok).toBe(true);
    expect(diff.hasWorktree).toBe(true);
    expect(diff.baseBranch).toBe('main');
    expect(diff.worktreeBranch).toBe('cindy/task-merge');
    expect(diff.targetDirtyFiles).toBe(0);
    expect(diff.worktreeDirtyFiles).toBeGreaterThan(0);
    expect(diff.summary?.fileCount).toBeGreaterThanOrEqual(1);
    expect(diff.decision?.allowed).toBe(true);
    expect(diff.decision?.method).toBe('fast-forward');
  });

  it('merges worktree changes into base repo cleanly with fast-forward', async () => {
    const deps = { getForSession: (id: string) => (id === meta.sessionId ? meta : null) };

    const mergeResult = await mergeWorktree(meta.sessionId, deps);
    expect(mergeResult.ok).toBe(true);
    expect(mergeResult.method).toBe('fast-forward');

    // Base repo should now contain new-feature.txt
    const mergedContent = fs.readFileSync(path.join(baseRepoDir, 'new-feature.txt'), 'utf8');
    expect(mergedContent).toBe('hello from worktree\nline 2\n');

    // Base repo status must be completely clean
    const status = git(baseRepoDir, 'status', '--porcelain');
    expect(status).toBe('');
  });

  it('refuses merge when base repo has uncommitted changes (target-dirty)', async () => {
    const deps = { getForSession: (id: string) => (id === meta.sessionId ? meta : null) };

    // Add another commit in worktree
    commitFile(worktreeDir, 'feature-2.txt', 'second feature\n');

    // Dirty the base repo
    fs.writeFileSync(path.join(baseRepoDir, 'uncommitted-base.txt'), 'dirty base\n');

    const diff = await readWorktreeDiff(meta.sessionId, deps);
    expect(diff.targetDirtyFiles).toBe(1);
    expect(diff.decision?.allowed).toBe(false);
    expect(diff.decision?.reason).toBe('target-dirty');

    const mergeResult = await mergeWorktree(meta.sessionId, deps);
    expect(mergeResult.ok).toBe(false);
    expect(mergeResult.decision.allowed).toBe(false);
    expect(mergeResult.decision.reason).toBe('target-dirty');
    expect(mergeResult.message).toContain('uncommitted file');

    // Clean up base repo
    fs.unlinkSync(path.join(baseRepoDir, 'uncommitted-base.txt'));
  });

  it('refuses merge when there are no new changes (nothing-to-merge)', async () => {
    const deps = { getForSession: (id: string) => (id === meta.sessionId ? meta : null) };

    // Merge feature-2 first so both branches are in sync
    await mergeWorktree(meta.sessionId, deps);

    // Now both branches have identical commits and worktree is clean
    const diff = await readWorktreeDiff(meta.sessionId, deps);
    expect(diff.ahead).toBe(0);
    expect(diff.worktreeDirtyFiles).toBe(0);
    expect(diff.decision?.allowed).toBe(false);
    expect(diff.decision?.reason).toBe('nothing-to-merge');

    const mergeResult = await mergeWorktree(meta.sessionId, deps);
    expect(mergeResult.ok).toBe(false);
    expect(mergeResult.decision.allowed).toBe(false);
    expect(mergeResult.decision.reason).toBe('nothing-to-merge');
  });

  it('aborts cleanly and rolls back when there is a merge conflict', async () => {
    const deps = { getForSession: (id: string) => (id === meta.sessionId ? meta : null) };

    // Commit conflicting change in worktree
    commitFile(worktreeDir, 'conflict.txt', 'worktree version\n');

    // Commit conflicting change on base repo
    commitFile(baseRepoDir, 'conflict.txt', 'base repo conflicting version\n');

    const mergeResult = await mergeWorktree(meta.sessionId, deps);
    expect(mergeResult.ok).toBe(false);

    // Base repo should NOT be left in MERGING state
    const gitDir = git(baseRepoDir, 'rev-parse', '--git-dir');
    const mergeHead = path.join(baseRepoDir, gitDir, 'MERGE_HEAD');
    expect(fs.existsSync(mergeHead)).toBe(false);
  });
});
