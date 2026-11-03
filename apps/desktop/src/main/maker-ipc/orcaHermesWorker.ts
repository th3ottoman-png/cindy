/**
 * Hermes as an Orca worker, optionally started as a Cindy expert (ROADMAP 3.9a, ADR 0008).
 *
 * `createWorkerInTeam` hands `agent: 'hermes'` here so its provider routing stays untouched:
 * Hermes has no providers in that path (its model is a Cindy route name or the home model,
 * preflighted by the Hermes adapter on every turn). The admission, bootstrap and rollback steps
 * mirror the shared path. Local only.
 */

import type {
  OrcaLeadSessionSnapshot,
  OrcaWorkerCreateInTeamParams,
  OrcaWorkerCreationDeps,
  OrcaWorkerCreationResult,
  OrcaWorkerLimitSnapshot,
  OrcaWorkerCreationPlanValidator,
} from './orcaWorkerCreationService.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { resolveOrcaWorkerPermissionMode } from '../../shared/orca-worker-permission-mode.js';

/** The Hermes home model sentinel (same id the Hermes adapter and model picker use). */
export const HERMES_WORKER_DEFAULT_MODEL = 'hermes-default';

type Failure = Extract<OrcaWorkerCreationResult, { ok: false }>;

export interface HermesWorkerInput {
  deps: OrcaWorkerCreationDeps;
  params: OrcaWorkerCreateInTeamParams;
  role: string;
  label: string;
  lead: OrcaLeadSessionSnapshot;
  settings: { workerSoftLimit: number; workerHardLimit: number };
  validatePlan: (
    workingDir?: string,
    route?: Parameters<OrcaWorkerCreationPlanValidator>[2],
  ) => Promise<number | null | undefined>;
  assertCurrent?: () => Promise<void>;
  onCreated?: (assertCreatedCurrent: () => Promise<void>) => void;
  shared: {
    leaseMs: number;
    title: (role: string, label: string) => string;
    limitSnapshot: (workerHardLimit: number, occupiedSlots: number) => OrcaWorkerLimitSnapshot;
    cleanup: (sessionId: string) => Promise<void>;
    toInternalFailure: (err: unknown) => Failure;
    isLabelConstraintError: (err: unknown) => boolean;
  };
}

function invalid(message: string): Failure {
  return { ok: false, errorCode: 'INVALID_PARAMS', message };
}

