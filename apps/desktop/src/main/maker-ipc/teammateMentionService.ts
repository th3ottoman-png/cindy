/**
 * @-mention teammate dispatch (ROADMAP 12.3, ADR 0011).
 *
 * Runs at the SEND boundary, before the lead's turn: parses `@agent:<roster-id>` tokens,
 * starts or reuses one Orca worker per roster entry (Hermes workers only, depth 1, permission
 * ceiling = the lead's mode), dispatches the message — with a 3.6 handoff excerpt on the join
 * — and rewrites the lead's message to the stripped text plus a visible dispatch note.
 *
 * Fail closed: a malformed token, an unloadable roster entry, a lead below Full access, or a
 * failed creation/dispatch refuses the whole send with a message saying what to fix. Nothing
 * here switches a model or writes outside the teammate registry and the proven Orca paths.
 */

import {
  findInvalidTeammateMentions,
  parseTeammateMentions,
  renderTeammateDispatchNote,
  stripTeammateMentions,
} from '@cindy/maker-core/teammate-mention';

import { throwIpcError } from '../utils/ipcValidate.js';
import type { OrcaWorkerPermissionMode } from '../../shared/orca-worker-permission-mode.js';
import type { SessionTeammateRecord, SessionTeammatesStore } from './sessionTeammates.js';

export interface TeammateLeadSnapshot {
  agentKind: string;
  workingDir: string | null;
  permissionMode: string | null;
  orcaRole: string | null;
  remoteHostId: string | null;
  source: string | null;
}

export type TeammateRosterResolution =
  | { ok: true; name: string; file?: string; model?: string }
  | { ok: false; message: string };

export interface TeammateWorkerCreation {
  leadSessionId: string;
  teamId: string;
  rosterId: string;
  label: string;
  workerPermissionMode: OrcaWorkerPermissionMode;
  workingDir?: string;
}

export interface TeammateMentionDeps {
  getLeadSnapshot(sessionId: string): Promise<TeammateLeadSnapshot | null>;
  /** Fail-closed roster check: loadable, Hermes-runnable, under its concurrency cap. */
  resolveRosterEntry(rosterId: string, projectDir: string | null): TeammateRosterResolution;
  getActiveTeam(leadSessionId: string): Promise<{ id: string } | null>;
  startTeam(
    leadSessionId: string,
    workerPermissionMode: OrcaWorkerPermissionMode,
  ): Promise<{ ok: true; teamId: string } | { ok: false; message: string }>;
  listWorkers(
    leadSessionId: string,
  ): Promise<Array<{ id: string; sessionId: string; label: string | null; status: string }>>;
  createWorker(
    params: TeammateWorkerCreation,
  ): Promise<{ ok: true; workerId: string; workerSessionId: string } | { ok: false; message: string }>;
  dispatchToWorker(params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
  }): Promise<{ ok: boolean; message?: string }>;
  /** The 3.6 join prompt (question + bounded excerpt); null when there is nothing to excerpt. */
  buildJoinPrompt(leadSessionId: string, question: string): Promise<string | null>;
  store: SessionTeammatesStore;
  /** False for device-link / remote-controlled sends: the token is a desktop-composer feature. */
  isTeammateSendAllowed(): boolean;
  /** Notified after a teammate joins, so the manifest strip can refresh. */
  onTeammatesChanged?: (leadSessionId: string) => void;
  log?: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

export interface TeammateMentionService {
  /**
   * Returns the rewritten lead message (same wire shape) when teammates were dispatched, or
   * null when the message carries no teammate mention (the caller sends the original untouched).
   */
  applyTeammateMentions(sessionId: string, message: unknown, sendOpts?: unknown): Promise<unknown | null>;
}

/**
 * Wire shapes at the send boundary: plain string (legacy maker:send), the composer's
 * `{text, images, files, ...}`, and the coordinator's `{type:'user', content}` where content
 * is a string or SDK content blocks. Only the first text block carries composer prose.
 */
function readMentionText(message: unknown): string | null {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>;
    if (typeof m.text === 'string') return m.text;
    if (m.type === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const block = m.content.find(
          (b): b is { type: string; text: string } =>
            !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
        );
        return block ? block.text : null;
      }
    }
  }
  return null;
}

function withRewrittenText(message: unknown, rewritten: string): unknown {
  if (typeof message === 'string') return rewritten;
  const m = message as Record<string, unknown>;
  if (typeof m.text === 'string') return { ...m, text: rewritten };
  if (m.type === 'user' && Array.isArray(m.content)) {
    let replaced = false;
    const content = m.content.map((b) => {
      if (!replaced && !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
        replaced = true;
        return { ...(b as object), text: rewritten };
      }
      return b;
    });
    return { ...m, content };
  }
  return { ...m, content: rewritten };
}

/** The worker label: the expert slug or the imported file stem (team-unique, human-readable). */
export function teammateLabelForRoster(rosterId: string): string {
  if (rosterId.startsWith('expert:')) return rosterId.slice('expert:'.length);
  const relPath = rosterId.split(':').slice(2).join(':');
  const stem = relPath.split('/').pop() ?? relPath;
  return stem.replace(/\.md$/i, '') || 'teammate';
}

