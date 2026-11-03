import { describe, expect, it, vi } from 'vitest';

import { startOrcaTeamWithPermissionGate } from '../orcaStartTeamPermissionGate.js';

describe('startOrcaTeamWithPermissionGate', () => {
  it.each(['cancelled', 'timeout', 'session_closed', 'session_aborted'] as const)(
    'does not update preferences or create a Team when confirmation ends as %s',
    async (reason) => {
      const startTeam = vi.fn();

      const result = await startOrcaTeamWithPermissionGate(
        { leadSessionId: 'lead-1', workerPermissionMode: 'bypassPermissions' },
        {
          getCurrentWorkerPermissionMode: () => 'auto',
          requestFullAccessConfirmation: vi.fn().mockResolvedValue({
            confirmed: false,
            reason,
          }),
          startTeam,
        },
      );

      expect(result).toMatchObject({
        ok: false,
        errorCode: reason === 'timeout' ? 'CONFIRM_TIMEOUT' : 'USER_CANCELLED',
      });
      expect(startTeam).not.toHaveBeenCalled();
    },
  );

  it('calls lifecycle only after the user confirms Full access', async () => {
    const startTeam = vi.fn().mockResolvedValue({ ok: true, teamId: 'team-1' });
    const requestFullAccessConfirmation = vi.fn().mockResolvedValue({ confirmed: true });

    const result = await startOrcaTeamWithPermissionGate(
      { leadSessionId: 'lead-1', workerPermissionMode: 'bypassPermissions' },
      {
        getCurrentWorkerPermissionMode: () => 'auto',
        requestFullAccessConfirmation,
        startTeam,
      },
    );

    expect(requestFullAccessConfirmation).toHaveBeenCalledWith('lead-1');
    expect(startTeam).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      workerPermissionMode: 'bypassPermissions',
    });
    expect(result).toEqual({ ok: true, teamId: 'team-1' });
  });

  it.each([
    ['auto', 'auto'],
    ['auto', undefined],
    ['bypassPermissions', 'bypassPermissions'],
  ] as const)('does not prompt when current=%s and requested=%s', async (current, requested) => {
    const requestFullAccessConfirmation = vi.fn();
    const startTeam = vi.fn().mockResolvedValue({ ok: true, teamId: 'team-1' });

    await startOrcaTeamWithPermissionGate(
      { leadSessionId: 'lead-1', workerPermissionMode: requested },
      {
        getCurrentWorkerPermissionMode: () => current,
        requestFullAccessConfirmation,
        startTeam,
      },
    );

    expect(requestFullAccessConfirmation).not.toHaveBeenCalled();
    expect(startTeam).toHaveBeenCalledTimes(1);
  });

  // 3.9 Debt: a Hermes worker cannot run in Auto ("Capability 'permissionMode:auto' not
  // supported"), so a Hermes lead's team is refused up front instead of failing at create_worker.
  it.each([
    ['auto', 'auto'],
    ['auto', undefined],
    ['bypassPermissions', 'auto'],
  ] as const)(
    'refuses a Hermes lead when current=%s and requested=%s',
    async (current, requested) => {
      const requestFullAccessConfirmation = vi.fn();
      const startTeam = vi.fn();

      const result = await startOrcaTeamWithPermissionGate(
        { leadSessionId: 'lead-1', workerPermissionMode: requested },
        {
          getCurrentWorkerPermissionMode: () => current,
          isHermesLead: () => true,
          requestFullAccessConfirmation,
          startTeam,
        },
      );

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'INVALID_PARAMS',
        message: expect.stringContaining('worker_permission_mode: "bypassPermissions"'),
      });
      expect(requestFullAccessConfirmation).not.toHaveBeenCalled();
      expect(startTeam).not.toHaveBeenCalled();
    },
  );

  it('lets a Hermes lead start a bypassPermissions team, and leaves other leads on Auto alone', async () => {
    const hermesStart = vi.fn().mockResolvedValue({ ok: true, teamId: 'team-1' });
    await startOrcaTeamWithPermissionGate(
      { leadSessionId: 'lead-1', workerPermissionMode: 'bypassPermissions' },
      {
        getCurrentWorkerPermissionMode: () => 'bypassPermissions',
        isHermesLead: () => true,
        requestFullAccessConfirmation: vi.fn(),
        startTeam: hermesStart,
      },
    );
    expect(hermesStart).toHaveBeenCalledTimes(1);

    const otherStart = vi.fn().mockResolvedValue({ ok: true, teamId: 'team-2' });
    await startOrcaTeamWithPermissionGate(
      { leadSessionId: 'lead-2', workerPermissionMode: 'auto' },
      {
        getCurrentWorkerPermissionMode: () => 'auto',
        isHermesLead: () => false,
        requestFullAccessConfirmation: vi.fn(),
        startTeam: otherStart,
      },
    );
    expect(otherStart).toHaveBeenCalledTimes(1);
  });
});
