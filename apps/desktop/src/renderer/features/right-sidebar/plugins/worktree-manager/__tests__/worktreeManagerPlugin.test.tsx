// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { TabKindHostContext } from '../../../types';
import { getTabKind } from '../../../registry';
import '../index';
import { WorktreeManagerBody } from '../WorktreeManagerBody';
import { openWorktreeManagerTab } from '../../../lib/openWorktreeManagerTab';
import * as store from '../../../store';
import * as sidebarCommands from '../../../lib/sidebarCommands';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

function makeContext(overrides: Partial<TabKindHostContext> = {}): TabKindHostContext {
  return {
    tabId: 'wt-tab-1',
    sessionId: 'session-1',
    workdir: '/repo',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

describe('worktree-manager plugin', () => {
  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      worktreeListAll: vi.fn(async () => [
        { sessionId: 'session-1', path: '/repo/.cindy/worktrees/wt-1', branch: 'feat/test' },
        { sessionId: 'session-2', path: '/repo/.cindy/worktrees/wt-2', branch: 'fix/bug' },
      ]),
      worktreeReveal: vi.fn(async () => undefined),
      onWorktreeChanged: vi.fn(() => () => undefined),
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers in registry with expected metadata', () => {
    const plugin = getTabKind('worktree-manager');
    expect(plugin).not.toBeNull();
    expect(plugin?.kind).toBe('worktree-manager');
    expect(plugin?.menu.singleton).toBe(true);
    expect(plugin?.menu.enabled).toBe(true);
  });

  it('renders worktrees and identifies current session worktree', async () => {
    const ctx = makeContext({ sessionId: 'session-1' });
    render(
      <MemoryRouter>
        <WorktreeManagerBody ctx={ctx} state={{}} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Worktree Manager')).toBeDefined();
    });

    expect(screen.getByText('feat/test')).toBeDefined();
    expect(screen.getByText('fix/bug')).toBeDefined();
    expect(screen.getByText('CURRENT')).toBeDefined();
  });

  it('reveals worktree in finder on action click', async () => {
    const ctx = makeContext({ sessionId: 'session-1' });
    render(
      <MemoryRouter>
        <WorktreeManagerBody ctx={ctx} state={{}} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('feat/test')).toBeDefined();
    });

    const revealButtons = screen.getAllByLabelText('Reveal in Finder / Explorer');
    fireEvent.click(revealButtons[0]);

    expect(window.electronAPI.worktreeReveal).toHaveBeenCalledWith({ path: '/repo/.cindy/worktrees/wt-1' });
  });

  it('shows empty state when no worktrees exist', async () => {
    vi.stubGlobal('electronAPI', {
      worktreeListAll: vi.fn(async () => []),
      onWorktreeChanged: vi.fn(() => () => undefined),
    });

    const ctx = makeContext({ sessionId: 'session-1' });
    render(
      <MemoryRouter>
        <WorktreeManagerBody ctx={ctx} state={{}} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('No active Git worktrees')).toBeDefined();
    });
  });

  it('openWorktreeManagerTab opens tab and requests sidebar visibility', async () => {
    const ensureSpy = vi.spyOn(store, 'ensureHydrated').mockResolvedValue(undefined);
    const addSpy = vi.spyOn(store, 'addOrFocusSingletonTab').mockResolvedValue({ id: 't1', kind: 'worktree-manager', state: {} });
    const visSpy = vi.spyOn(sidebarCommands, 'requestRightSidebarVisibility').mockImplementation(() => undefined);

    await openWorktreeManagerTab('session-42');

    expect(ensureSpy).toHaveBeenCalledWith('session-42');
    expect(addSpy).toHaveBeenCalledWith('session-42', 'worktree-manager');
    expect(visSpy).toHaveBeenCalledWith('open', { sessionId: 'session-42' });
  });
});
