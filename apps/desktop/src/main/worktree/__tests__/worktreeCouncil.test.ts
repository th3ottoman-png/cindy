import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CouncilVerdict } from '@cindy/maker-core/council-review';

import {
  WorktreeCouncilHost,
  readWorktreeCouncilFiles,
  type WorktreeCouncilHostDeps,
} from '../worktreeCouncil';
import type { WorktreeMeta } from '../types';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  }).trim();
}

let root: string;
let base: string;
let wt: string;
let meta: WorktreeMeta | null;

function verdict(findings: Array<{ severity: string }> = [], usable = 1): CouncilVerdict {
  return {
    findings: findings.map((f, i) => ({
      id: `f${i}`,
      file: 'src/a.ts',
      line: 1,
      severity: f.severity,
      kind: 'logic',
      title: 't',
      detail: 'd',
      agreedBy: [],
      agreement: 1,
      of: usable,
    })),
    outcomes: [],
    usableReviewers: usable,
    failedReviewers: 0,
  } as unknown as CouncilVerdict;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-wt-council-'));
  base = path.join(root, 'base');
  // Where WorktreeManager really puts it: inside the base repo, under .cindy-worktrees/.
  wt = path.join(root, 'base', '.cindy-worktrees', 'task-1');
  fs.mkdirSync(path.join(base, 'src'), { recursive: true });
  git(base, 'init', '-b', 'main');
  git(base, 'config', 'user.name', 'Cindy Test');
  git(base, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(base, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(base, 'README.md'), 'base\n');
  git(base, 'add', '-A');
  git(base, 'commit', '-m', 'base');
  git(base, 'worktree', 'add', '-b', 'cindy/task-1', wt, 'main');
  meta = {
    sessionId: 's1',
    name: 'task-1',
    path: wt,
    baseRepo: base,
    branch: 'cindy/task-1',
    sourceBranch: 'main',
    createdAt: new Date().toISOString(),
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function host(over: Partial<WorktreeCouncilHostDeps> = {}) {
  const runCouncil = vi.fn<WorktreeCouncilHostDeps['runCouncil']>(async () => ({
    ok: true,
    verdict: verdict(),
  }));
  const removeWorktree = vi.fn(async () => {
    git(base, 'worktree', 'remove', '--force', wt);
    meta = null;
  });
  const h = new WorktreeCouncilHost({
    getForSession: () => meta,
    readSelection: async () => [{ providerId: 'local', model: 'qwen' }],
    runCouncil,
    removeWorktree,
    ...over,
  });
  return { h, runCouncil, removeWorktree };
}

describe('readWorktreeCouncilFiles (ROADMAP 11.11)', () => {
  it('reviews committed, uncommitted and untracked work against the merge-base, not base changes', async () => {
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    git(wt, 'commit', '-am', 'edit a');
    fs.writeFileSync(path.join(wt, 'README.md'), 'base\nmore\n');
    fs.writeFileSync(path.join(wt, 'src', 'new.ts'), 'export const n = 1;\n');
    // The base branch moves on after the worktree was cut: those edits are not the task's.
    fs.writeFileSync(path.join(base, 'BASE_ONLY.md'), 'x\n');
    git(base, 'add', '-A');
    git(base, 'commit', '-m', 'base moves');

    const files = await readWorktreeCouncilFiles(meta!);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'src/a.ts', 'src/new.ts']);
    expect(files.find((f) => f.path === 'src/new.ts')?.patch).toContain('+export const n = 1;');
  });
});

describe('WorktreeCouncilHost (ROADMAP 11.11)', () => {
  it('runs the council once per diff, and again when the diff changes', async () => {
    const { h, runCouncil } = host();
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    const first = await h.run('s1', { auto: true });
    expect(first.gate.state).toBe('passed');
    expect(runCouncil).toHaveBeenCalledTimes(1);
    expect(runCouncil.mock.calls[0][0].map((f) => f.path)).toEqual(['src/a.ts']);
    await h.run('s1', { auto: true });
    expect(runCouncil).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 3;\n');
    expect((await h.status('s1')).gate.state).toBe('stale');
    await h.run('s1', { auto: true });
    expect(runCouncil).toHaveBeenCalledTimes(2);
  });

  it('does not call the council when no reviewers are chosen or nothing changed', async () => {
    const { h, runCouncil } = host({ readSelection: async () => [] });
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    expect((await h.run('s1', { auto: true })).gate.state).toBe('not-configured');
    expect(runCouncil).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    const clean = host();
    expect((await clean.h.run('s1', { auto: true })).gate.state).toBe('empty');
    expect(clean.runCouncil).not.toHaveBeenCalled();
  });

  it('refuses merge-and-cleanup while the council has blocking findings; base stays untouched', async () => {
    const { h, removeWorktree } = host({
      runCouncil: async () => ({ ok: true, verdict: verdict([{ severity: 'blocker' }]) }),
    });
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    expect((await h.run('s1', { auto: true })).gate.state).toBe('failed');
    const res = await h.mergeAndCleanup('s1');
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(path.join(base, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('refuses when the diff changed after a passing review', async () => {
    const { h } = host();
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    await h.run('s1', { auto: true });
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 9;\n');
    const res = await h.mergeAndCleanup('s1');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/changed after/);
  });

  it('after a pass: merges into the base working tree, removes the worktree and deletes the merged branch', async () => {
    const { h, removeWorktree } = host();
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(wt, 'src', 'new.ts'), 'export const n = 1;\n');
    await h.run('s1', { auto: true });
    const res = await h.mergeAndCleanup('s1');
    expect(res).toMatchObject({
      ok: true,
      merged: true,
      cleaned: true,
      branchDeleted: true,
      baseRepo: base,
    });
    expect(fs.readFileSync(path.join(base, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(fs.existsSync(path.join(base, 'src', 'new.ts'))).toBe(true);
    expect(git(base, 'status', '--porcelain')).toBe('');
    expect(removeWorktree).toHaveBeenCalledWith('s1');
    expect(git(base, 'branch', '--list', 'cindy/task-1')).toBe('');
  });
});
