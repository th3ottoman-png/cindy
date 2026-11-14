/**
 * Squads (ROADMAP 12.4b, ADR 0012): saved teams that launch a Hermes lead plus members as
 * Orca teammates through the unchanged 12.3 send boundary. A squad is a plain, human-editable
 * `~/.cindy-harness/squads/<slug>/squad.yaml` (AGENTS.md §6.1): a name, a lead roster id, member
 * roster ids, a worker permission ceiling and a turn cap. It stores roster ids, not a backend
 * binding, so the launch backend can change without touching the file (ADR 0012).
 *
 * Pure by design. No I/O, no clock, no network, no model call. Discovery, the atomic write and
 * the launch live in the desktop host (`maker-ipc/squads.ts`); this module is the parse/render
 * pair and the fail-closed launch plan behind them.
 *
 * Fail closed (blueprint §5/§9): a malformed file is listed with its error and never launched;
 * an unknown roster id refuses the whole launch; a permission ceiling below Full access refuses
 * (Hermes workers have no Auto mode and no mode at/below Default — ADR 0011 §5). Nothing here
 * silently escalates permissions or falls back to another program.
 */

import yaml from 'js-yaml';

import { parseTeammateRosterId, teammateBindingId } from '../session/teammate-mention.js';

/**
 * Orca worker permission modes are binary (apps/desktop `orca-worker-permission-mode.ts`).
 * Mirrored here so maker-core stays Electron-free; the host maps the plan's mode onto its own
 * type. Only `bypassPermissions` (Full access) can host Hermes workers (ADR 0011 §5).
 */
export const SQUAD_WORKER_PERMISSION_MODES = ['auto', 'bypassPermissions'] as const;
export type SquadWorkerPermissionMode = (typeof SQUAD_WORKER_PERMISSION_MODES)[number];
export const DEFAULT_SQUAD_WORKER_PERMISSION_MODE: SquadWorkerPermissionMode = 'bypassPermissions';

/** The 3.9 Hermes worker turn cap is the default; the owner may raise it for a long research lead. */
export const DEFAULT_SQUAD_MAX_TURNS = 40;
export const MAX_SQUAD_MAX_TURNS = 200;
/** A squad is a small saved team, not a roster dump; keeps the file and the launch bounded. */
export const MAX_SQUAD_MEMBERS = 12;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

export interface SquadDefinition {
  /** Directory name under the squads root; set by the store, optional in a parsed file. */
  slug?: string;
  name: string;
  description: string;
  /** Canonical roster id: `expert:<slug>` or `imported:<source>:<relPath>`. */
  lead: string;
  /** Member roster ids, in file order, distinct from each other and from the lead. */
  members: string[];
  workerPermissionMode: SquadWorkerPermissionMode;
  maxTurns: number;
}

