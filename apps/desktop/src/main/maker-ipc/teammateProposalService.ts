/**
 * "May bring in others" — propose-only teammate proposals (ROADMAP 12.3b, ADR 0011 §4).
 *
 * A teammate whose owner opted it in can propose another roster entry through the
 * orca_worker_bridge propose_teammate tool. Nothing joins at propose time: the proposal
 * waits in the teammate registry until the owner confirms it from the manifest strip.
 * Confirming joins the target to the SAME lead as a second worker — the lead spawns it,
 * never the proposing worker (depth 1, ADR 0005). The permission ceiling is re-checked
 * at confirm time: only a Full-access lead can host, exactly like an @agent: mention.
 *
 * Fail closed: an unopted caller, a malformed or unloadable roster id, an already-joined
 * target, or a lead below Full access refuses with a message saying what to fix.
 */

import { randomUUID } from 'node:crypto';

import { parseTeammateRosterId } from '@cindy/maker-core/teammate-mention';

import { throwIpcError } from '../utils/ipcValidate.js';
import type { OrcaWorkerPermissionMode } from '../../shared/orca-worker-permission-mode.js';
import type { SessionTeammateRecord, SessionTeammatesStore } from './sessionTeammates.js';
import {
  teammateLabelForRoster,
  type TeammateLeadSnapshot,
  type TeammateRosterResolution,
  type TeammateWorkerCreation,
} from './teammateMentionService.js';

export interface TeammateProposalDeps {
  getLeadSnapshot(sessionId: string): Promise<TeammateLeadSnapshot | null>;
  /** Fail-closed roster check, same as the mention flow. */
  resolveRosterEntry(rosterId: string, projectDir: string | null): TeammateRosterResolution;
  getActiveTeam(leadSessionId: string): Promise<{ id: string } | null>;
  startTeam(
    leadSessionId: string,
    workerPermissionMode: OrcaWorkerPermissionMode,
  ): Promise<{ ok: true; teamId: string } | { ok: false; message: string }>;
  createWorker(
    params: TeammateWorkerCreation,
  ): Promise<{ ok: true; workerId: string; workerSessionId: string } | { ok: false; message: string }>;
  dispatchToWorker(params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
  }): Promise<{ ok: boolean; message?: string }>;
  buildJoinPrompt(leadSessionId: string, question: string): Promise<string | null>;
  store: SessionTeammatesStore;
  onTeammatesChanged?: (leadSessionId: string) => void;
  log?: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

export type TeammateProposalResult =
  | { ok: true; proposalId: string }
  | { ok: false; message: string };

export interface TeammateProposalService {
  /** The bridge's call-time gate: joined teammate AND the owner opted it in. */
  canPropose(params: { leadSessionId: string; workerSessionId: string }): Promise<boolean>;
  /** Called by the bridge tool; returns a result the tool renders (never throws IpcError). */
  recordProposal(params: {
    leadSessionId: string;
    workerSessionId: string;
    workerId: string;
    rosterId: string;
    reason: string;
  }): Promise<TeammateProposalResult>;
  /** Owner decision from the strip. Confirm joins the target; dismiss drops it. */
  decideProposal(
    sessionId: string,
    proposalId: string,
    decision: 'confirm' | 'dismiss',
  ): Promise<{ ok: true }>;
}

/** Same ceiling as the mention flow (ADR 0011 §5): worker modes are binary. */
function assertLeadCanHost(lead: TeammateLeadSnapshot): void {
  if (lead.remoteHostId) {
    throwIpcError('PRECONDITION_FAILED', 'Teammates run on this computer only; this session is remote.');
  }
  if (lead.orcaRole === 'worker') {
    throwIpcError('PRECONDITION_FAILED', '[WORKER_CANNOT_NEST] a worker task cannot bring in teammates (depth 1, ADR 0005).');
  }
  if (lead.source === 'bot') {
    throwIpcError('PRECONDITION_FAILED', 'Bot sessions have their own companions; @agent: teammates are for ordinary tasks.');
  }
  const leadMode = lead.permissionMode ?? 'default';
  if (leadMode === 'auto') {
    throwIpcError('PRECONDITION_FAILED', 'Teammates run as Hermes workers, which have no Auto mode. Switch this session to Full access and confirm again.');
  }
  if (leadMode !== 'bypassPermissions') {
    throwIpcError('PRECONDITION_FAILED', 'Teammates need Full access: the permission ceiling is this session\'s current mode (' + leadMode + '). Switch this session to Full access and confirm again.');
  }
}

