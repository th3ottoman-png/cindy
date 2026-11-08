/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { CapabilitiesDialog } from '../CapabilitiesDialog';
import {
  closeCapabilitiesHub,
  openCapabilitiesHub,
  useCapabilitiesHubOpen,
} from '../capabilitiesHubStore';

const mockApi = {
  maker: {
    extPlugins: { list: vi.fn() },
    experts: { list: vi.fn() },
    skills: { list: vi.fn() },
    mcpCatalog: { list: vi.fn() },
    vault: { getConfig: vi.fn(), getGraph: vi.fn() },
    providers: { list: vi.fn(), getRouting: vi.fn() },
  },
};

function defaultData() {
  mockApi.maker.extPlugins.list.mockResolvedValue({
    plugins: [
      { name: 'hello', enabled: true, status: 'active', registered: 1, version: '1.0.0' },
      { name: 'ghost', enabled: false, status: 'disabled', registered: 0 },
    ],
  });
  mockApi.maker.experts.list.mockResolvedValue([
    {
      slug: 'vault-researcher',
      dir: '/experts/vault-researcher',
      expert: {
        name: 'Vault Researcher',
        description: 'Searches the local notes vault',
        tags: ['vault', 'research'],
        tools: ['search_notes'],
        skills: [],
      },
    },
    {
      slug: 'code-reviewer',
      dir: '/experts/code-reviewer',
      expert: {
        name: 'Code Reviewer',
        description: 'Reviews git diffs',
        tags: ['code'],
        tools: [],
        skills: [],
      },
    },
  ]);
  mockApi.maker.skills.list.mockResolvedValue({
    skills: [
      { id: 'research/vault-notes', category: 'research', name: 'Vault Notes', enabled: true, builtin: false },
    ],
    skillsRoot: '/skills',
    disabledRoot: '/skills-disabled',
  });
  mockApi.maker.mcpCatalog.list.mockResolvedValue({
    entries: [
      {
        id: 'hermes/cindy_vault_notes',
        source: 'hermes',
        name: 'cindy_vault_notes',
        transport: 'stdio',
        enabled: true,
        target: 'node shim --server cindy_vault_notes',
        envKeys: [],
        headerKeys: [],
        hasAuth: false,
      },
    ],
  });
  mockApi.maker.vault.getConfig.mockResolvedValue({ vaultDir: '/vault', noteCount: 1 });
  mockApi.maker.vault.getGraph.mockResolvedValue({
    ok: true,
    graph: {
      nodes: {
        'memory/Project - Cindy.md': {
          path: 'memory/Project - Cindy.md',
          title: 'Project - Cindy',
          tags: ['cindy'],
          outgoingLinks: [],
          mtimeMs: 0,
        },
      },
      tags: {},
      backlinks: {},
      totalNotes: 1,
      scannedAt: '2026-11-08T00:00:00Z',
    },
  });
  mockApi.maker.providers.list.mockResolvedValue({
    providers: [
      { id: 'lmstudio-local', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', local: true },
    ],
    issues: [],
  });
  mockApi.maker.providers.getRouting.mockResolvedValue({
    routes: { 'local-small': { provider: 'lmstudio-local', model: 'qwen3-8b' } },
    rules: { title: 'local-small' },
    issues: [],
  });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function Harness({ open = true }: { open?: boolean }) {
  const [isOpen, setIsOpen] = React.useState(open);
  return (
    <MemoryRouter initialEntries={['/cc-agent/session-1']}>
      <LocationProbe />
      <Routes>
        <Route
          path="*"
          element={<CapabilitiesDialog open={isOpen} onOpenChange={setIsOpen} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

function rows(): HTMLElement[] {
  return Array.from(screen.queryAllByTestId('capability-row'));
}

function kinds(): string[] {
  return [...new Set(rows().map((row) => row.getAttribute('data-kind') ?? ''))];
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = mockApi;
  vi.clearAllMocks();
  defaultData();
  closeCapabilitiesHub();
});

afterEach(() => {
  cleanup();
  closeCapabilitiesHub();
});

describe('CapabilitiesDialog', () => {
  it('renders nothing while closed', async () => {
    render(<Harness open={false} />);
    expect(screen.queryByTestId('capabilities-dialog')).toBeNull();
    expect(mockApi.maker.experts.list).not.toHaveBeenCalled();
  });

  it('lists every installed capability kind with provenance', async () => {
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(screen.getByTestId('capabilities-count').textContent).toContain('kinds');
    expect(kinds()).toEqual(
      expect.arrayContaining([
        'plugin',
        'expert',
        'skill',
        'mcp-server',
        'vault-source',
        'vault-note',
        'connector',
        'model-route',
      ]),
    );
    const researcher = rows().find((row) => row.getAttribute('data-id') === 'expert:vault-researcher');
    expect(researcher?.getAttribute('data-source')).toBe('/experts/vault-researcher/expert.md');
    expect(researcher?.textContent).toContain('expert.md frontmatter');
    expect(researcher?.textContent).toContain('local-file');
  });

  it('searching vault returns the researcher, the MCP tool and vault notes together', async () => {
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    fireEvent.change(screen.getByTestId('capabilities-query'), { target: { value: 'vault' } });
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    expect(kinds()).toEqual(expect.arrayContaining(['expert', 'mcp-server', 'vault-note']));
    expect(rows().some((row) => row.getAttribute('data-id') === 'expert:vault-researcher')).toBe(true);
    expect(
      rows().some((row) => row.getAttribute('data-id') === 'mcp-server:hermes/cindy_vault_notes'),
    ).toBe(true);
  });

  it('hides a disabled plugin without breaking the other rows', async () => {
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(rows().some((row) => row.getAttribute('data-id') === 'plugin:hello')).toBe(true);
    expect(rows().some((row) => row.getAttribute('data-id') === 'plugin:ghost')).toBe(false);
    expect(screen.getByTestId('capabilities-dialog')).toBeTruthy();
  });

  it('a missing optional source hides its rows and the app still renders', async () => {
    mockApi.maker.extPlugins.list.mockRejectedValue(new Error('plugin subsystem missing'));
    mockApi.maker.mcpCatalog.list.mockRejectedValue(new Error('catalog unavailable'));
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(kinds()).not.toContain('plugin');
    expect(kinds()).not.toContain('mcp-server');
    expect(kinds()).toContain('expert');
    expect(kinds()).toContain('vault-note');
  });

  it('kind chips are derived from data and filter without a central kind list', async () => {
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const chips = screen.getAllByTestId('capabilities-kind-chip');
    expect(chips.map((chip) => chip.getAttribute('data-kind'))).toContain('vault-note');
    fireEvent.click(chips.find((chip) => chip.getAttribute('data-kind') === 'vault-note')!);
    await waitFor(() => expect(kinds()).toEqual(['vault-note']));
  });

  it('Escape closes the dialog and Enter opens the row deep link', async () => {
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    fireEvent.keyDown(screen.getByTestId('capabilities-query'), { key: 'Escape' });
    expect(screen.queryByTestId('capabilities-dialog')).toBeNull();
  });

  it('selecting a row closes the hub and navigates to its source settings', async () => {
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const researcher = rows().find((row) => row.getAttribute('data-id') === 'expert:vault-researcher');
    expect(researcher).toBeTruthy();
    fireEvent.click(researcher!);
    await waitFor(() => expect(screen.queryByTestId('capabilities-dialog')).toBeNull());
    expect(screen.getByTestId('location').textContent).toBe(
      '/settings?tab=general&section=settings-experts',
    );
  });
});

describe('capabilities hub store', () => {
  function Probe() {
    return <output data-testid="hub-state">{useCapabilitiesHubOpen() ? 'open' : 'closed'}</output>;
  }

  it('opens and closes from anywhere in the shell', () => {
    render(<Probe />);
    expect(screen.getByTestId('hub-state').textContent).toBe('closed');
    act(() => openCapabilitiesHub());
    expect(screen.getByTestId('hub-state').textContent).toBe('open');
    act(() => closeCapabilitiesHub());
    expect(screen.getByTestId('hub-state').textContent).toBe('closed');
  });
});
