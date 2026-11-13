/**
 * Teammate picker roster model (ROADMAP 12.3b). Pure mapping + ranking over the
 * Agents-page roster rows (12.2), plus the default IPC loader.
 *
 * Fail closed the same way the send boundary does: only Hermes-runnable entries are
 * pickable; broken or non-Hermes rows are listed with the reason, never silently hidden.
 * The authoritative check stays host-side (checkWorkerRosterEntry at join time).
 */

import type { RosterRow } from '@/features/agents/agentsRosterModel';
import { buildRosterRows } from '@/features/agents/agentsRosterModel';

export interface TeammatePickerCandidate {
  /** Canonical roster id — what the @agent: token carries. */
  id: string;
  name: string;
  description: string;
  /** Program badge: hermes, claude-code, ... */
  program: string;
  /** Source badge: mine, built-in, claude-user, ... */
  source: string;
  path: string;
  disabled: boolean;
  disabledReason?: string;
}

export function toTeammatePickerCandidate(row: RosterRow): TeammatePickerCandidate {
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    program: row.program,
    source: row.source,
    path: row.path,
  };
  if (row.error) {
    return { ...base, disabled: true, disabledReason: row.error };
  }
  if (row.kind === 'expert') {
    if (row.program !== 'hermes') {
      return {
        ...base,
        disabled: true,
        disabledReason: `Configured for ${row.program}; teammates run on Hermes.`,
      };
    }
    return { ...base, disabled: false };
  }
  if (!(row.runsOn ?? []).includes('hermes')) {
    const blocked = row.blockedTools?.length ? ` Tools that block it: ${row.blockedTools.join(', ')}.` : '';
    return { ...base, disabled: true, disabledReason: `Cannot run on hermes.${blocked}` };
  }
  return { ...base, disabled: false };
}

function score(candidate: TeammatePickerCandidate, term: string): number {
  if (!term) return 1;
  const name = candidate.name.toLowerCase();
  const id = candidate.id.toLowerCase();
  if (name === term) return 100;
  if (name.startsWith(term)) return 80;
  const boundary = new RegExp(`(?:^|[\\s/_-])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  if (boundary.test(candidate.name)) return 60;
  if (name.includes(term)) return 40;
  if (id.includes(term)) return 35;
  if (candidate.path.toLowerCase().includes(term)) return 20;
  return 0;
}

/** Best matches first; disabled rows stay listed (the owner sees why they cannot join). */
export function rankTeammateCandidates(
  candidates: readonly TeammatePickerCandidate[],
  term: string,
  limit: number,
): TeammatePickerCandidate[] {
  const normalized = term.trim().toLowerCase();
  return candidates
    .map((candidate) => ({ candidate, score: score(candidate, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Default loader: the same roster the Agents page shows, scoped to the draft's project dir. */
export async function loadTeammatePickerCandidates(projectDir: string | null): Promise<TeammatePickerCandidate[]> {
  const maker = window.electronAPI?.maker;
  if (!maker?.experts || !maker?.importedAgents) return [];
  const [experts, importedView] = await Promise.all([
    maker.experts.list(),
    maker.importedAgents.list(projectDir),
  ]);
  return buildRosterRows(experts, importedView.agents).map(toTeammatePickerCandidate);
}
