/**
 * Cross-layer holder for the teammate proposal gate (ROADMAP 12.3b, ADR 0011 §4).
 *
 * The real implementation lives in maker-ipc/register.ts (it needs the teammate store,
 * the Orca creation service and the broadcast closures); maker-host builds the orca
 * bridge deps earlier and must not depend on maker-ipc (same direction rule as
 * remote-session-start-ensure.ts). Injected at IPC registration, read at tool-call time.
 * Unset = fail closed: no teammate may propose.
 */

export interface TeammateProposalBridge {
  canPropose(params: { leadSessionId: string; workerSessionId: string }): Promise<boolean>;
  propose(params: {
    leadSessionId: string;
    workerSessionId: string;
    workerId: string;
    rosterId: string;
    reason: string;
  }): Promise<{ ok: true; proposalId: string } | { ok: false; message: string }>;
}

let impl: TeammateProposalBridge | null = null;

export function setTeammateProposalBridge(bridge: TeammateProposalBridge): void {
  impl = bridge;
}

export function getTeammateProposalBridge(): TeammateProposalBridge | null {
  return impl;
}
