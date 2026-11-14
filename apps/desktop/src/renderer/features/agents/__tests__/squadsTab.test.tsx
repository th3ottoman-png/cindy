// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SquadsTab } from '../SquadsTab';
import type { RosterRow } from '../agentsRosterModel';
import { prefillSquadLaunchDraft } from '../../cc-agent/lib/startExpertHandoff';

vi.mock('../../cc-agent/lib/startExpertHandoff', () => ({ prefillSquadLaunchDraft: vi.fn() }));

const rows: RosterRow[] = [
  { id: 'expert:orchestrator', kind: 'expert', slug: 'orchestrator', name: 'Orchestrator', description: '', program: 'hermes', source: 'mine', path: '/x/expert.md', prompt: '' },
  { id: 'expert:reviewer', kind: 'expert', slug: 'reviewer', name: 'Reviewer', description: '', program: 'hermes', source: 'mine', path: '/y/expert.md', prompt: '' },
  { id: 'expert:cc-only', kind: 'expert', slug: 'cc-only', name: 'CC Only', description: '', program: 'claude-code', source: 'mine', path: '/z/expert.md', prompt: '' },
];

const squad = {
  slug: 'review-squad', name: 'Review squad', description: 'Reviews a diff.',
  lead: 'expert:orchestrator', members: ['expert:reviewer'],
  workerPermissionMode: 'bypassPermissions', maxTurns: 20, file: '/x/squad.yaml',
};

const plan = {
  leadRosterId: 'expert:orchestrator', leadBindingId: 'orchestrator',
  members: [{ rosterId: 'expert:reviewer', bindingId: 'reviewer' }],
  workerPermissionMode: 'bypassPermissions' as const, maxTurns: 20,
  kickoffMessage: '@agent:expert:reviewer\n\nReview the diff.',
};

let mockList: ReturnType<typeof vi.fn>;
let mockSave: ReturnType<typeof vi.fn>;
let mockResolveLaunch: ReturnType<typeof vi.fn>;
let mockSetPending: ReturnType<typeof vi.fn>;

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/agents']}>
      <SquadsTab rows={rows} workingDir={null} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockList = vi.fn().mockResolvedValue({ squads: [squad], capped: false });
  mockSave = vi.fn().mockResolvedValue({ ok: true, slug: 'new-squad', file: '/x/squad.yaml' });
  mockResolveLaunch = vi.fn().mockResolvedValue({ ok: true, plan, leadName: 'Orchestrator', members: [{ rosterId: 'expert:reviewer', name: 'Reviewer' }] });
  mockSetPending = vi.fn().mockResolvedValue('orchestrator');
  window.electronAPI = {
    maker: {
      squads: { list: mockList, save: mockSave, resolveLaunch: mockResolveLaunch, onChanged: () => () => undefined },
      experts: { setPending: mockSetPending },
    },
  } as any;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as any).electronAPI;
});

describe('SquadsTab', () => {
  it('lists squads and offers only Hermes-runnable agents in the form', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('squad-card-review-squad')).toBeTruthy());
    fireEvent.click(screen.getByTestId('squads-new'));
    const leadSelect = screen.getByTestId('squad-form-lead') as HTMLSelectElement;
    const options = Array.from(leadSelect.options).map((o) => o.value);
    expect(options).toContain('expert:orchestrator');
    expect(options).toContain('expert:reviewer');
    expect(options).not.toContain('expert:cc-only');
  });

  it('creates a squad through the host save', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('squads-new')).toBeTruthy());
    fireEvent.click(screen.getByTestId('squads-new'));
    fireEvent.change(screen.getByTestId('squad-form-name'), { target: { value: 'New Squad' } });
    fireEvent.change(screen.getByTestId('squad-form-lead'), { target: { value: 'expert:orchestrator' } });
    fireEvent.click(screen.getByTestId('squad-form-save'));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    const request = mockSave.mock.calls[0][0];
    expect(request.op).toBe('create');
    expect(request.fields.name).toBe('New Squad');
    expect(request.fields.lead).toBe('expert:orchestrator');
  });

  it('launch resolves the plan, sets the pending lead, prefills and navigates', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('squad-launch-open-review-squad')).toBeTruthy());
    fireEvent.click(screen.getByTestId('squad-launch-open-review-squad'));
    fireEvent.change(screen.getByTestId('squad-launch-task-review-squad'), { target: { value: 'Review the diff.' } });
    fireEvent.click(screen.getByTestId('squad-launch-confirm-review-squad'));
    await waitFor(() => expect(mockSetPending).toHaveBeenCalledWith('orchestrator', null));
    expect(mockResolveLaunch).toHaveBeenCalledWith('review-squad', null, 'Review the diff.');
    expect(prefillSquadLaunchDraft).toHaveBeenCalledWith(plan, null);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/cc-agent/new'));
  });

  it('shows the fail-closed errors and does not navigate when the plan refuses', async () => {
    mockResolveLaunch.mockResolvedValue({ ok: false, errors: ['member "expert:ghost" is not in the roster'] });
    renderTab();
    await waitFor(() => expect(screen.getByTestId('squad-launch-open-review-squad')).toBeTruthy());
    fireEvent.click(screen.getByTestId('squad-launch-open-review-squad'));
    fireEvent.click(screen.getByTestId('squad-launch-confirm-review-squad'));
    await waitFor(() => expect(screen.getByTestId('squads-notice').textContent).toMatch(/ghost/));
    expect(mockSetPending).not.toHaveBeenCalled();
    expect(prefillSquadLaunchDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/agents');
  });
});
