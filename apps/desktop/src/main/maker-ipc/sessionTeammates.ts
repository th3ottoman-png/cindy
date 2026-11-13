/**
 * Joined teammates per lead session (ROADMAP 12.3, ADR 0011).
 *
 * A teammate is one Orca worker bound to one roster entry. This registry remembers which
 * worker belongs to which `@agent:` mention so a later mention reuses the same worker, and
 * the manifest strip can list and remove joined teammates. File-backed and human-editable
 * (AGENTS.md §6.1): `~/.cindy-harness/session-teammates.json`, atomic temp+rename, 0600 —
 * the same pattern as expert-sessions.json. A corrupt file yields an empty registry, never
 * a crash; the worker's live state is always re-checked against the team before reuse.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseTeammateRosterId } from '@cindy/maker-core/teammate-mention';

export interface SessionTeammateRecord {
  /** Canonical roster id: `expert:<slug>` or `imported:<source>:<relPath>`. */
  rosterId: string;
  name: string;
  workerId: string;
  workerSessionId: string;
  teamId: string;
  /** Definition file (expert.md or the imported .md), for manifest provenance. */
  file?: string;
  joinedAt: string;
  /**
   * ROADMAP 12.3b (ADR 0011 §4): opt-in "may bring in others". Absent/false = the worker's
   * propose_teammate tool refuses (fail closed). True = it may propose; the owner confirms.
   */
  mayPropose?: boolean;
}

/**
 * ROADMAP 12.3b: a teammate's proposal to bring in another roster entry. Propose-only —
 * nothing joins until the owner confirms from the manifest strip. One pending proposal
 * per target roster id; a newer proposal replaces the older.
 */
export interface SessionTeammateProposal {
  id: string;
  /** The proposed target's canonical roster id. */
  rosterId: string;
  name: string;
  /** Why the teammate wants help; the owner reads this before confirming. */
  reason: string;
  proposedByRosterId: string;
  proposedByName: string;
  proposedByWorkerSessionId: string;
  createdAt: string;
}

interface TeammatesFile {
  version: 1;
  leads: Record<string, SessionTeammateRecord[]>;
  proposals?: Record<string, SessionTeammateProposal[]>;
}

/** IPC view: joined teammates with the worker's live status ('gone' when no longer in the team). */
export interface SessionTeammatesView {
  teammates: Array<SessionTeammateRecord & { status: string }>;
  /** ROADMAP 12.3b: pending proposals awaiting the owner's confirm/dismiss. */
  proposals: SessionTeammateProposal[];
}

export interface SessionTeammatesStoreOptions {
  /** Production: ~/.cindy-harness/session-teammates.json. */
  file: string;
  now?: () => number;
}

export interface SessionTeammatesStore {
  list(leadSessionId: string): SessionTeammateRecord[];
  find(leadSessionId: string, rosterId: string): SessionTeammateRecord | null;
  /** One worker per teammate: joining the same roster id replaces its record. */
  join(leadSessionId: string, record: SessionTeammateRecord): void;
  remove(leadSessionId: string, rosterId: string): boolean;
  removeByWorkerSession(leadSessionId: string, workerSessionId: string): SessionTeammateRecord | null;
  /** ROADMAP 12.3b: opt-in "may bring in others"; false when the teammate is not joined. */
  setMayPropose(leadSessionId: string, rosterId: string, enabled: boolean): boolean;
  listProposals(leadSessionId: string): SessionTeammateProposal[];
  /** One pending proposal per target roster id: a newer proposal replaces the older. */
  addProposal(leadSessionId: string, proposal: SessionTeammateProposal): void;
  removeProposal(leadSessionId: string, proposalId: string): boolean;
}

function isRecord(value: unknown): value is SessionTeammateRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.rosterId === 'string' &&
    parseTeammateRosterId(r.rosterId) !== null &&
    typeof r.name === 'string' &&
    typeof r.workerId === 'string' &&
    typeof r.workerSessionId === 'string' &&
    typeof r.teamId === 'string' &&
    typeof r.joinedAt === 'string' &&
    (r.file === undefined || typeof r.file === 'string') &&
    (r.mayPropose === undefined || typeof r.mayPropose === 'boolean')
  );
}

function isProposal(value: unknown): value is SessionTeammateProposal {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' && p.id.length > 0 &&
    typeof p.rosterId === 'string' &&
    parseTeammateRosterId(p.rosterId) !== null &&
    typeof p.name === 'string' &&
    typeof p.reason === 'string' &&
    typeof p.proposedByRosterId === 'string' &&
    typeof p.proposedByName === 'string' &&
    typeof p.proposedByWorkerSessionId === 'string' &&
    typeof p.createdAt === 'string'
  );
}

