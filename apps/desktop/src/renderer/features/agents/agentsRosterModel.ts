/**
 * Agents page roster model (ROADMAP 12.2). Pure: experts + imported agents become one
 * list of rows with source/program/error badges; search and filter chips work on rows.
 */

import { isStarterExpert, type ExpertEntry } from '@cindy/maker-core/experts';
import type { ImportedAgent } from '@cindy/maker-core/imported-agents';

export type RosterSource = 'mine' | 'built-in' | 'claude-user' | 'claude-project' | 'qwen-user' | 'qwen-project';
export type RosterFilter = 'all' | 'mine' | 'claude-user' | 'claude-project' | 'qwen' | 'built-in';

export const ROSTER_FILTERS: ReadonlyArray<{ id: RosterFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'claude-user', label: 'Claude user' },
  { id: 'claude-project', label: 'Claude project' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'built-in', label: 'Built-in' },
];

export interface RosterRow {
  /** expert:<slug> or the imported id — one id space with the picker (12.1). */
  id: string;
  kind: 'expert' | 'imported';
  slug?: string;
  name: string;
  description: string;
  program: string;
  source: RosterSource;
  path: string;
  prompt: string;
  model?: string;
  error?: string;
  runsOn?: readonly string[];
  blockedTools?: readonly string[];
  maxConcurrent?: number;
}

export function buildRosterRows(
  experts: readonly ExpertEntry[],
  imported: readonly ImportedAgent[],
): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const entry of experts) {
    rows.push({
      id: `expert:${entry.slug}`,
      kind: 'expert',
      slug: entry.slug,
      name: entry.expert?.name ?? entry.slug,
      description: entry.expert?.description ?? '',
      program: entry.expert?.agent ?? 'unknown',
      source: isStarterExpert(entry.slug) ? 'built-in' : 'mine',
      path: `${entry.dir}/expert.md`,
      prompt: entry.expert?.prompt ?? '',
      ...(entry.expert?.model ? { model: entry.expert.model } : {}),
      ...(entry.expert?.maxConcurrent !== undefined ? { maxConcurrent: entry.expert.maxConcurrent } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    });
  }
  for (const agent of imported) {
    rows.push({
      id: agent.id,
      kind: 'imported',
      name: agent.name,
      description: agent.description,
      program: agent.runsOn.length > 0 ? agent.runsOn.join(' + ') : 'none',
      source: agent.source,
      path: agent.absolutePath,
      prompt: agent.prompt,
      runsOn: agent.runsOn,
      ...(agent.blockedTools ? { blockedTools: agent.blockedTools } : {}),
      ...(agent.error ? { error: agent.error } : {}),
    });
  }
  return rows;
}

function matchesFilter(row: RosterRow, filter: RosterFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'mine': return row.kind === 'expert';
    case 'built-in': return row.source === 'built-in';
    case 'qwen': return row.source === 'qwen-user' || row.source === 'qwen-project';
    default: return row.source === filter;
  }
}

export function filterRosterRows(
  rows: readonly RosterRow[],
  filter: RosterFilter,
  query: string,
): RosterRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesFilter(row, filter)) return false;
    if (!q) return true;
    return row.name.toLowerCase().includes(q)
      || row.description.toLowerCase().includes(q)
      || row.path.toLowerCase().includes(q);
  });
}
