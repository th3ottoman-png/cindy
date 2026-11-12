// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => {
  let streaming = false;
  const listeners = new Set<() => void>();
  return {
    setStreaming(value: boolean) {
      streaming = value;
      for (const l of listeners) l();
    },
    api: {
      getSnapshot: () => ({ isStreaming: streaming }),
      subscribe: (_id: string, l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  };
});
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: store.api }));
const sessionUpdate = vi.hoisted(() => vi.fn(async () => undefined));
const patchLocal = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sessionService', () => ({ update: sessionUpdate }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { patchLocal } }));

import {
  WorktreeMergeStrip,
  WorktreeMergeStripView,
  type WorktreeMergeStripViewProps,
} from '../WorktreeMergeStrip';
import type { WorktreeDiffResponse } from '../../../../main/worktree';
import type { WorktreeCouncilStatus } from '../../../../main/worktree/worktreeCouncil';

const diff: WorktreeDiffResponse = {
  ok: true,
  hasWorktree: true,
  baseBranch: 'main',
  worktreeBranch: 'cindy/task-1',
  ahead: 1,
  behind: 0,
  baseIsAncestor: true,
  targetDirtyFiles: 0,
  worktreeDirtyFiles: 0,
  summary: {
    fileCount: 1,
    added: 1,
    removed: 1,
    binaryCount: 0,
    truncated: false,
    files: [{ path: 'src/a.ts', added: 1, removed: 1, binary: false }],
  },
  decision: {
    allowed: true,
    method: 'fast-forward',
    reason: 'ok',
    message: 'Fast-forward',
    args: [],
    abortOnFailure: false,
  },
} as unknown as WorktreeDiffResponse;

const council = (
  state: WorktreeCouncilStatus['gate']['state'],
  mergeAllowed: boolean,
  blocking = 0,
): WorktreeCouncilStatus => ({
  hasWorktree: true,
  configured: true,
  fileCount: 1,
  gate: { state, mergeAllowed, blocking, message: `gate ${state}` },
});

function view(over: Partial<WorktreeMergeStripViewProps> = {}) {
  const props: WorktreeMergeStripViewProps = {
    diff,
    loading: false,
    merging: false,
    merged: false,
    errorMessage: null,
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    onMerge: vi.fn(),
    onRefresh: vi.fn(),
    onRunCouncil: vi.fn(),
    onMergeCleanup: vi.fn(),
    ...over,
  };
  render(<WorktreeMergeStripView {...props} />);
  return props;
}

afterEach(() => cleanup());

describe('WorktreeMergeStrip council gate (ROADMAP 11.11)', () => {
  it('blocks "Merge to Main Worktree" while the council has blocking findings', () => {
    view({ council: council('failed', false, 2) });
    const btn = screen.getByTestId('worktree-merge-btn') as HTMLButtonElement;
    expect(btn.textContent).toContain('Merge to Main Worktree');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('gate failed');
    expect(screen.getByTestId('worktree-council-pill').textContent).toContain('2 blocking');
  });

  it('after a pass, the button runs merge + cleanup, not the 9.2 merge', () => {
    const props = view({ council: council('passed', true) });
    const btn = screen.getByTestId('worktree-merge-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(props.onMergeCleanup).toHaveBeenCalledTimes(1);
    expect(props.onMerge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('worktree-council-run-btn'));
    expect(props.onRunCouncil).toHaveBeenCalledTimes(1);
  });

  it('keeps the plain 9.2 merge when no council is configured', () => {
    const props = view({ council: { ...council('not-configured', true), configured: false } });
    expect(screen.queryByTestId('worktree-council-pill')).toBeNull();
    const btn = screen.getByTestId('worktree-merge-btn');
    expect(btn.textContent).toContain('Merge into working tree');
    fireEvent.click(btn);
    expect(props.onMerge).toHaveBeenCalledTimes(1);
  });

  it('shows the cleanup result after the merge', () => {
    view({ cleanupMessage: 'Merged cindy/task-1. Worktree removed. Branch deleted.' });
    expect(screen.getByTestId('worktree-cleanup-message').textContent).toContain(
      'Worktree removed',
    );
  });
});

describe('WorktreeMergeStrip auto review when a turn ends (ROADMAP 11.11)', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      worktreeDiff: vi.fn(async () => diff),
      worktreeCouncilStatus: vi.fn(async () => council('pending', false)),
      worktreeCouncilRun: vi.fn(async () => council('passed', true)),
      worktreeMergeCleanup: vi.fn(),
      onWorktreeChanged: () => () => undefined,
    };
  });

  it('runs an auto council review on the streaming → idle transition only', async () => {
    render(<WorktreeMergeStrip sessionId="s1" />);
    const api = window.electronAPI as unknown as { worktreeCouncilRun: ReturnType<typeof vi.fn> };
    await screen.findByTestId('worktree-council-pill');
    expect(api.worktreeCouncilRun).not.toHaveBeenCalled();
    act(() => store.setStreaming(true));
    expect(api.worktreeCouncilRun).not.toHaveBeenCalled();
    act(() => store.setStreaming(false));
    await waitFor(() => expect(api.worktreeCouncilRun).toHaveBeenCalledWith('s1', true));
    await waitFor(() =>
      expect(screen.getByTestId('worktree-council-pill').getAttribute('data-state')).toBe('passed'),
    );
  });

  it('after merge + cleanup, moves the chat back to the base repo', async () => {
    const api = window.electronAPI as unknown as {
      worktreeCouncilStatus: ReturnType<typeof vi.fn>;
      worktreeMergeCleanup: ReturnType<typeof vi.fn>;
    };
    api.worktreeCouncilStatus.mockResolvedValue(council('passed', true));
    api.worktreeMergeCleanup.mockResolvedValue({
      ok: true,
      merged: true,
      cleaned: true,
      branchDeleted: true,
      message: 'Merged.',
      baseRepo: '/repo',
    });
    render(<WorktreeMergeStrip sessionId="s1" />);
    await waitFor(() =>
      expect((screen.getByTestId('worktree-merge-btn') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('worktree-merge-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('worktree-cleanup-message').textContent).toContain(
        'Chat now works in /repo',
      ),
    );
    expect(sessionUpdate).toHaveBeenCalledWith('s1', { workingDir: '/repo' });
    expect(patchLocal).toHaveBeenCalledWith('s1', { workingDir: '/repo' });
  });
});