export function createSessionTeammatesStore(opts: SessionTeammatesStoreOptions): SessionTeammatesStore {
  const now = opts.now ?? Date.now;

  function readFile(): TeammatesFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as Partial<TeammatesFile>;
      if (parsed && typeof parsed.leads === 'object' && parsed.leads !== null) {
        const leads: Record<string, SessionTeammateRecord[]> = {};
        for (const [leadSessionId, records] of Object.entries(parsed.leads)) {
          if (!Array.isArray(records)) continue;
          const valid = records.filter(isRecord);
          if (valid.length > 0) leads[leadSessionId] = valid;
        }
        const proposals: Record<string, SessionTeammateProposal[]> = {};
        if (parsed.proposals && typeof parsed.proposals === 'object') {
          for (const [leadSessionId, records] of Object.entries(parsed.proposals)) {
            if (!Array.isArray(records)) continue;
            const valid = records.filter(isProposal);
            if (valid.length > 0) proposals[leadSessionId] = valid;
          }
        }
        return { version: 1, leads, proposals };
      }
    } catch {
      // Missing or unreadable file: no teammates.
    }
    return { version: 1, leads: {}, proposals: {} };
  }

  /** Drop pending proposals that no longer make sense after a roster change. */
  function pruneProposals(
    data: TeammatesFile,
    leadSessionId: string,
    keep: (proposal: SessionTeammateProposal) => boolean,
  ): void {
    const existing = data.proposals?.[leadSessionId];
    if (!existing) return;
    const next = existing.filter(keep);
    if (next.length > 0) data.proposals![leadSessionId] = next;
    else delete data.proposals![leadSessionId];
  }

  function writeFile(data: TeammatesFile): void {
    const dir = path.dirname(opts.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(opts.file) + '.' + process.pid + '.' + now() + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, opts.file);
  }

  return {
    list(leadSessionId) {
      return readFile().leads[leadSessionId] ?? [];
    },
    find(leadSessionId, rosterId) {
      return readFile().leads[leadSessionId]?.find((r) => r.rosterId === rosterId) ?? null;
    },
    join(leadSessionId, record) {
      if (!parseTeammateRosterId(record.rosterId)) {
        throw new Error('invalid teammate roster id "' + record.rosterId + '"');
      }
      const data = readFile();
      const existing = data.leads[leadSessionId] ?? [];
      data.leads[leadSessionId] = [...existing.filter((r) => r.rosterId !== record.rosterId), record];
      // The target is joined now; a pending proposal for it is moot.
      pruneProposals(data, leadSessionId, (p) => p.rosterId !== record.rosterId);
      writeFile(data);
    },
    remove(leadSessionId, rosterId) {
      const data = readFile();
      const existing = data.leads[leadSessionId] ?? [];
      const found = existing.find((r) => r.rosterId === rosterId) ?? null;
      if (!found) return false;
      const next = existing.filter((r) => r.rosterId !== rosterId);
      if (next.length > 0) data.leads[leadSessionId] = next;
      else delete data.leads[leadSessionId];
      // A removed teammate can no longer stand behind its proposals.
      pruneProposals(data, leadSessionId, (p) => p.proposedByWorkerSessionId !== found.workerSessionId);
      writeFile(data);
      return true;
    },
    removeByWorkerSession(leadSessionId, workerSessionId) {
      const data = readFile();
      const existing = data.leads[leadSessionId] ?? [];
      const found = existing.find((r) => r.workerSessionId === workerSessionId) ?? null;
      if (!found) return null;
      const next = existing.filter((r) => r.workerSessionId !== workerSessionId);
      if (next.length > 0) data.leads[leadSessionId] = next;
      else delete data.leads[leadSessionId];
      pruneProposals(data, leadSessionId, (p) => p.proposedByWorkerSessionId !== workerSessionId);
      writeFile(data);
      return found;
    },
    setMayPropose(leadSessionId, rosterId, enabled) {
      const data = readFile();
      const existing = data.leads[leadSessionId] ?? [];
      const found = existing.find((r) => r.rosterId === rosterId) ?? null;
      if (!found) return false;
      data.leads[leadSessionId] = existing.map((r) =>
        r.rosterId === rosterId ? { ...r, mayPropose: enabled } : r,
      );
      writeFile(data);
      return true;
    },
    listProposals(leadSessionId) {
      return readFile().proposals?.[leadSessionId] ?? [];
    },
    addProposal(leadSessionId, proposal) {
      if (!parseTeammateRosterId(proposal.rosterId)) {
        throw new Error('invalid proposal roster id "' + proposal.rosterId + '"');
      }
      const data = readFile();
      data.proposals ??= {};
      const existing = data.proposals[leadSessionId] ?? [];
      data.proposals[leadSessionId] = [...existing.filter((p) => p.rosterId !== proposal.rosterId), proposal];
      writeFile(data);
    },
    removeProposal(leadSessionId, proposalId) {
      const data = readFile();
      const existing = data.proposals?.[leadSessionId] ?? [];
      const next = existing.filter((p) => p.id !== proposalId);
      if (next.length === existing.length) return false;
      if (next.length > 0) data.proposals![leadSessionId] = next;
      else delete data.proposals![leadSessionId];
      writeFile(data);
      return true;
    },
  };
}
