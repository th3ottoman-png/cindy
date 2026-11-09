import { describe, expect, it } from 'vitest';

import {
  assessWorktreeMerge,
  normaliseDiffPath,
  parseWorktreeNumstat,
  summariseWorktreeDiff,
  type WorktreeMergeInput,
} from '../worktree-merge';

const CLEAN: WorktreeMergeInput = {
  baseBranch: 'main',
  worktreeBranch: 'cindy/task-abc',
  targetDirtyFiles: 0,
  aheadCount: 3,
  behindCount: 0,
  baseIsAncestor: true,
};

describe('assessWorktreeMerge', () => {
  it('fast-forwards when base is an ancestor of the branch', () => {
    const decision = assessWorktreeMerge(CLEAN);
    expect(decision.allowed).toBe(true);
    expect(decision.method).toBe('fast-forward');
    expect(decision.args).toEqual(['merge', '--ff-only', '--no-edit', 'cindy/task-abc']);
    expect(decision.abortOnFailure).toBe(false);
  });

  it('uses a real merge when base has moved on', () => {
    const decision = assessWorktreeMerge({
      ...CLEAN,
      baseIsAncestor: false,
      behindCount: 4,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.method).toBe('merge');
    expect(decision.args).toEqual(['merge', '--no-edit', 'cindy/task-abc']);
    // A failed merge must be rolled back, so nothing is left half-applied.
    expect(decision.abortOnFailure).toBe(true);
  });

  it('refuses a dirty base working tree', () => {
    const decision = assessWorktreeMerge({ ...CLEAN, targetDirtyFiles: 2 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('target-dirty');
    expect(decision.args).toEqual([]);
    expect(decision.message).toContain('2 uncommitted file');
  });

  it('refuses when the branch has nothing new', () => {
    const decision = assessWorktreeMerge({ ...CLEAN, aheadCount: 0 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('nothing-to-merge');
  });

  it('refuses when the branch is the base branch', () => {
    expect(
      assessWorktreeMerge({ ...CLEAN, worktreeBranch: 'main' }).reason,
    ).toBe('same-branch');
    expect(
      assessWorktreeMerge({ ...CLEAN, worktreeBranch: '  ' }).reason,
    ).toBe('same-branch');
  });

  it('refuses a known conflict without touching git', () => {
    const decision = assessWorktreeMerge({ ...CLEAN, knownConflict: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('known-conflict');
    expect(decision.args).toEqual([]);
  });

  it('checks cleanliness before divergence', () => {
    const decision = assessWorktreeMerge({
      ...CLEAN,
      baseIsAncestor: false,
      behindCount: 2,
      targetDirtyFiles: 1,
    });
    expect(decision.reason).toBe('target-dirty');
  });

  it('treats a non-finite dirty count as dirty, never as clean', () => {
    const decision = assessWorktreeMerge({ ...CLEAN, targetDirtyFiles: Number.NaN });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('target-dirty');
  });

  it('never returns arguments for a refused merge', () => {
    const refusals: WorktreeMergeInput[] = [
      { ...CLEAN, targetDirtyFiles: 1 },
      { ...CLEAN, aheadCount: 0 },
      { ...CLEAN, knownConflict: true },
      { ...CLEAN, baseBranch: 'main', worktreeBranch: 'main' },
    ];
    for (const input of refusals) {
      expect(assessWorktreeMerge(input).args).toHaveLength(0);
    }
  });
});

describe('parseWorktreeNumstat', () => {
  it('parses counts and paths', () => {
    const files = parseWorktreeNumstat('12\t3\tsrc/a.ts\n0\t7\tdocs/b.md\n');
    expect(files).toEqual([
      { path: 'src/a.ts', added: 12, removed: 3, binary: false },
      { path: 'docs/b.md', added: 0, removed: 7, binary: false },
    ]);
  });

  it('marks binary files and zeroes their counts', () => {
    const files = parseWorktreeNumstat('-\t-\tassets/logo.png');
    expect(files[0]).toEqual({ path: 'assets/logo.png', added: 0, removed: 0, binary: true });
  });

  it('keeps the destination of a rename', () => {
    const files = parseWorktreeNumstat('4\t4\tsrc/{old => new}/file.ts');
    expect(files[0].path).toBe('src/new/file.ts');
  });

  it('keeps the destination of a top-level rename', () => {
    const files = parseWorktreeNumstat('1\t1\told-name.ts => new-name.ts');
    expect(files[0].path).toBe('new-name.ts');
  });

  it('ignores malformed lines and empty input', () => {
    expect(parseWorktreeNumstat('')).toEqual([]);
    expect(parseWorktreeNumstat('not a numstat line')).toEqual([]);
    expect(parseWorktreeNumstat('1\t2\t')).toEqual([]);
  });

  it('keeps a path that contains a tab in the name', () => {
    const files = parseWorktreeNumstat('1\t2\tdir/with\ttab.ts');
    expect(files[0].path).toBe('dir/with\ttab.ts');
  });
});

describe('normaliseDiffPath', () => {
  it('collapses double slashes left by a braced rename', () => {
    expect(normaliseDiffPath('{a => }/file.ts')).toBe('/file.ts');
    expect(normaliseDiffPath('src/{ => nested}/file.ts')).toBe('src/nested/file.ts');
  });
});

describe('summariseWorktreeDiff', () => {
  const files = parseWorktreeNumstat(
    ['10\t2\ta.ts', '5\t0\tb.ts', '-\t-\tc.png', '1\t9\td.ts'].join('\n'),
  );

  it('totals the diff', () => {
    const summary = summariseWorktreeDiff(files);
    expect(summary.fileCount).toBe(4);
    expect(summary.added).toBe(16);
    expect(summary.removed).toBe(11);
    expect(summary.binaryCount).toBe(1);
    expect(summary.truncated).toBe(false);
  });

  it('bounds the file list without losing the totals', () => {
    const summary = summariseWorktreeDiff(files, { maxFiles: 2 });
    expect(summary.files).toHaveLength(2);
    expect(summary.fileCount).toBe(4);
    expect(summary.truncated).toBe(true);
    expect(summary.added).toBe(16);
  });

  it('handles an empty diff', () => {
    const summary = summariseWorktreeDiff([]);
    expect(summary).toEqual({
      fileCount: 0,
      added: 0,
      removed: 0,
      binaryCount: 0,
      files: [],
      truncated: false,
    });
  });
});
