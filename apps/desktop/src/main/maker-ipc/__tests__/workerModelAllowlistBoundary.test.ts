import { describe, expect, it, vi } from 'vitest';

import type { WorkersConfig } from '@cindy/model-providers/routing-file';

import {
  createOrcaWorkerCreationService,
  type OrcaLeadSessionSnapshot,
  type OrcaWorkerCreateInTeamParams,
  type OrcaWorkerCreationDeps,
  type OrcaWorkerCreationResult,
} from '../orcaWorkerCreationService';
import { createHermesWorkerInTeam, type HermesWorkerInput } from '../orcaHermesWorker';

const ON: WorkersConfig = { allowModelChoice: true, allowedRoutes: ['cheap-api', 'local-small'] };

const FAILURE = (err: unknown) => ({
  ok: false as const,
  errorCode: 'INTERNAL' as const,
  message: err instanceof Error ? err.message : String(err),
});

function hermesInput(overrides: {
  model?: string;
  expert?: string;
  workerAllowlist?: WorkersConfig | null;
}): HermesWorkerInput {
  const reserveWorkerCreation = vi.fn(async () => ({ ok: true as const, occupiedSlotsBefore: 0 }));
  const deps = {
    resolveHermesWorkerExpert: vi.fn(() => ({ ok: true as const, model: 'expert-route' })),
    bindWorkerExpert: vi.fn(),
    createId: vi.fn(() => 'worker-1'),
    createSessionId: vi.fn(() => 'session-worker-1'),
    readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 3, workerHardLimit: 6 })),
    reserveWorkerCreation,
    renewWorkerCreationReservation: vi.fn(async () => true),
    releaseWorkerCreationReservation: vi.fn(async () => undefined),
    buildCreateOptsWithStderr: vi.fn((opts) => opts),
    bootstrapSession: vi.fn(async () => ({ session: { id: 'session-worker-1' } })),
    addOrUpdateWorker: vi.fn(async () => undefined),
    markOrcaRoleIfNeeded: vi.fn(async () => undefined),
    resolveWorkerWorkingDir: vi.fn(async () => '/tmp/project'),
  } as unknown as OrcaWorkerCreationDeps;
  const params = {
    teamId: 'team-1',
    leadSessionId: 'lead-1',
    agent: 'hermes',
    role: 'reviewer',
    label: 'reviewer',
    workerPermissionMode: 'bypassPermissions',
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.expert !== undefined ? { expert: overrides.expert } : {}),
  } as OrcaWorkerCreateInTeamParams;
  const lead = {
    id: 'lead-1',
    agentKind: 'hermes',
    workspaceKind: 'project',
    workingDir: '/tmp/project',
    model: 'lead-model',
    effort: null,
    permissionMode: 'bypassPermissions',
    fastMode: false,
    providerId: null,
    remoteHostId: null,
  } as OrcaLeadSessionSnapshot;
  return {
    deps,
    params,
    role: 'reviewer',
    label: 'reviewer',
    lead,
    settings: { workerSoftLimit: 3, workerHardLimit: 6 },
    validatePlan: vi.fn(async () => null),
    shared: {
      leaseMs: 30_000,
      title: () => 'Worker',
      limitSnapshot: (hard: number, occupied: number) => ({
        workerHardLimit: hard,
        occupiedSlots: occupied,
        remainingSlots: hard - occupied,
      }),
      cleanup: vi.fn(async () => undefined),
      toInternalFailure: FAILURE,
      isLabelConstraintError: () => false,
    },
    workerAllowlist: overrides.workerAllowlist === undefined ? ON : overrides.workerAllowlist,
  };
}