export type SquadParseResult =
  | { ok: true; squad: SquadDefinition }
  | { ok: false; error: string };

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isPermissionMode(value: unknown): value is SquadWorkerPermissionMode {
  return typeof value === 'string' && (SQUAD_WORKER_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Parse `squad.yaml`. Unknown keys are ignored (kept on re-render by the store). A malformed
 * roster id, a missing name/lead, a non-positive turn cap or a bad permission mode is an error,
 * never a throw — the caller lists the squad with its error (blueprint §9.3).
 */
export function parseSquadYaml(text: string): SquadParseResult {
  let data: unknown;
  try {
    data = yaml.load(text);
  } catch (err) {
    return { ok: false, error: 'invalid YAML: ' + (err instanceof Error ? err.message : String(err)) };
  }
  if (data === null || data === undefined) return { ok: false, error: 'empty squad file' };
  if (typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'squad file must be a YAML mapping' };
  const fm = data as Record<string, unknown>;

  const name = asString(fm.name)?.trim() ?? '';
  if (!name) return { ok: false, error: 'missing "name"' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `"name" is longer than ${MAX_NAME_LENGTH} characters` };

  const description = asString(fm.description)?.trim() ?? '';
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `"description" is longer than ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  const lead = asString(fm.lead)?.trim() ?? '';
  if (!lead) return { ok: false, error: 'missing "lead" (a roster id from the Agents page)' };
  if (!parseTeammateRosterId(lead)) {
    return { ok: false, error: `"lead" is not a roster id: "${lead}" (use expert:<slug> or imported:<source>:<file>)` };
  }

  if (fm.members === undefined || fm.members === null) return { ok: false, error: 'missing "members" (a list of roster ids)' };
  if (!Array.isArray(fm.members)) return { ok: false, error: '"members" must be a list of roster ids' };
  if (fm.members.length === 0) return { ok: false, error: '"members" is empty; a squad needs at least one member' };
  if (fm.members.length > MAX_SQUAD_MEMBERS) return { ok: false, error: `"members" has more than ${MAX_SQUAD_MEMBERS} entries` };
  const members: string[] = [];
  for (const raw of fm.members) {
    const id = asString(raw)?.trim() ?? '';
    if (!id || !parseTeammateRosterId(id)) {
      return { ok: false, error: `member "${String(raw)}" is not a roster id (use expert:<slug> or imported:<source>:<file>)` };
    }
    if (id === lead) return { ok: false, error: `the lead "${id}" cannot also be a member` };
    if (members.includes(id)) return { ok: false, error: `duplicate member "${id}"` };
    members.push(id);
  }

  let workerPermissionMode: SquadWorkerPermissionMode = DEFAULT_SQUAD_WORKER_PERMISSION_MODE;
  if (fm.worker_permission_mode !== undefined && fm.worker_permission_mode !== null) {
    if (!isPermissionMode(fm.worker_permission_mode)) {
      return { ok: false, error: `"worker_permission_mode" must be one of ${SQUAD_WORKER_PERMISSION_MODES.join(' | ')}` };
    }
    workerPermissionMode = fm.worker_permission_mode;
  }

  let maxTurns = DEFAULT_SQUAD_MAX_TURNS;
  if (fm.max_turns !== undefined && fm.max_turns !== null) {
    if (typeof fm.max_turns !== 'number' || !Number.isInteger(fm.max_turns) || fm.max_turns < 1 || fm.max_turns > MAX_SQUAD_MAX_TURNS) {
      return { ok: false, error: `"max_turns" must be an integer between 1 and ${MAX_SQUAD_MAX_TURNS}` };
    }
    maxTurns = fm.max_turns;
  }

  return { ok: true, squad: { name, description, lead, members, workerPermissionMode, maxTurns } };
}

/**
 * Render a squad as `squad.yaml`. With `baseYaml`, every key the form does not own survives
 * (same convention as the expert form); without it, a fresh file gets only the owned keys.
 * One line per field so the owner can hand-edit it.
 */
export function renderSquadYaml(squad: SquadDefinition, baseYaml?: string): string {
  let data: Record<string, unknown> = {};
  if (baseYaml) {
    try {
      const parsed = yaml.load(baseYaml);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = { ...(parsed as Record<string, unknown>) };
    } catch {
      // A corrupt base contributes nothing; the owned keys are still written.
    }
  }
  data.name = squad.name;
  data.description = squad.description;
  data.lead = squad.lead;
  data.members = [...squad.members];
  data.worker_permission_mode = squad.workerPermissionMode;
  data.max_turns = squad.maxTurns;
  return yaml.dump(data, { lineWidth: -1, noRefs: true, sortKeys: false });
}

/** Lowercase kebab-case directory slug, same rule as the expert form (3.8). */
export function squadSlugFromName(value: string): string {
  const slug = value.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  const cleaned = slug.replace(/^[^a-z0-9]+/, '');
  return cleaned.length >= 2 ? cleaned : `squad-${cleaned}`.slice(0, 64);
}

export interface SquadLaunchMember {
  rosterId: string;
  /** The binding form the expert store keeps (bare expert slug or full imported id). */
  bindingId: string;
}

export interface SquadLaunchPlan {
  leadRosterId: string;
  leadBindingId: string;
  members: SquadLaunchMember[];
  workerPermissionMode: SquadWorkerPermissionMode;
  maxTurns: number;
  /** Prefilled into the new lead session's composer; sending it joins the members (12.3). */
  kickoffMessage: string;
}

export type SquadLaunchPlanResult =
  | { ok: true; plan: SquadLaunchPlan }
  | { ok: false; errors: string[] };

/**
 * The kickoff message: every member as a visible `@agent:` token, then the owner's task (or a
 * minimal assembly note when none was given). Sending it through the unchanged 12.3 send
 * boundary joins each member as an Orca worker and dispatches the task; the lead keeps the
 * stripped task plus the visible dispatch note.
 */
export function renderSquadKickoff(memberRosterIds: readonly string[], task: string): string {
  const tokens = memberRosterIds.map((id) => `@agent:${id}`).join(' ');
  const trimmed = task.trim();
  const body = trimmed || 'You are assembled as a squad. Acknowledge briefly and wait for the owner\'s task.';
  return `${tokens}\n\n${body}`;
}

/**
 * Build the launch plan, fail closed. Every roster id (lead + members) must be present in
 * `availableRosterIds`; an unknown id is named in the errors and nothing launches. The
 * permission ceiling must be Full access — Hermes workers have no Auto mode and no mode at or
 * below Default (ADR 0011 §5), so a lower ceiling refuses rather than silently escalating.
 */
export function buildSquadLaunchPlan(
  squad: SquadDefinition,
  availableRosterIds: readonly string[],
  task = '',
): SquadLaunchPlanResult {
  const available = new Set(availableRosterIds);
  const errors: string[] = [];

  if (!available.has(squad.lead)) errors.push(`lead "${squad.lead}" is not in the roster`);
  for (const id of squad.members) {
    if (!available.has(id)) errors.push(`member "${id}" is not in the roster`);
  }
  if (squad.workerPermissionMode !== 'bypassPermissions') {
    errors.push(
      'worker_permission_mode "' + squad.workerPermissionMode + '" cannot host Hermes workers: they run only in Full access (bypassPermissions). Set worker_permission_mode: bypassPermissions (ADR 0011 §5).',
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      leadRosterId: squad.lead,
      leadBindingId: teammateBindingId(squad.lead),
      members: squad.members.map((rosterId) => ({ rosterId, bindingId: teammateBindingId(rosterId) })),
      workerPermissionMode: squad.workerPermissionMode,
      maxTurns: squad.maxTurns,
      kickoffMessage: renderSquadKickoff(squad.members, task),
    },
  };
}
