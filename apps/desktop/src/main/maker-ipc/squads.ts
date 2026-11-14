/**
 * Squads (ROADMAP 12.4b, ADR 0012): file-backed saved teams under
 * `~/.cindy-harness/squads/<slug>/squad.yaml`. Discovery, the atomic write and the fail-closed
 * launch plan live here; the parse/render pair and the plan are pure in
 * `@cindy/maker-core/squads`. A squad launches a Hermes lead plus members as Orca teammates
 * through the unchanged 12.3 send boundary — no bot-group code (ADR 0012).
 *
 * Invalid files are listed with their error, never thrown (blueprint §9.3). The launch refuses
 * unknown roster ids and any entry that cannot run on Hermes (the same fail-closed check 12.3
 * applies at send). Nothing here writes outside the squads root or starts a session: the renderer
 * prefills a new lead-session draft from the plan and the owner sends it (the 3.6b handoff pattern).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildSquadLaunchPlan,
  parseSquadYaml,
  renderSquadYaml,
  squadSlugFromName,
  type SquadDefinition,
  type SquadLaunchPlan,
} from '@cindy/maker-core/squads';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import { isValidExpertSlug } from './expertSessions.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** A squad is a small saved team; the directory browser stays bounded (same spirit as 12.1). */
export const SQUADS_DIR_CAP = 200;

export interface SquadView {
  slug: string;
  name: string;
  description: string;
  lead: string;
  members: string[];
  workerPermissionMode: string;
  maxTurns: number;
  file: string;
  /** Malformed file → listed with the error, never launched. */
  error?: string;
}

export interface SquadsDiscovery {
  squads: SquadView[];
  capped: boolean;
}

function realPathInside(parentRealPath: string, candidate: string): boolean {
  try {
    const rel = path.relative(parentRealPath, fs.realpathSync(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function visibleEntry(name: string): boolean {
  return !name.startsWith('.') && !/\.bak\.\d+$/.test(name);
}

/** Read one squad directory's squad.yaml into a view; a malformed file keeps its error. */
function readSquadDir(squadsRootReal: string, slug: string): SquadView | null {
  const dir = path.join(squadsRootReal, slug);
  const file = path.join(dir, 'squad.yaml');
  if (!realPathInside(squadsRootReal, dir)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no squad.yaml in this directory: not a squad
  }
  const parsed = parseSquadYaml(raw);
  if (!parsed.ok) {
    return { slug, name: slug, description: '', lead: '', members: [], workerPermissionMode: '', maxTurns: 0, file, error: parsed.error };
  }
  return { slug, ...parsed.squad, file };
}

/** Discover every `<slug>/squad.yaml` at depth 1, skipping dot-dirs and symlink escapes. */
export function discoverSquads(squadsRoot: string, maxDirs = SQUADS_DIR_CAP): SquadsDiscovery {
  const squads: SquadView[] = [];
  let capped = false;
  let rootReal: string;
  let entries: fs.Dirent[];
  try {
    rootReal = fs.realpathSync(squadsRoot);
    entries = fs.readdirSync(squadsRoot, { withFileTypes: true });
  } catch {
    return { squads, capped };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (squads.length >= maxDirs) {
      capped = true;
      break;
    }
    if (!visibleEntry(ent.name) || !isValidExpertSlug(ent.name)) continue;
    const abs = path.join(squadsRoot, ent.name);
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir || !realPathInside(rootReal, abs)) continue;
    const view = readSquadDir(rootReal, ent.name);
    if (view) squads.push(view);
  }
  return { squads, capped };
}

export interface SquadsWatcher {
  close(): void;
}

/** Debounced change notification; a missing root is simply not watched. */
export function watchSquads(squadsRoot: string, onChange: () => void, debounceMs = 150): SquadsWatcher {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!closed) onChange();
    }, debounceMs);
  };
  try {
    if (fs.existsSync(squadsRoot)) {
      watcher = fs.watch(squadsRoot, { recursive: true }, fire);
      watcher.on('error', () => undefined);
    }
  } catch {
    // Watching is a convenience; the list still loads on demand.
  }
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

