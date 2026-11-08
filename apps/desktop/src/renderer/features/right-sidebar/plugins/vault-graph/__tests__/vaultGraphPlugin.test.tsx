// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import { getTabKind } from '../../../registry';
import '../index';
import { VaultGraphTabBody } from '../VaultGraphTabBody';
import { openVaultGraphTab } from '../../../lib/openVaultGraphTab';
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
    tabId: 'graph-tab-1',
    sessionId: 'session-graph-1',
    workdir: '/repo',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

describe('vault-graph plugin', () => {
  const mockGraph = {
    totalNotes: 2,
    scannedAt: '2026-11-08T12:00:00Z',
    tags: {
      summary: ['Cindy/Memory/Synthesis.md', 'Cindy/Memory/session-1.md'],
      orca: ['Cindy/Memory/session-1.md'],
    },
    nodes: {
      'Cindy/Memory/Synthesis.md': {
        path: 'Cindy/Memory/Synthesis.md',
        title: 'Synthesis',
        tags: ['summary'],
        outgoingLinks: [],
        mtimeMs: 1000,
      },
      'Cindy/Memory/session-1.md': {
        path: 'Cindy/Memory/session-1.md',
        title: 'Session 1',
        tags: ['summary', 'orca'],
        outgoingLinks: ['Synthesis'],
        mtimeMs: 2000,
      },
    },
    backlinks: {
      'Cindy/Memory/Synthesis.md': ['Cindy/Memory/session-1.md'],
    },
  };

  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      maker: {
        vault: {
          getGraph: vi.fn(async () => ({ ok: true, graph: mockGraph })),
          onChanged: vi.fn(() => () => {}),
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
    const plugin = getTabKind('vault-graph');
    expect(plugin).not.toBeNull();
    expect(plugin?.kind).toBe('vault-graph');
    expect(plugin?.menu.singleton).toBe(true);
    expect(plugin?.menu.enabled).toBe(true);
  });

  it('renders graph nodes, tags cloud, and allows inspecting backlinks', async () => {
    const ctx = makeContext();
    render(<VaultGraphTabBody ctx={ctx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByText('Vault Graph & Tags')).toBeDefined();
      expect(screen.getByText('2 notes')).toBeDefined();
    });

    // Check tags cloud rendered
    expect(screen.getAllByText(/#summary/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/#orca/).length).toBeGreaterThan(0);

    // Check notes list rendered
    expect(screen.getByText('Synthesis')).toBeDefined();
    expect(screen.getByText('Session 1')).toBeDefined();

    // Click on Synthesis note to inspect connections
    fireEvent.click(screen.getByText('Synthesis'));

    await waitFor(() => {
      expect(screen.getByText(/Incoming Backlinks/)).toBeDefined();
      expect(screen.getAllByText(/Session 1/).length).toBeGreaterThanOrEqual(2);
    });

    // Filter by tag #orca
    fireEvent.click(screen.getAllByText(/#orca/)[0]);

    await waitFor(() => {
      expect(screen.getAllByText(/Session 1/).length).toBeGreaterThan(0);
      expect(screen.queryByText('Cindy/Memory/Synthesis.md')).toBeNull();
    });
  });

  it('renders helpful message when no vault is configured', async () => {
    vi.stubGlobal('electronAPI', {
      maker: {
        vault: {
          getGraph: vi.fn(async () => ({ ok: false, error: 'no-vault' })),
          onChanged: vi.fn(() => () => {}),
        },
      },
    });

    const ctx = makeContext();
    render(<VaultGraphTabBody ctx={ctx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByText(/No notes vault configured/)).toBeDefined();
    });
  });

  it('openVaultGraphTab ensures hydration, focuses singleton, and requests sidebar visibility', async () => {
    const hydSpy = vi.spyOn(store, 'ensureHydrated').mockResolvedValue(undefined);
    const addSpy = vi.spyOn(store, 'addOrFocusSingletonTab').mockResolvedValue({ id: 't-graph', kind: 'vault-graph', state: {} });
    const visSpy = vi.spyOn(sidebarCommands, 'requestRightSidebarVisibility').mockImplementation(() => {});

    await openVaultGraphTab('session-g-1');

    expect(hydSpy).toHaveBeenCalledWith('session-g-1');
    expect(addSpy).toHaveBeenCalledWith('session-g-1', 'vault-graph');
    expect(visSpy).toHaveBeenCalledWith('open', { sessionId: 'session-g-1' });
  });
});