export function createTeammateMentionService(deps: TeammateMentionDeps): TeammateMentionService {
  const log = deps.log ?? { info: () => {}, warn: () => {} };

  return {
    async applyTeammateMentions(sessionId, message, sendOpts) {
      // Auto-resume replays an already-dispatched item; it must not dispatch a second time.
      // Orca inter-agent messages (e.g. a join prompt whose excerpt quotes an earlier mention)
      // are never owner input: they must pass through without re-triggering the flow.
      if (sendOpts && typeof sendOpts === 'object') {
        const o = sendOpts as Record<string, unknown>;
        const persist = o.persistUserMessage as Record<string, unknown> | undefined;
        if (o.autoResume === true || persist?.autoResume === true) return null;
        const origin = persist?.origin as { kind?: unknown } | undefined;
        if (origin?.kind === 'orca') return null;
      }
      const text = readMentionText(message);
      if (text === null || !text.includes('@agent:')) return null;

      const invalid = findInvalidTeammateMentions(text);
      if (invalid.length > 0) {
        throwIpcError(
          'INVALID_PARAMS',
          'Unknown teammate ' + invalid.join(', ') + '. Use a roster id from the Agents page: @agent:expert:<slug> or @agent:imported:<source>:<file>. Nothing was sent.',
        );
      }
      const tokens = parseTeammateMentions(text);
      if (tokens.length === 0) return null;

      if (!deps.isTeammateSendAllowed()) {
        throwIpcError('PRECONDITION_FAILED', 'Teammate mentions are only available from this computer\'s composer. Nothing was sent.');
      }

      const lead = await deps.getLeadSnapshot(sessionId);
      if (!lead) throwIpcError('NOT_FOUND', 'Session does not exist');
      if (lead.remoteHostId) {
        throwIpcError('PRECONDITION_FAILED', 'Teammates run on this computer only; this session is remote. Nothing was sent.');
      }
      if (lead.orcaRole === 'worker') {
        throwIpcError('PRECONDITION_FAILED', '[WORKER_CANNOT_NEST] a worker task cannot bring in teammates (depth 1, ADR 0005). Nothing was sent.');
      }
      if (lead.source === 'bot') {
        throwIpcError('PRECONDITION_FAILED', 'Bot sessions have their own companions; @agent: teammates are for ordinary tasks. Nothing was sent.');
      }

      // Permission ceiling (ADR 0011 §5): worker modes are binary, so only a Full-access lead
      // can host teammates without escalation; Auto has no Hermes equivalent.
      const leadMode = lead.permissionMode ?? 'default';
      if (leadMode === 'auto') {
        throwIpcError('PRECONDITION_FAILED', 'Teammates run as Hermes workers, which have no Auto mode. Switch this session to Full access and mention again. Nothing was sent.');
      }
      if (leadMode !== 'bypassPermissions') {
        throwIpcError('PRECONDITION_FAILED', 'Teammates need Full access: Orca workers run only in Auto or Full access, and the permission ceiling is this session\'s current mode (' + leadMode + '). Switch this session to Full access and mention again. Nothing was sent.');
      }
      const workerPermissionMode: OrcaWorkerPermissionMode = 'bypassPermissions';

      const question = stripTeammateMentions(text);
      const rosterIds = [...new Set(tokens.map((token) => token.ref.rosterId))];

      // Resolve every entry before any team, slot or session exists (fail closed).
      const resolved = new Map<string, Extract<TeammateRosterResolution, { ok: true }>>();
      for (const rosterId of rosterIds) {
        const entry = deps.resolveRosterEntry(rosterId, lead.workingDir);
        if (!entry.ok) throwIpcError('INVALID_PARAMS', entry.message + ' Nothing was sent.');
        resolved.set(rosterId, entry);
      }

      let team = await deps.getActiveTeam(sessionId);
      if (!team) {
        const started = await deps.startTeam(sessionId, workerPermissionMode);
        if (!started.ok) throwIpcError('PRECONDITION_FAILED', started.message + ' Nothing was sent.');
        team = { id: started.teamId };
      }

      const liveWorkers = await deps.listWorkers(sessionId);
      const joinedNames: string[] = [];
      for (const rosterId of rosterIds) {
        const entry = resolved.get(rosterId)!;
        const existing = deps.store.find(sessionId, rosterId);
        const stillLive = existing !== null && liveWorkers.some((worker) => worker.id === existing.workerId);

        let workerSessionId: string;
        let firstJoin: boolean;
        if (existing && stillLive) {
          workerSessionId = existing.workerSessionId;
          firstJoin = false;
        } else {
          const created = await deps.createWorker({
            leadSessionId: sessionId,
            teamId: team.id,
            rosterId,
            label: teammateLabelForRoster(rosterId),
            workerPermissionMode,
            ...(lead.workingDir ? { workingDir: lead.workingDir } : {}),
          });
          if (!created.ok) throwIpcError('PRECONDITION_FAILED', created.message + ' Nothing was sent.');
          workerSessionId = created.workerSessionId;
          firstJoin = true;
          const record: SessionTeammateRecord = {
            rosterId,
            name: entry.name,
            workerId: created.workerId,
            workerSessionId,
            teamId: team.id,
            ...(entry.file ? { file: entry.file } : {}),
            joinedAt: new Date().toISOString(),
          };
          deps.store.join(sessionId, record);
          deps.onTeammatesChanged?.(sessionId);
        }

        // The excerpt rides only the join (3.6): a reused worker keeps its own history.
        const dispatchText = firstJoin ? ((await deps.buildJoinPrompt(sessionId, question)) ?? question) : question;
        const dispatched = await deps.dispatchToWorker({
          callerLeadSessionId: sessionId,
          targetSessionId: workerSessionId,
          message: dispatchText,
        });
        if (!dispatched.ok) {
          throwIpcError('PRECONDITION_FAILED', (dispatched.message ?? 'teammate dispatch failed') + ' Nothing was sent.');
        }
        joinedNames.push(entry.name);
        log.info('teammate mention dispatched', { leadSessionId: sessionId, rosterId, workerSessionId, firstJoin });
      }

      const note = renderTeammateDispatchNote(joinedNames);
      const rewritten = question ? question + '\n\n' + note : note;
      return withRewrittenText(message, rewritten);
    },
  };
}