/** Atomic temp+rename inside the squad directory (AGENTS.md §6.1, same pattern as the registry). */
function writeSquadFileAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.squad.yaml.' + process.pid + '.' + Date.now() + '.tmp');
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type SquadSaveResult =
  | { ok: true; slug: string; file: string }
  | { ok: false; reason: 'invalid' | 'exists' | 'not-found'; message: string };

export type SquadLaunchResult =
  | { ok: true; plan: SquadLaunchPlan; leadName: string; members: Array<{ rosterId: string; name: string }> }
  | { ok: false; errors: string[] };

export interface RosterEntryResolution {
  ok: boolean;
  name?: string;
  message?: string;
}

export interface SquadsHandlerDeps {
  /** Production: ~/.cindy-harness/squads. */
  squadsRoot: string;
  assertTrusted(event: unknown): void;
  broadcast(channel: string, payload: unknown): void;
  /** The full Agents-page roster id space (experts + imported), for the fail-closed plan check. */
  listRosterIds(projectDir: string | null): readonly string[];
  /** The 12.3 fail-closed check: loadable, Hermes-runnable, under its concurrency cap. */
  resolveRosterEntry(rosterId: string, projectDir: string | null): RosterEntryResolution;
  /** Injected so tests need no native fs.watch (threads-pool SIGSEGV, ROADMAP Debt). */
  watch?: typeof watchSquads;
}

export interface SquadsHandlerHandle {
  dispose(): void;
}

