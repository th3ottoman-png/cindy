import type { OrcaWorkerPermissionMode } from '../../shared/orca-worker-permission-mode.js';
import type { OrcaWorkerPermissionConfirmDecision } from './orcaWorkerPermissionConfirmBridge.js';

export interface OrcaStartTeamPermissionGateParams {
  leadSessionId: string;
  workerPermissionMode?: OrcaWorkerPermissionMode;
}

interface OrcaStartTeamPermissionGateDeps<TResult> {
  getCurrentWorkerPermissionMode: () => OrcaWorkerPermissionMode;
  /** True when the lead is a Hermes session; its workers are Hermes and cannot run in Auto. */
  isHermesLead?: (leadSessionId: string) => boolean | Promise<boolean>;
  requestFullAccessConfirmation: (
    leadSessionId: string,
  ) => Promise<OrcaWorkerPermissionConfirmDecision>;
  startTeam: (params: OrcaStartTeamPermissionGateParams) => Promise<TResult>;
}

export type OrcaStartTeamPermissionGateResult<TResult> =
  | TResult
  | {
      ok: false;
      errorCode: 'USER_CANCELLED' | 'CONFIRM_TIMEOUT' | 'INVALID_PARAMS';
      message: string;
    };

/** 3.9 Debt: the Hermes adapter has no Auto mode ("Capability 'permissionMode:auto' not supported"). */
export const HERMES_LEAD_AUTO_REFUSAL =
  'Hermes workers cannot run in Auto mode. Call start_team again with worker_permission_mode: "bypassPermissions" (Full access). No team was started.';

/**
 * Agent tool 把 Worker 默认权限提升为 Full access 前的 Main 侧门禁。
 *
 * lifecycle.startTeam 同时负责更新偏好和创建 Team，因此必须在用户确认成功后才能调用。
 */
export async function startOrcaTeamWithPermissionGate<TResult>(
  params: OrcaStartTeamPermissionGateParams,
  deps: OrcaStartTeamPermissionGateDeps<TResult>,
): Promise<OrcaStartTeamPermissionGateResult<TResult>> {
  const effectiveMode = params.workerPermissionMode ?? deps.getCurrentWorkerPermissionMode();
  if (effectiveMode === 'auto' && (await deps.isHermesLead?.(params.leadSessionId))) {
    return { ok: false, errorCode: 'INVALID_PARAMS', message: HERMES_LEAD_AUTO_REFUSAL };
  }
  const requiresConfirmation =
    deps.getCurrentWorkerPermissionMode() !== 'bypassPermissions' &&
    params.workerPermissionMode === 'bypassPermissions';
  if (requiresConfirmation) {
    const decision = await deps.requestFullAccessConfirmation(params.leadSessionId);
    if (!decision.confirmed) {
      return {
        ok: false,
        errorCode: decision.reason === 'timeout' ? 'CONFIRM_TIMEOUT' : 'USER_CANCELLED',
        message:
          decision.reason === 'timeout'
            ? 'Worker Full access 确认超时，本次未更新默认权限，也未开启协同。'
            : '用户未确认 Worker Full access，本次未更新默认权限，也未开启协同。',
      };
    }
  }
  return deps.startTeam(params);
}
