/**
 * Cindy conversation facts for storage housekeeping (ROADMAP 13.2c, ADR 0014).
 *
 * The housekeeping scan is synchronous and main-process-local; the Cindy database is reached
 * through an async worker transport. This module is the one async read that bridges them, so
 * `scanStorage` stays pure and testable.
 *
 * Protection here is pinned, scheduled, and a turn in flight or interrupted. "Running" also
 * comes from the daemon registry, and "open in a window" needs no separate channel: only
 * ORPHAN homes (no registry record at all) are ever removed whole, and a session open in the
 * UI always has a record. Interior bulk is re-creatable, so removing it cannot lose anything.
 */

import type { ConversationStatus } from '@cindy/maker-core/housekeeping';

import { tryGetDbClient } from '../localDb/client/current.js';
import type { ConversationFacts } from './housekeeping.js';

const STATUSES: ReadonlySet<string> = new Set(['active', 'archived', 'deleted']);

const FACTS_SQL = `
  SELECT s.sdk_session_id AS sdkSessionId,
         s.status AS status,
         s.pinned_at AS pinnedAt,
         s.active_turn_started_at AS activeTurnStartedAt,
         s.last_turn_ended_at AS lastTurnEndedAt,
         (SELECT count(*) FROM schedules sc
           WHERE sc.target_session_id = s.id AND sc.status = 'active') AS scheduled
    FROM sessions s
   WHERE s.sdk_session_id IS NOT NULL AND s.sdk_session_id <> ''
`;

interface FactRow {
  sdkSessionId: string;
  status: string | null;
  pinnedAt: number | null;
  activeTurnStartedAt: number | null;
  lastTurnEndedAt: number | null;
  scheduled: number | null;
}

/** A turn that started and never ended is either running or interrupted; both must be kept. */
export function isTurnInFlight(row: Pick<FactRow, 'activeTurnStartedAt' | 'lastTurnEndedAt'>): boolean {
  const started = row.activeTurnStartedAt;
  if (typeof started !== 'number' || !Number.isFinite(started)) return false;
  const ended = row.lastTurnEndedAt;
  return typeof ended !== 'number' || !Number.isFinite(ended) || started > ended;
}

export function factsFromRows(rows: readonly FactRow[]): ConversationFacts {
  const bySdkSessionId: Record<string, { status: ConversationStatus; protected: boolean }> = {};
  for (const row of rows) {
    if (!row || typeof row.sdkSessionId !== 'string' || !row.sdkSessionId) continue;
    const status = typeof row.status === 'string' && STATUSES.has(row.status) ? row.status : 'active';
    bySdkSessionId[row.sdkSessionId] = {
      status: status as ConversationStatus,
      protected: (row.pinnedAt != null) || (Number(row.scheduled) > 0) || isTurnInFlight(row),
    };
  }
  return { bySdkSessionId };
}

/**
 * Reads the join. An unavailable database yields an empty fact set, which is the safe answer:
 * with no status known, no whole home of a registered session is ever removed.
 */
export async function readConversationFacts(): Promise<ConversationFacts> {
  const db = tryGetDbClient();
  if (!db) return { bySdkSessionId: {} };
  const rows = await db.query<FactRow>(FACTS_SQL);
  return factsFromRows(rows);
}