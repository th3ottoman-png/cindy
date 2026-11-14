// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeStatus } from '@cindy/maker-core/runtime-status';

import { RuntimesTab } from '../RuntimesTab';
import type { RosterRow } from '../agentsRosterModel';

const rows: RosterRow[] = [
  { id: 'expert:orchestrator', kind: 'expert', slug: 'orchestrator', name: 'Orchestrator', description: '', program: 'hermes', source: 'mine', path: '/x/expert.md', prompt: '' },
  { id: 'expert:reviewer', kind: 'expert', slug: 'reviewer', name: 'Reviewer', description: '', program: 'hermes', source: 'mine', path: '/y/expert.md', prompt: '' },
  { id: 'imported:claude-user:arch.md', kind: 'imported', name: 'Architect', description: '', program: 'claude-code + hermes', source: 'claude-user', path: '/z/arch.md', prompt: '', runsOn: ['claude-code', 'hermes'] },
];

const statuses: RuntimeStatus[] = [
  { id: 'hermes', path: '/usr/local/bin/hermes', version: '0.23.0', pinned: '0.22.7', matchesPin: false, health: 'ok' },
  { id: 'claude-code', path: '/usr/local/bin/claude', version: '2.1.258', matchesPin: null, health: 'ok' },
  { id: 'codex', path: '/usr/local/bin/codex', version: '0.145.0', matchesPin: null, health: 'ok' },
  { id: 'pi', matchesPin: null, health: 'missing', detail: 'not installed or not on PATH' },
];

let mockList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockList = vi.fn().mockResolvedValue({ runtimes: statuses });
  window.electronAPI = { maker: { runtimes: { list: mockList } } } as any;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as any).electronAPI;
});

describe('RuntimesTab', () => {
  it('renders a card per runtime with path, version, pin and agent count', async () => {
    render(<RuntimesTab rows={rows} />);
    await waitFor(() => expect(screen.getByTestId('runtime-card-hermes')).toBeTruthy());
    expect(screen.getByTestId('runtime-version-hermes').textContent).toBe('0.23.0');
    expect(screen.getByTestId('runtime-pin-hermes').textContent).toContain('mismatch');
    expect(screen.getByTestId('runtime-path-pi').textContent).toBe('not installed');
    expect(screen.getByTestId('runtime-health-pi').textContent).toBe('missing');
    // orchestrator + reviewer (hermes experts) + architect (runsOn hermes) = 3
    expect(screen.getByTestId('runtime-agents-hermes').textContent).toContain('3');
    expect(screen.getByTestId('runtime-agents-claude-code').textContent).toContain('1');
  });

  it('Recheck refetches the runtime list', async () => {
    render(<RuntimesTab rows={rows} />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('runtimes-recheck'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });
});
