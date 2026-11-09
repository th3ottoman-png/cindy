// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  WorktreeMergeStrip,
  WorktreeMergeStripView,
  type WorktreeMergeStripViewProps,
} from '../WorktreeMergeStrip';
import type { WorktreeDiffResponse } from '../../../../main/worktree';

afterEach(() => {
  cleanup();
});

const sampleDiff: WorktreeDiffResponse = {
  ok: true,
  hasWorktree: true,
  baseBranch: 'main',
  worktreeBranch: 'cindy/task-123',
  ahead: 2,
  behind: 0,
  baseIsAncestor: true,
  targetDirtyFiles: 0,
  worktreeDirtyFiles: 0,
  summary: {
    fileCount: 2,
    added: 15,
    removed: 3,
    binaryCount: 0,
    truncated: false,
    files: [
      { path: 'src/index.ts', added: 10, removed: 1, binary: false },
      { path: 'src/utils.ts', added: 5, removed: 2, binary: false },
    ],
  },
  decision: {
    allowed: true,
    method: 'fast-forward',
    reason: 'ok',
    message: 'Fast-forward main to cindy/task-123 (2 commit(s)).',
    args: ['merge', '--ff-only', '--no-edit', 'cindy/task-123'],
    abortOnFailure: false,
  },
};

describe('WorktreeMergeStripView', () => {
  it('renders nothing when diff is null or hasWorktree is false', () => {
    const { container, rerender } = render(
      <WorktreeMergeStripView
        diff={null}
        loading={false}
        merging={false}
        merged={false}
        errorMessage={null}
        detailsOpen={false}
        onToggleDetails={() => {}}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();

    rerender(
      <WorktreeMergeStripView
        diff={{ ok: true, hasWorktree: false }}
        loading={false}
        merging={false}
        merged={false}
        errorMessage={null}
        detailsOpen={false}
        onToggleDetails={() => {}}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders branches, diff summary counts, and ahead/behind information', () => {
    render(
      <WorktreeMergeStripView
        diff={sampleDiff}
        loading={false}
        merging={false}
        merged={false}
        errorMessage={null}
        detailsOpen={false}
        onToggleDetails={() => {}}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText('cindy/task-123')).toBeDefined();
    expect(screen.getByText('main')).toBeDefined();
    expect(screen.getByText('2 files')).toBeDefined();
    expect(screen.getByText('+15')).toBeDefined();
    expect(screen.getByText('-3')).toBeDefined();
    expect(screen.getByText('(2 ahead, 0 behind)')).toBeDefined();
  });

  it('renders Review diff button and toggles details drawer', () => {
    const onToggleDetails = vi.fn();
    const { rerender } = render(
      <WorktreeMergeStripView
        diff={sampleDiff}
        loading={false}
        merging={false}
        merged={false}
        errorMessage={null}
        detailsOpen={false}
        onToggleDetails={onToggleDetails}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );

    const reviewBtn = screen.getByTestId('worktree-review-diff-btn');
    expect(reviewBtn).toBeDefined();
    fireEvent.click(reviewBtn);
    expect(onToggleDetails).toHaveBeenCalledTimes(1);

    // When detailsOpen is true, diff drawer displays files
    rerender(
      <WorktreeMergeStripView
        diff={sampleDiff}
        loading={false}
        merging={false}
        merged={false}
        errorMessage={null}
        detailsOpen={true}
        onToggleDetails={onToggleDetails}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByTestId('worktree-diff-drawer')).toBeDefined();
    expect(screen.getByText('src/index.ts')).toBeDefined();
    expect(screen.getByText('src/utils.ts')).toBeDefined();
  });

  it('enables merge button and calls onMerge when merge is allowed', () => {
    const onMerge = vi.fn();
    render(
      <WorktreeMergeStripView
        diff={sampleDiff}
        loading={false}
        merging={false}
        merged={false}
        errorMessage={null}
        detailsOpen={false}
        onToggleDetails={() => {}}
        onMerge={onMerge}
        onRefresh={() => {}}
      />,
    );

    const mergeBtn = screen.getByTestId('worktree-merge-btn');
    expect(mergeBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(mergeBtn);
    expect(onMerge).toHaveBeenCalledTimes(1);
  });

  it('disables merge button when decision.allowed is false', () => {
    const disallowedDiff: WorktreeDiffResponse = {
      ...sampleDiff,
      decision: {
        allowed: false,
        method: 'none',
        reason: 'target-dirty',
        message: '1 uncommitted file in main. Commit or stash them first.',
        args: [],
        abortOnFailure: false,
      },
    };

    render(
      <WorktreeMergeStripView
        diff={disallowedDiff}
        loading={false}
        merging={false}
        merged={false}
        errorMessage={null}
        detailsOpen={false}
        onToggleDetails={() => {}}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );

    const mergeBtn = screen.getByTestId('worktree-merge-btn');
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
    expect(mergeBtn.getAttribute('title')).toContain('uncommitted file');
  });

  it('displays merged indicator when merged is true', () => {
    render(
      <WorktreeMergeStripView
        diff={sampleDiff}
        loading={false}
        merging={false}
        merged={true}
        errorMessage={null}
        detailsOpen={false}
        onToggleDetails={() => {}}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText('Merged into main')).toBeDefined();
  });

  it('displays error message when provided', () => {
    render(
      <WorktreeMergeStripView
        diff={sampleDiff}
        loading={false}
        merging={false}
        merged={false}
        errorMessage="Merge conflict detected"
        detailsOpen={false}
        onToggleDetails={() => {}}
        onMerge={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText('Merge conflict detected')).toBeDefined();
  });
});

describe('WorktreeMergeStrip container', () => {
  it('calls worktreeDiff on mount and loads data', async () => {
    const mockWorktreeDiff = vi.fn().mockResolvedValue(sampleDiff);
    (window as unknown as { electronAPI: { worktreeDiff: typeof mockWorktreeDiff } }).electronAPI = {
      worktreeDiff: mockWorktreeDiff,
    };

    render(<WorktreeMergeStrip sessionId="session-1" />);

    await waitFor(() => {
      expect(mockWorktreeDiff).toHaveBeenCalledWith('session-1');
      expect(screen.getByText('cindy/task-123')).toBeDefined();
    });
  });

  it('calls worktreeMerge when merge button is clicked', async () => {
    const mockWorktreeDiff = vi.fn().mockResolvedValue(sampleDiff);
    const mockWorktreeMerge = vi.fn().mockResolvedValue({
      ok: true,
      method: 'fast-forward',
      message: 'Fast-forward complete',
      decision: sampleDiff.decision,
    });
    (window as unknown as {
      electronAPI: {
        worktreeDiff: typeof mockWorktreeDiff;
        worktreeMerge: typeof mockWorktreeMerge;
      };
    }).electronAPI = {
      worktreeDiff: mockWorktreeDiff,
      worktreeMerge: mockWorktreeMerge,
    };

    render(<WorktreeMergeStrip sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('worktree-merge-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('worktree-merge-btn'));

    await waitFor(() => {
      expect(mockWorktreeMerge).toHaveBeenCalledWith('session-1');
      expect(screen.getByText('Merged into main')).toBeDefined();
    });
  });
});
