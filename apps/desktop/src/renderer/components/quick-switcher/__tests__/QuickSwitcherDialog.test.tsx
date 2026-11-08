/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuickSwitcherDialog } from '../QuickSwitcherDialog';

// Mock electronAPI
const mockElectronAPI = {
  localDb: {
    sessions: {
      list: vi.fn(),
    },
  },
  maker: {
    experts: {
      list: vi.fn(),
      setPending: vi.fn(),
    },
    vault: {
      getGraph: vi.fn(),
      getConfig: vi.fn(),
      synthesizeMemory: vi.fn(),
    },
  },
  openPath: vi.fn(),
};

beforeEach(() => {
  (window as any).electronAPI = mockElectronAPI;
  mockElectronAPI.localDb.sessions.list.mockResolvedValue([
    {
      id: 'session-123',
      title: 'Cindy Quick Switcher Discussion',
      model: 'deepseek-flash',
      agentKind: 'hermes',
      updatedAt: Date.now() - 60000,
    },
  ]);
  mockElectronAPI.maker.experts.list.mockResolvedValue([
    {
      slug: 'code-reviewer',
      name: 'Code Reviewer',
      description: 'Reviews code quality and commits',
      tags: ['code', 'review'],
    },
  ]);
  mockElectronAPI.maker.vault.getGraph.mockResolvedValue({
    ok: true,
    graph: {
      nodes: [
        {
          path: 'memory/Project — Cindy.md',
          title: 'Project — Cindy',
          tags: ['project', 'cindy'],
          backlinks: ['index.md'],
          outgoingLinks: [],
        },
      ],
    },
  });
  mockElectronAPI.maker.vault.getConfig.mockResolvedValue({
    vaultDir: '/Users/turko/Bishi-memory',
    allSessionsSearch: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QuickSwitcherDialog', () => {
  it('does not render anything when open is false', () => {
    const { container } = render(
      <QuickSwitcherDialog
        open={false}
        onOpenChange={vi.fn()}
        activeSessionId="current-session"
        navigate={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders search input, filter chips and items when open is true', async () => {
    await act(async () => {
      render(
        <QuickSwitcherDialog
          open={true}
          onOpenChange={vi.fn()}
          activeSessionId="current-session"
          navigate={vi.fn()}
        />,
      );
    });

    expect(screen.getByPlaceholderText(/Search sessions, experts, vault notes/i)).toBeDefined();
    expect(screen.getByText('> Actions')).toBeDefined();
    expect(screen.getByText('@ Experts')).toBeDefined();
    expect(screen.getByText('# Notes')).toBeDefined();
    expect(screen.getByText('/ Sessions')).toBeDefined();
    expect(screen.getByText('New Task')).toBeDefined();
  });

  it('filters to actions when > Actions filter pill is clicked', async () => {
    await act(async () => {
      render(
        <QuickSwitcherDialog
          open={true}
          onOpenChange={vi.fn()}
          activeSessionId="current-session"
          navigate={vi.fn()}
        />,
      );
    });

    const actionButton = screen.getByText('> Actions');
    act(() => {
      fireEvent.click(actionButton);
    });

    const input = screen.getByPlaceholderText(/Search sessions, experts, vault notes/i) as HTMLInputElement;
    expect(input.value.startsWith('>')).toBe(true);
  });

  it('handles Escape key to close the dialog', async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      render(
        <QuickSwitcherDialog
          open={true}
          onOpenChange={onOpenChange}
          activeSessionId="current-session"
          navigate={vi.fn()}
        />,
      );
    });

    const input = screen.getByPlaceholderText(/Search sessions, experts, vault notes/i);
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('executes the selected action when Enter is pressed', async () => {
    const navigate = vi.fn();
    const onOpenChange = vi.fn();

    await act(async () => {
      render(
        <QuickSwitcherDialog
          open={true}
          onOpenChange={onOpenChange}
          activeSessionId="current-session"
          navigate={navigate}
        />,
      );
    });

    const input = screen.getByPlaceholderText(/Search sessions, experts, vault notes/i);
    // 'New Task' is the first default item
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith('/cc-agent/new');
  });

  it('handles ArrowDown and ArrowUp navigation', async () => {
    await act(async () => {
      render(
        <QuickSwitcherDialog
          open={true}
          onOpenChange={vi.fn()}
          activeSessionId="current-session"
          navigate={vi.fn()}
        />,
      );
    });

    const input = screen.getByPlaceholderText(/Search sessions, experts, vault notes/i);
    act(() => {
      // Arrow down
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      // Arrow up
      fireEvent.keyDown(input, { key: 'ArrowUp' });
    });
  });
});
