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
}

interface TeammatesFile {
  version: 1;
  leads: Record<string, SessionTeammateRecord[]>;
}

/** IPC view: joined teammates with the worker's live status ('gone' when no longer in the team). */
export interface SessionTeammatesView {
  teammates: Array<SessionTeammateRecord & { status: string }>;
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
    (r.file === undefined || typeof r.file === 'string')
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
        return { version: 1, leads };
      }
    } catch {
      // Missing or unreadable file: no teammates.
    }
    return { version: 1, leads: {} };
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
      writeFile(data);
    },
    remove(leadSessionId, rosterId) {
      const data = readFile();
      const existing = data.leads[leadSessionId] ?? [];
      const next = existing.filter((r) => r.rosterId !== rosterId);
      if (next.length === existing.length) return false;
      if (next.length > 0) data.leads[leadSessionId] = next;
      else delete data.leads[leadSessionId];
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
      writeFile(data);
      return found;
    },
  };
}