export async function createHermesWorkerInTeam(
  input: HermesWorkerInput,
): Promise<OrcaWorkerCreationResult> {
  const {
    deps,
    params,
    role,
    label,
    lead,
    settings,
    validatePlan,
    assertCurrent,
    onCreated,
    shared,
  } = input;
  if (!deps.resolveHermesWorkerExpert || !deps.bindWorkerExpert) {
    return invalid('Hermes workers are not available in this host.');
  }
  if (
    params.executionDeviceId !== undefined ||
    params.agentDeviceId !== undefined ||
    params.worktree !== undefined ||
    lead.remoteHostId
  ) {
    return invalid(
      'Hermes workers run on this computer only: no execution_device_id, agent_device_id, new_worktree or SSH lead.',
    );
  }

  // The Hermes adapter has no Auto mode; refuse before any expert check, binding or slot (3.9 Debt).
  if (resolveOrcaWorkerPermissionMode(params.workerPermissionMode) === 'auto') {
    return invalid(
      'Hermes workers cannot run in Auto mode, and this team uses worker_permission_mode "auto". End the team and call start_team with worker_permission_mode: "bypassPermissions" (Full access). No Worker was started.',
    );
  }

  // Expert first, fail closed: nothing is reserved or started for an expert that cannot run.
  let expertModel: string | undefined;
  if (params.expert !== undefined) {
    const expert = deps.resolveHermesWorkerExpert(params.expert);
    if (!expert.ok) return invalid(expert.message);
    expertModel = expert.model;
  }
  const model = params.model ?? expertModel ?? HERMES_WORKER_DEFAULT_MODEL;

  let workingDir = lead.workingDir ?? '';
  if (params.workingDir !== undefined) {
    try {
      workingDir = await deps.resolveWorkerWorkingDir(params.workingDir, lead);
    } catch {
      return invalid(
        'working_dir is unavailable or collaboration is disabled for that directory; no Worker was started',
      );
    }
  }
  const resolved = { model, effort: null, fastMode: false as const, providerId: null };

  const workerId = deps.createId();
  let reservation: Awaited<ReturnType<OrcaWorkerCreationDeps['reserveWorkerCreation']>>;
  try {
    const admit = async () => {
      const latestLimit = await validatePlan(workingDir, resolved);
      settings.workerHardLimit = deps.readCollaborationSettings().workerHardLimit;
      if (latestLimit != null)
        settings.workerHardLimit = Math.min(settings.workerHardLimit, latestLimit);
      return deps.reserveWorkerCreation({
        reservationId: workerId,
        teamId: params.teamId,
        label,
        hardLimit: settings.workerHardLimit,
        leaseMs: shared.leaseMs,
      });
    };
    reservation = deps.withLeadSendLock
      ? await deps.withLeadSendLock(params.leadSessionId, admit)
      : await admit();
  } catch (err) {
    return shared.toInternalFailure(err);
  }
  if (!reservation.ok) {
    if (reservation.errorCode === 'DUPLICATE_LABEL') {
      return {
        ok: false,
        errorCode: 'DUPLICATE_LABEL',
        message: `label "${label}" already used in this team`,
      };
    }
    if (reservation.errorCode === 'WORKER_CREATION_IN_PROGRESS') {
      return {
        ok: false,
        errorCode: 'WORKER_CREATION_IN_PROGRESS',
        message: `label "${label}" is currently being created`,
      };
    }
    return {
      ok: false,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
      message: `hard limit ${settings.workerHardLimit} reached`,
      limit: shared.limitSnapshot(settings.workerHardLimit, settings.workerHardLimit),
    };
  }
  const occupiedSlotsBefore = reservation.occupiedSlotsBefore;
  const softLimitExceeded = occupiedSlotsBefore >= settings.workerSoftLimit;

  try {
    const workerSessionId = deps.createSessionId();
    const workerOpts = deps.buildCreateOptsWithStderr({
      id: workerSessionId,
      agentKind: 'hermes',
      workspaceKind: params.workingDir === undefined ? lead.workspaceKind : 'project',
      workingDir,
      model,
      permissionMode: resolveOrcaWorkerPermissionMode(params.workerPermissionMode),
      title: shared.title(role, label),
      orcaRole: 'worker',
      vendorOptions: {
        orcaRole: 'worker' as const,
        orcaWorkflowId: params.teamId,
        orcaLeadSessionId: params.leadSessionId,
        orcaWorkerId: workerId,
        orcaWorkerSessionId: workerSessionId,
      },
    } satisfies MakerSessionCreateOpts);

    let sessionId: string;
    try {
      await assertCurrent?.();
      // Bound before bootstrap starts the Hermes agent: its tool bridge reads the binding at start
      // (cindy_experts for an Expert Creator or memory expert, ROADMAP 3.9b), and the first turn
      // (the initial task) then starts as the expert. A failed bootstrap leaves an inert binding
      // for a session id that never existed.
      if (params.expert !== undefined) deps.bindWorkerExpert(workerSessionId, params.expert);
      sessionId = (await deps.bootstrapSession(workerOpts)).session.id;
    } catch (err) {
      return shared.toInternalFailure(err);
    }

    try {
      if (
        !(await deps.renewWorkerCreationReservation(workerId, shared.leaseMs).catch(() => false))
      ) {
        throw new Error('worker creation reservation expired before persistence');
      }
      await validatePlan(workingDir, resolved);
      await deps.addOrUpdateWorker({
        id: workerId,
        teamId: params.teamId,
        sessionId,
        status: 'idle',
        label,
        role,
        focused: false,
      });
    } catch (err) {
      await shared.cleanup(sessionId);
      if (shared.isLabelConstraintError(err)) {
        return {
          ok: false,
          errorCode: 'DUPLICATE_LABEL',
          message: `label "${label}" already used in this team`,
        };
      }
      return shared.toInternalFailure(err);
    }

    try {
      await deps.markOrcaRoleIfNeeded(sessionId, 'worker');
    } catch (err) {
      await shared.cleanup(sessionId);
      await deps.removeWorker(workerId).catch(() => undefined);
      return shared.toInternalFailure(err);
    }

    onCreated?.(async () => {
      await validatePlan(workingDir, resolved);
    });
    return {
      ok: true,
      teamId: params.teamId,
      workerId,
      workerSessionId: sessionId,
      workingDir,
      softLimitExceeded,
      limit: shared.limitSnapshot(settings.workerHardLimit, occupiedSlotsBefore + 1),
      resolved: { agent: 'hermes', ...resolved, role, label },
    };
  } finally {
    await deps.releaseWorkerCreationReservation(workerId).catch(() => undefined);
  }
}