function projectDirArg(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Coerce form fields into a candidate definition; parseSquadYaml is the real validation gate. */
function fieldsToDefinition(fields: unknown): SquadDefinition {
  const f = (fields && typeof fields === 'object' ? fields : {}) as Record<string, unknown>;
  const members = Array.isArray(f.members) ? f.members.map((m) => str(m)) : [];
  return {
    name: str(f.name),
    description: str(f.description),
    lead: str(f.lead),
    members,
    workerPermissionMode: (f.workerPermissionMode === 'auto' ? 'auto' : 'bypassPermissions'),
    maxTurns: typeof f.maxTurns === 'number' ? f.maxTurns : Number.NaN,
  };
}

export function registerSquadsHandlers(registry: IpcHandlerRegistry, deps: SquadsHandlerDeps): SquadsHandlerHandle {
  let watcher: SquadsWatcher | undefined;

  const arm = (): void => {
    watcher?.close();
    watcher = (deps.watch ?? watchSquads)(deps.squadsRoot, () => {
      deps.broadcast(MAKER_PUSH.SQUADS_CHANGED, discoverSquads(deps.squadsRoot));
    });
  };

  const pushFresh = (): void => {
    deps.broadcast(MAKER_PUSH.SQUADS_CHANGED, discoverSquads(deps.squadsRoot));
  };

  registry.handle(MAKER_INVOKE.SQUADS_LIST, (event) => {
    deps.assertTrusted(event);
    if (!watcher) arm();
    return discoverSquads(deps.squadsRoot);
  });

  registry.handle(MAKER_INVOKE.SQUADS_READ, (event, slug: unknown) => {
    deps.assertTrusted(event);
    if (typeof slug !== 'string' || !isValidExpertSlug(slug)) {
      return { ok: false, reason: 'invalid', message: 'invalid squad slug' };
    }
    const file = path.join(deps.squadsRoot, slug, 'squad.yaml');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: false, reason: 'not-found', message: `no squad "${slug}"` };
    }
    return { ok: true, slug, file, yaml: raw };
  });

  registry.handle(MAKER_INVOKE.SQUADS_SAVE, (event, request: unknown): SquadSaveResult => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const op = str(r.op);
    const fields = r.fields;

    if (op === 'delete') {
      const slug = str(r.slug);
      if (!isValidExpertSlug(slug)) return { ok: false, reason: 'invalid', message: 'invalid squad slug' };
      const dir = path.join(deps.squadsRoot, slug);
      if (!fs.existsSync(dir)) return { ok: false, reason: 'not-found', message: `no squad "${slug}"` };
      fs.rmSync(dir, { recursive: true, force: true });
      pushFresh();
      return { ok: true, slug, file: path.join(dir, 'squad.yaml') };
    }

    if (op !== 'create' && op !== 'edit') {
      return { ok: false, reason: 'invalid', message: 'unknown squad save request' };
    }

    const candidate = fieldsToDefinition(fields);
    // Validate by round-tripping through the pure parser: what we write must parse.
    const rendered = renderSquadYaml(candidate);
    const parsed = parseSquadYaml(rendered);
    if (!parsed.ok) return { ok: false, reason: 'invalid', message: parsed.error };

    let slug: string;
    if (op === 'create') {
      slug = str(r.slug).trim() || squadSlugFromName(parsed.squad.name);
      if (!isValidExpertSlug(slug)) return { ok: false, reason: 'invalid', message: `invalid squad slug "${slug}"` };
      const dir = path.join(deps.squadsRoot, slug);
      if (fs.existsSync(dir)) return { ok: false, reason: 'exists', message: `a squad "${slug}" already exists` };
    } else {
      slug = str(r.slug);
      if (!isValidExpertSlug(slug)) return { ok: false, reason: 'invalid', message: 'invalid squad slug' };
      if (!fs.existsSync(path.join(deps.squadsRoot, slug, 'squad.yaml'))) {
        return { ok: false, reason: 'not-found', message: `no squad "${slug}"` };
      }
    }

    const file = path.join(deps.squadsRoot, slug, 'squad.yaml');
    // Edit keeps unknown keys from the file on disk; create writes only the owned keys.
    let baseYaml: string | undefined;
    if (op === 'edit') {
      try {
        baseYaml = fs.readFileSync(file, 'utf8');
      } catch {
        baseYaml = undefined;
      }
    }
    const text = renderSquadYaml({ ...parsed.squad, slug }, baseYaml);
    writeSquadFileAtomic(file, text);
    pushFresh();
    return { ok: true, slug, file };
  });

  registry.handle(MAKER_INVOKE.SQUADS_RESOLVE_LAUNCH, (event, slug: unknown, projectDir: unknown, task: unknown): SquadLaunchResult => {
    deps.assertTrusted(event);
    if (typeof slug !== 'string' || !isValidExpertSlug(slug)) {
      return { ok: false, errors: ['invalid squad slug'] };
    }
    const file = path.join(deps.squadsRoot, slug, 'squad.yaml');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: false, errors: [`no squad "${slug}"`] };
    }
    const parsed = parseSquadYaml(raw);
    if (!parsed.ok) return { ok: false, errors: [parsed.error] };

    const dir = projectDirArg(projectDir);
    const available = deps.listRosterIds(dir);
    const planResult = buildSquadLaunchPlan(parsed.squad, available, str(task));
    if (!planResult.ok) return { ok: false, errors: planResult.errors };

    // The 12.3 fail-closed check: every entry must be loadable and Hermes-runnable. The lead
    // must be Hermes too — only a Hermes lead can host Hermes workers (ADR 0011 §3/§5).
    const errors: string[] = [];
    const leadCheck = deps.resolveRosterEntry(parsed.squad.lead, dir);
    if (!leadCheck.ok) errors.push(`lead "${parsed.squad.lead}": ${leadCheck.message ?? 'cannot run on Hermes'}`);
    const members: Array<{ rosterId: string; name: string }> = [];
    for (const id of parsed.squad.members) {
      const check = deps.resolveRosterEntry(id, dir);
      if (!check.ok) errors.push(`member "${id}": ${check.message ?? 'cannot run on Hermes'}`);
      else members.push({ rosterId: id, name: check.name ?? id });
    }
    if (errors.length > 0) return { ok: false, errors };

    return { ok: true, plan: planResult.plan, leadName: leadCheck.name ?? parsed.squad.lead, members };
  });

  return {
    dispose() {
      watcher?.close();
      watcher = undefined;
    },
  };
}
