// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTabKind } from '../../../registry';
import '../index';
import { VaultGitSyncTabBody } from '../VaultGitSyncTabBody';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

describe('vault-git-sync plugin (ROADMAP 7.4)', () => {
  const mockInspection = {
    projectName: 'Cindy',
    workspaceDir: '/Users/turko/projects/Cindy',
    branch: 'main',
    recentCommits: [
      { hash: 'e1078cd', message: 'feat: quick switcher palette' },
      { hash: '379b4e1', message: 'feat: local semantic search' },
    ],
    staged: [],
    modified: [{ path: 'src/app.ts', status: 'modified' as const }],
    untracked: [{ path: 'temp.txt', status: 'untracked' as const }],
    totalDirty: 2,
  };

  let inspectMock: ReturnType<typeof vi.fn>;
  let applyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    inspectMock = vi.fn(async () => ({
      ok: true,
      inspection: mockInspection,
      targetNotePath: 'memory/Project — Cindy.md',
      matchType: 'exact' as const,
    }));

    applyMock = vi.fn(async () => ({
      ok: true,
      path: 'memory/Project — Cindy.md',
      created: false,
      block: '### Progress\n\n- Commits: e1078cd',
    }));

    vi.stubGlobal('electronAPI', {
      maker: {
        vault: {
          gitSyncInspect: inspectMock,
          gitSyncApply: applyMock,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers in registry with expected metadata', () => {
    const plugin = getTabKind('vault-git-sync');
    expect(plugin).not.toBeNull();
    expect(plugin?.kind).toBe('vault-git-sync');
    expect(plugin?.menu.singleton).toBe(true);
    expect(plugin?.menu.enabled).toBe(true);
  });

  it('renders workspace git inspection, branch, target note, and commits', async () => {
    render(<VaultGitSyncTabBody />);

    await waitFor(() => {
      expect(screen.getByText('Git Workspace ↔ Vault Sync')).toBeDefined();
      expect(screen.getByText('memory/Project — Cindy.md')).toBeDefined();
    });

    expect(screen.getByText('Cindy')).toBeDefined();
    expect(screen.getByText('main')).toBeDefined();
    expect(screen.getByText('1 modified, 1 untracked')).toBeDefined();
    expect(screen.getByText('e1078cd')).toBeDefined();
    expect(screen.getByText('feat: quick switcher palette')).toBeDefined();
    expect(screen.getByText('exact match')).toBeDefined();
  });

  it('applies 1-click sync and displays success confirmation', async () => {
    render(<VaultGitSyncTabBody />);

    await waitFor(() => {
      expect(screen.getByText('memory/Project — Cindy.md')).toBeDefined();
    });

    // Fill in summary
    const textarea = screen.getByPlaceholderText(/What did you achieve/);
    fireEvent.change(textarea, { target: { value: 'Finished Phase 7.4 implementation' } });

    // Click 1-click sync button
    const syncButton = screen.getByText('Append Progress & Commit Log');
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith({
        targetNotePath: 'memory/Project — Cindy.md',
        summaryNote: 'Finished Phase 7.4 implementation',
      });
      expect(screen.getByText('Appended Progress Log!')).toBeDefined();
    });
  });

  it('renders error notice when inspection fails', async () => {
    inspectMock.mockResolvedValueOnce({
      ok: false,
      error: 'Not a git repository',
    });

    render(<VaultGitSyncTabBody />);

    await waitFor(() => {
      expect(screen.getByText('Inspection Notice')).toBeDefined();
      expect(screen.getByText('Not a git repository')).toBeDefined();
    });
  });
});
