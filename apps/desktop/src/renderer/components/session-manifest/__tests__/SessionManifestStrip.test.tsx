/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { SessionManifestStrip } from '../SessionManifestStrip';
import { clearPendingManifestPins, peekPendingManifestPins } from '../sessionManifestPins';

const EXPERT_MD = `---
name: Vault Researcher
agent: hermes
model: local-small
tools:
  - search_notes
skills:
  - vault-notes
---
You search the vault.
`;

const mockApi = {
  maker: {
    experts: {
      getSessionBinding: vi.fn(),
      list: vi.fn(),
      read: vi.fn(),
      setPending: vi.fn(),
      onSessionEvent: vi.fn(),
    },
    skills: { list: vi.fn() },
    mcpCatalog: { list: vi.fn() },
    providers: { list: vi.fn(), getRouting: vi.fn() },
    vault: {
      getPinnedNotes: vi.fn(),
      getConfig: vi.fn(),
      pinNote: vi.fn(),
      onPinnedChanged: vi.fn(),
      getSessionAdrs: vi.fn(),
      onSessionAdrsChanged: vi.fn(),
    },
  },
};

function defaultData() {
  mockApi.maker.experts.getSessionBinding.mockResolvedValue({
    sessionId: 'session-1',
    slug: 'vault-researcher',
    dir: '/experts/vault-researcher',
    name: 'Vault Researcher',
    model: 'local-small',
    toolsets: [],
  });
  mockApi.maker.experts.list.mockResolvedValue([
    {
      slug: 'vault-researcher',
      dir: '/experts/vault-researcher',
      expert: {
        name: 'Vault Researcher',
        tools: ['search_notes'],
        skills: ['vault-notes'],
        skillFiles: ['/experts/vault-researcher/skills/vault-notes/SKILL.md'],
        model: 'local-small',
      },
    },
  ]);
  mockApi.maker.experts.read.mockResolvedValue({
    ok: true,
    markdown: EXPERT_MD,
    file: '/experts/vault-researcher/expert.md',
  });
  mockApi.maker.experts.setPending.mockResolvedValue('vault-researcher');
  mockApi.maker.experts.onSessionEvent.mockReturnValue(() => undefined);
  mockApi.maker.skills.list.mockResolvedValue({
    skills: [{ id: 'research/vault-notes', name: 'Vault Notes', enabled: true, builtin: false }],
    skillsRoot: '/skills',
    disabledRoot: '/skills-disabled',
  });
  mockApi.maker.mcpCatalog.list.mockResolvedValue({
    entries: [
      {
        id: 'hermes/cindy_vault_notes',
        name: 'cindy_vault_notes',
        source: 'hermes',
        transport: 'stdio',
        enabled: true,
        target: 'node shim',
        envKeys: [],
        headerKeys: [],
        hasAuth: false,
      },
    ],
  });
  mockApi.maker.providers.list.mockResolvedValue({
    providers: [{ id: 'lmstudio-local', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', local: true }],
    issues: [],
  });
  mockApi.maker.providers.getRouting.mockResolvedValue({
    routes: { 'local-small': { provider: 'lmstudio-local', model: 'qwen3-8b' } },
    rules: { 'chat.default': 'local-small' },
    issues: [],
  });
  mockApi.maker.vault.getPinnedNotes.mockResolvedValue(['memory/Project - Cindy.md']);
  mockApi.maker.vault.getConfig.mockResolvedValue({ vaultDir: '/vault', noteCount: 1 });
  mockApi.maker.vault.pinNote.mockResolvedValue({ ok: true, pinnedNotes: [] });
  mockApi.maker.vault.onPinnedChanged.mockReturnValue(() => undefined);
  mockApi.maker.vault.getSessionAdrs.mockResolvedValue({ adrs: [] });
  mockApi.maker.vault.onSessionAdrsChanged.mockReturnValue(() => undefined);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function Harness() {
  return (
    <MemoryRouter initialEntries={['/cc-agent/session-1']}>
      <LocationProbe />
      <Routes>
        <Route
          path="*"
          element={
            <SessionManifestStrip
              sessionId="session-1"
              agentKind="hermes"
              model="qwen3-8b"
              providerId="lmstudio-local"
              permissionMode="default"
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function chips(): HTMLElement[] {
  return screen.queryAllByTestId('manifest-kind-chip');
}

function openLoadPanel(): void {
  fireEvent.click(screen.getByTestId('manifest-toggle-load'));
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = mockApi;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  vi.clearAllMocks();
  defaultData();
  clearPendingManifestPins();
});

afterEach(() => {
  cleanup();
  clearPendingManifestPins();
});

describe('SessionManifestStrip', () => {
  it('renders the seven capability groups with a count', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.queryByTestId('manifest-loading')).toBeNull());
    expect(screen.getByTestId('session-manifest-strip')).toBeTruthy();
    expect(chips().map((chip) => chip.getAttribute('data-kind'))).toEqual(
      expect.arrayContaining([
        'expert',
        'skill',
        'tool',
        'connector',
        'pinned-note',
        'model-route',
        'permission',
      ]),
    );
    expect(screen.getByTestId('manifest-count').textContent).toMatch(/\d+ capabilities/);
  });

  it('clicking a chip reveals the source file and line', async () => {
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    fireEvent.click(chips().find((chip) => chip.getAttribute('data-kind') === 'expert')!);
    const panel = screen.getByTestId('manifest-provenance');
    expect(panel.textContent).toContain('Why is this on?');
    expect(panel.textContent).toContain('/experts/vault-researcher/expert.md:2');
    expect(panel.textContent).toContain('expert-sessions.json');
    const row = screen.getAllByTestId('manifest-capability')[0];
    expect(row.getAttribute('data-source')).toBe('/experts/vault-researcher/expert.md');
    expect(row.getAttribute('data-line')).toBe('2');
  });

  it('Copy as YAML writes the manifest and opens the exact same YAML', async () => {
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('manifest-copy-yaml'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = (navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(copied).toContain('# Cindy session manifest');
    expect(copied).toContain('/experts/vault-researcher/expert.md');
    openLoadPanel();
    expect((screen.getByTestId('manifest-yaml') as HTMLTextAreaElement).value).toBe(copied);
  });

  it('the copied YAML round-trips into a fresh session with the same capability set', async () => {
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('manifest-copy-yaml'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = (navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    openLoadPanel();
    fireEvent.change(screen.getByTestId('manifest-yaml'), { target: { value: copied } });
    fireEvent.click(screen.getByTestId('manifest-compare'));
    expect(screen.getByTestId('manifest-result').textContent).toContain('Same capability set');
    expect(screen.getByTestId('manifest-result').textContent).toContain('fresh:session-1');
  });

  it('rejects malformed YAML and reports a changed capability set', async () => {
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('manifest-copy-yaml'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const yaml = (navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    openLoadPanel();
    const textarea = screen.getByTestId('manifest-yaml');

    fireEvent.change(textarea, { target: { value: 'version: 2\n' } });
    fireEvent.click(screen.getByTestId('manifest-compare'));
    expect(screen.getByTestId('manifest-result').textContent).toContain('Invalid manifest YAML');

    fireEvent.change(textarea, {
      target: { value: yaml.replace(/  - kind: "permission"[\s\S]*$/u, '') },
    });
    fireEvent.click(screen.getByTestId('manifest-compare'));
    expect(screen.getByTestId('manifest-result').textContent).toContain('Different capability set');
  });

  it('New task from manifest applies the expert and queues the pinned notes', async () => {
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    openLoadPanel();
    const yaml = (screen.getByTestId('manifest-yaml') as HTMLTextAreaElement).value;
    expect(yaml).toContain('capabilities:');
    fireEvent.click(screen.getByTestId('manifest-reproduce'));
    expect(mockApi.maker.experts.setPending).toHaveBeenCalledWith('vault-researcher');
    expect(peekPendingManifestPins()).toEqual(['memory/Project - Cindy.md']);
    expect(screen.getByTestId('manifest-result').textContent).toContain('Fresh task recipe');
    fireEvent.click(screen.getByTestId('manifest-open-draft'));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/new');
  });

  it('a missing optional source hides its rows without breaking the strip', async () => {
    mockApi.maker.mcpCatalog.list.mockRejectedValue(new Error('catalog unavailable'));
    mockApi.maker.providers.getRouting.mockRejectedValue(new Error('routing.yaml missing'));
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    expect(screen.getByTestId('session-manifest-strip')).toBeTruthy();
    fireEvent.click(chips().find((chip) => chip.getAttribute('data-kind') === 'tool')!);
    const rows = screen.getAllByTestId('manifest-capability');
    expect(rows.some((row) => row.getAttribute('data-id') === 'tool:mcp:hermes/cindy_vault_notes')).toBe(
      false,
    );
    expect(rows.some((row) => row.getAttribute('data-id') === 'tool:search_notes')).toBe(true);
  });

  it('falls back to enabled skills when no expert is bound', async () => {
    mockApi.maker.experts.getSessionBinding.mockResolvedValue(null);
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    expect(
      chips().find((chip) => chip.getAttribute('data-kind') === 'expert')?.getAttribute('data-count'),
    ).toBe('0');
    fireEvent.click(chips().find((chip) => chip.getAttribute('data-kind') === 'skill')!);
    expect(screen.getAllByTestId('manifest-capability')[0].getAttribute('data-id')).toBe(
      'skill:research/vault-notes',
    );
  });

  it('keeps an empty group visible with an explicit zero', async () => {
    mockApi.maker.vault.getPinnedNotes.mockResolvedValue([]);
    render(<Harness />);
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    const pinned = chips().find((chip) => chip.getAttribute('data-kind') === 'pinned-note')!;
    expect(pinned.getAttribute('data-count')).toBe('0');
    fireEvent.click(pinned);
    expect(screen.getByTestId('manifest-provenance').textContent).toContain(
      'Nothing of this kind is active',
    );
  });

  it('refreshes the adr chip when the first send records matched ADRs', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.queryByTestId('manifest-loading')).toBeNull());
    const adrChip = () => chips().find((chip) => chip.getAttribute('data-kind') === 'adr');
    expect(adrChip()?.getAttribute('data-count') ?? '0').toBe('0');

    mockApi.maker.vault.getSessionAdrs.mockResolvedValue({
      workspaceDir: '/repo',
      adrs: [
        {
          title: 'Use SQLite for the session store',
          path: 'docs/decisions/0001-use-sqlite.md',
          source: 'repo',
          status: 'Accepted',
        },
      ],
    });
    const listener = mockApi.maker.vault.onSessionAdrsChanged.mock.calls[0]?.[0] as
      | ((payload: { sessionId: string }) => void)
      | undefined;
    expect(listener).toBeTypeOf('function');
    act(() => listener?.({ sessionId: 'other-session' }));
    act(() => listener?.({ sessionId: 'session-1' }));
    await waitFor(() => expect(adrChip()?.getAttribute('data-count')).toBe('1'));
  });

  it('pins queued notes onto a different session view', async () => {
    // Simulates the fresh session mounting after "New task from manifest".
    const { setPendingManifestPins } = await import('../sessionManifestPins');
    setPendingManifestPins('session-1', ['memory/Project - Cindy.md']);
    render(
      <MemoryRouter initialEntries={['/cc-agent/session-2']}>
        <Routes>
          <Route
            path="*"
            element={
              <SessionManifestStrip
                sessionId="session-2"
                agentKind="hermes"
                model="qwen3-8b"
                providerId="lmstudio-local"
                permissionMode="default"
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockApi.maker.vault.pinNote).toHaveBeenCalledWith(
      'session-2',
      'memory/Project - Cindy.md',
    ));
    expect(peekPendingManifestPins()).toBeNull();
  });
});