export function createTeammateProposalService(deps: TeammateProposalDeps): TeammateProposalService {
  const log = deps.log ?? { info: () => {}, warn: () => {} };

  function findRecordByWorker(leadSessionId: string, workerSessionId: string): SessionTeammateRecord | null {
    return deps.store.list(leadSessionId).find((r) => r.workerSessionId === workerSessionId) ?? null;
  }

  /** Best-effort note to the proposing worker; its own turn must not depend on it. */
  async function notifyProposer(leadSessionId: string, workerSessionId: string, message: string): Promise<void> {
    const sent = await deps.dispatchToWorker({
      callerLeadSessionId: leadSessionId,
      targetSessionId: workerSessionId,
      message,
    });
    if (!sent.ok) {
      log.warn('teammate proposal outcome note not delivered', {
        leadSessionId,
        workerSessionId,
        message: sent.message,
      });
    }
  }

  return {
    async canPropose({ leadSessionId, workerSessionId }) {
      const record = findRecordByWorker(leadSessionId, workerSessionId);
      return record !== null && record.mayPropose === true;
    },

    async recordProposal({ leadSessionId, workerSessionId, rosterId, reason }) {
      const record = findRecordByWorker(leadSessionId, workerSessionId);
      if (!record) {
        return { ok: false, message: 'Only a joined @agent: teammate can propose other teammates.' };
      }
      if (record.mayPropose !== true) {
        return { ok: false, message: 'Proposing teammates is not enabled for you. The owner can enable "May bring in others" on your teammate card in the session manifest strip.' };
      }
      if (!parseTeammateRosterId(rosterId)) {
        return { ok: false, message: 'Unknown teammate "' + rosterId + '". Use a roster id from the Agents page: expert:<slug> or imported:<source>:<file>.' };
      }
      if (deps.store.find(leadSessionId, rosterId)) {
        return { ok: false, message: '"' + rosterId + '" is already a teammate in this session.' };
      }
      const lead = await deps.getLeadSnapshot(leadSessionId);
      const entry = deps.resolveRosterEntry(rosterId, lead?.workingDir ?? null);
      if (!entry.ok) return { ok: false, message: entry.message };
      const trimmedReason = reason.trim();
      if (!trimmedReason) {
        return { ok: false, message: 'A proposal needs a reason the owner can read before confirming.' };
      }
      const proposalId = randomUUID();
      deps.store.addProposal(leadSessionId, {
        id: proposalId,
        rosterId,
        name: entry.name,
        reason: trimmedReason,
        proposedByRosterId: record.rosterId,
        proposedByName: record.name,
        proposedByWorkerSessionId: workerSessionId,
        createdAt: new Date().toISOString(),
      });
      deps.onTeammatesChanged?.(leadSessionId);
      log.info('teammate proposal recorded', { leadSessionId, rosterId, proposedBy: record.rosterId, proposalId });
      return { ok: true, proposalId };
    },

    async decideProposal(sessionId, proposalId, decision) {
      const proposal = deps.store.listProposals(sessionId).find((p) => p.id === proposalId) ?? null;
      if (!proposal) throwIpcError('NOT_FOUND', 'That proposal is no longer pending.');

      if (decision === 'dismiss') {
        deps.store.removeProposal(sessionId, proposalId);
        await notifyProposer(
          sessionId,
          proposal.proposedByWorkerSessionId,
          'The owner declined your proposal to bring in "' + proposal.name + '". Continue your own task and report via send_to_lead.',
        );
        deps.onTeammatesChanged?.(sessionId);
        log.info('teammate proposal dismissed', { leadSessionId: sessionId, proposalId, rosterId: proposal.rosterId });
        return { ok: true };
      }

      // Confirm: re-check everything at decision time — state may have changed since the propose.
      const lead = await deps.getLeadSnapshot(sessionId);
      if (!lead) throwIpcError('NOT_FOUND', 'Session does not exist');
      assertLeadCanHost(lead);
      if (deps.store.find(sessionId, proposal.rosterId)) {
        throwIpcError('PRECONDITION_FAILED', '"' + proposal.name + '" is already a teammate in this session; dismiss this proposal.');
      }
      const entry = deps.resolveRosterEntry(proposal.rosterId, lead.workingDir);
      if (!entry.ok) throwIpcError('INVALID_PARAMS', entry.message);

      const workerPermissionMode: OrcaWorkerPermissionMode = 'bypassPermissions';
      let team = await deps.getActiveTeam(sessionId);
      if (!team) {
        const started = await deps.startTeam(sessionId, workerPermissionMode);
        if (!started.ok) throwIpcError('PRECONDITION_FAILED', started.message);
        team = { id: started.teamId };
      }

      // The LEAD spawns the second worker (depth 1): the proposing worker never creates it.
      const created = await deps.createWorker({
        leadSessionId: sessionId,
        teamId: team.id,
        rosterId: proposal.rosterId,
        label: teammateLabelForRoster(proposal.rosterId),
        workerPermissionMode,
        ...(lead.workingDir ? { workingDir: lead.workingDir } : {}),
      });
      if (!created.ok) throwIpcError('PRECONDITION_FAILED', created.message);
      deps.store.join(sessionId, {
        rosterId: proposal.rosterId,
        name: entry.name,
        workerId: created.workerId,
        workerSessionId: created.workerSessionId,
        teamId: team.id,
        ...(entry.file ? { file: entry.file } : {}),
        joinedAt: new Date().toISOString(),
      });

      const question = proposal.reason
        + '\n\n(Proposed by teammate "' + proposal.proposedByName + '". The owner confirmed; you are a separate teammate on the same lead. Report to the lead with send_to_lead.)';
      const dispatchText = (await deps.buildJoinPrompt(sessionId, question)) ?? question;
      const dispatched = await deps.dispatchToWorker({
        callerLeadSessionId: sessionId,
        targetSessionId: created.workerSessionId,
        message: dispatchText,
      });
      if (!dispatched.ok) {
        // The teammate is joined and visible in the strip (the proposal was consumed by join);
        // the owner can mention it again to retry the task or remove it (12.3a dispatch edge).
        throwIpcError('PRECONDITION_FAILED', dispatched.message ?? 'teammate dispatch failed');
      }
      deps.store.removeProposal(sessionId, proposalId);
      await notifyProposer(
        sessionId,
        proposal.proposedByWorkerSessionId,
        'The owner confirmed your proposal: "' + proposal.name + '" has joined as a separate teammate on the same lead. Continue your own task; coordinate through the lead.',
      );
      deps.onTeammatesChanged?.(sessionId);
      log.info('teammate proposal confirmed', {
        leadSessionId: sessionId,
        proposalId,
        rosterId: proposal.rosterId,
        workerSessionId: created.workerSessionId,
      });
      return { ok: true };
    },
  };
}