describe('Hermes worker model allowlist (ROADMAP 13.8, before any slot is reserved)', () => {
  it('refuses an unlisted lead model with the allowed list, without reserving a slot', async () => {
    const input = hermesInput({ model: 'pricey-api' });
    const result = await createHermesWorkerInTeam(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('INVALID_PARAMS');
      expect(result.message).toContain('cheap-api, local-small');
      expect(result.message).toContain('No Worker was started');
    }
    expect(input.deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(input.deps.createId).not.toHaveBeenCalled();
  });

  it('starts a listed lead model', async () => {
    const input = hermesInput({ model: 'cheap-api' });
    const result = await createHermesWorkerInTeam(input);
    expect(result).toMatchObject({ ok: true });
    expect(input.deps.reserveWorkerCreation).toHaveBeenCalledOnce();
  });

  it('always allows the expert route and the Hermes default', async () => {
    const expert = await createHermesWorkerInTeam(hermesInput({ expert: 'code-reviewer' }));
    expect(expert).toMatchObject({ ok: true });
    expect(expert.ok && expert.resolved.model).toBe('expert-route');

    const defaulted = await createHermesWorkerInTeam(hermesInput({}));
    expect(defaulted).toMatchObject({ ok: true });
    expect(defaulted.ok && defaulted.resolved.model).toBe('hermes-default');
  });

  it('choice off refuses even a listed route', async () => {
    const input = hermesInput({
      model: 'cheap-api',
      workerAllowlist: { allowModelChoice: false, allowedRoutes: ['cheap-api'] },
    });
    const result = await createHermesWorkerInTeam(input);
    expect(result.ok).toBe(false);
    expect(input.deps.reserveWorkerCreation).not.toHaveBeenCalled();
  });

  it('no managed block keeps today\'s behaviour', async () => {
    const input = hermesInput({ model: 'pricey-api', workerAllowlist: null });
    expect(await createHermesWorkerInTeam(input)).toMatchObject({ ok: true });
  });
});

describe('non-Hermes Cindy tool boundary (ROADMAP 13.8, adapters untouched)', () => {
  function boundaryService(allowlist: WorkersConfig | null) {
    const listWorkersByLead = vi.fn(async () => []);
    const getLeadSessionRow = vi.fn(async () => null);
    const deps = {
      readWorkerAllowlist: () => allowlist,
      listWorkersByLead,
      getLeadSessionRow,
      isActiveWorkerStatus: () => false,
      readCollaborationSettings: () => ({ workerSoftLimit: 3, workerHardLimit: 6 }),
      validateCreationPlan: vi.fn(async () => null),
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-1', leadSessionId: 'lead-1' })),
    } as unknown as OrcaWorkerCreationDeps;
    return { service: createOrcaWorkerCreationService(deps), listWorkersByLead, getLeadSessionRow };
  }

  const params = (model: string): OrcaWorkerCreateInTeamParams => ({
    teamId: 'team-1',
    leadSessionId: 'lead-1',
    agent: 'claude-code',
    role: 'reviewer',
    label: 'reviewer',
    model,
    workerPermissionMode: 'bypassPermissions',
  } as OrcaWorkerCreateInTeamParams);

  it('refuses an unlisted model before any creation work begins', async () => {
    const { service, listWorkersByLead, getLeadSessionRow } = boundaryService(ON);
    const result: OrcaWorkerCreationResult = await service.createWorkerInTeam(params('pricey-api'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('INVALID_PARAMS');
      expect(result.message).toContain('cheap-api, local-small');
    }
    expect(listWorkersByLead).not.toHaveBeenCalled();
    expect(getLeadSessionRow).not.toHaveBeenCalled();
  });

  it('allows a listed model and no block through the boundary', async () => {
    // Both pass the allowlist gate and reach the next real check (lead row lookup).
    // A stubbed null lead row yields NOT_FOUND, never the allowlist refusal.
    for (const [allowlist, model] of [[ON, 'cheap-api'], [null, 'pricey-api']] as const) {
      const { service, getLeadSessionRow } = boundaryService(allowlist);
      const result = await service.createWorkerInTeam(params(model));
      expect(result).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
      expect(getLeadSessionRow).toHaveBeenCalledOnce();
    }
  });
});
