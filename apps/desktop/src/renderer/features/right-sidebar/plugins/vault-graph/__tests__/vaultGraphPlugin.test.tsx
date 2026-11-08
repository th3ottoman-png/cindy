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

  let pinNoteMock: ReturnType<typeof vi.fn>;
  let unpinNoteMock: ReturnType<typeof vi.fn>;
  let quickCaptureMock: ReturnType<typeof vi.fn>;
  let getPinnedNotesMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pinNoteMock = vi.fn(async () => ({ ok: true, pinnedNotes: ['Cindy/Memory/Synthesis.md'] }));
    unpinNoteMock = vi.fn(async () => ({ ok: true, pinnedNotes: [] }));
    quickCaptureMock = vi.fn(async () => ({ ok: true, relPath: 'Inbox.md' }));
    getPinnedNotesMock = vi.fn(async () => []);

    vi.stubGlobal('electronAPI', {
      maker: {
        vault: {
          getGraph: vi.fn(async () => ({ ok: true, graph: mockGraph })),
          onChanged: vi.fn(() => () => {}),
          getPinnedNotes: getPinnedNotesMock,
          onPinnedChanged: vi.fn(() => () => {}),
          pinNote: pinNoteMock,
          unpinNote: unpinNoteMock,
          quickCapture: quickCaptureMock,
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

  it('allows quick capture to vault inbox', async () => {
    const ctx = makeContext();
    render(<VaultGraphTabBody ctx={ctx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByText('Vault Graph & Tags')).toBeDefined();
    });

    // Click Capture button in header
    fireEvent.click(screen.getByLabelText('Quick Capture'));

    await waitFor(() => {
      expect(screen.getByText(/Quick Capture \(Inbox\.md\)/)).toBeDefined();
    });

    // Fill in textarea, title, and tags
    const textarea = screen.getByPlaceholderText(/Type your thought/);
    fireEvent.change(textarea, { target: { value: 'Test captured thought' } });

    const titleInput = screen.getByPlaceholderText(/Title \(optional\)/);
    fireEvent.change(titleInput, { target: { value: 'Test Title' } });

    const tagsInput = screen.getByPlaceholderText(/Tags: idea, ref/);
    fireEvent.change(tagsInput, { target: { value: 'tag1, #tag2' } });

    // Submit
    fireEvent.click(screen.getByText('Save to Vault'));

    await waitFor(() => {
      expect(quickCaptureMock).toHaveBeenCalledWith({
        content: 'Test captured thought',
        title: 'Test Title',
        tags: ['tag1', 'tag2'],
        sourceSessionId: 'session-graph-1',
      });
    });
  });

  it('allows pinning and unpinning notes to current session context', async () => {
    const ctx = makeContext();
    render(<VaultGraphTabBody ctx={ctx} state={{}} />);

    await waitFor(() => {
      expect(getPinnedNotesMock).toHaveBeenCalledWith('session-graph-1');
      expect(screen.getByText('Synthesis')).toBeDefined();
    });

    // Select note Synthesis
    fireEvent.click(screen.getByText('Synthesis'));

    await waitFor(() => {
      expect(screen.getByText('Pin to Session')).toBeDefined();
    });

    // Click Pin to Session
    fireEvent.click(screen.getByText('Pin to Session'));

    await waitFor(() => {
      expect(pinNoteMock).toHaveBeenCalledWith('session-graph-1', 'Cindy/Memory/Synthesis.md');
      expect(screen.getByText('Unpin')).toBeDefined();
    });

    // Click Unpin
    fireEvent.click(screen.getByText('Unpin'));

    await waitFor(() => {
      expect(unpinNoteMock).toHaveBeenCalledWith('session-graph-1', 'Cindy/Memory/Synthesis.md');
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
