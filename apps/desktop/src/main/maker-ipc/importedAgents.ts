/**
 * Imported agents (ROADMAP 12.1): discovery and IPC over the foreign agent directories
 * (`~/.claude/agents`, `<project>/.claude/agents`, `~/.qwen/agents`,
 * `<project>/.qwen/agents`). Read-only: Cindy never writes into those directories.
 * "Copy to my experts" goes through the EXPERTS_SAVE create path (3.8 draft rules) and
 * never overwrites a slug. Invalid files are listed with their error, never thrown.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { expertDraftExists } from '@cindy/maker-core/expert-draft';
import { loadExperts } from '@cindy/maker-core/experts';
import {
  importedAgentToExpertDraft,
  isImportedAgentId,
  parseImportedAgent,
  parseImportedAgentId,
  type ImportedAgent,
  type ImportedAgentSource,
} from '@cindy/maker-core/imported-agents';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import { saveExpert } from './expertsHandlers.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** The roster is a browser, not a file manager (same spirit as the hub's vault-note cap). */
export const IMPORTED_AGENTS_FILE_CAP = 1000;

export interface ImportedAgentsScope {
  homeDir: string;
  /** The active session's working dir; project sources are only read when it is absolute. */
  projectDir?: string | null;
}

export interface ImportedAgentSourceDir {
  source: ImportedAgentSource;
  dir: string;
}

export function importedAgentSourceDirs(scope: ImportedAgentsScope): ImportedAgentSourceDir[] {
  const dirs: ImportedAgentSourceDir[] = [
    { source: 'claude-user', dir: path.join(scope.homeDir, '.claude', 'agents') },
    { source: 'qwen-user', dir: path.join(scope.homeDir, '.qwen', 'agents') },
  ];
  if (scope.projectDir && path.isAbsolute(scope.projectDir)) {
    dirs.push(
      { source: 'claude-project', dir: path.join(scope.projectDir, '.claude', 'agents') },
      { source: 'qwen-project', dir: path.join(scope.projectDir, '.qwen', 'agents') },
    );
  }
  return dirs;
}

function realPathInside(parentRealPath: string, candidate: string): boolean {
  try {
    const rel = path.relative(parentRealPath, fs.realpathSync(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

function visibleEntry(name: string): boolean {
  return !name.startsWith('.') && !/\.bak\.\d+$/.test(name);
}

/** 'file' | 'dir' for a dirent, following symlinks once; null when unreadable. */
function entryKind(abs: string, ent: fs.Dirent): 'file' | 'dir' | null {
  if (ent.isFile()) return 'file';
  if (ent.isDirectory()) return 'dir';
  if (!ent.isSymbolicLink()) return null;
  try {
    const stat = fs.statSync(abs);
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}

export interface ImportedAgentsDiscovery {
  agents: ImportedAgent[];
  /** True when more files exist than the cap allows. */
  capped: boolean;
}

/**
 * Read the four directories at recursion depth 1 (one level of sub-folders), skipping
 * dot-files and symlinks that leave the directory, capped at {@link IMPORTED_AGENTS_FILE_CAP}.
 */
export function discoverImportedAgents(scope: ImportedAgentsScope & { maxFiles?: number }): ImportedAgentsDiscovery {
  const cap = scope.maxFiles ?? IMPORTED_AGENTS_FILE_CAP;
  const agents: ImportedAgent[] = [];
  let capped = false;

  const addFile = (source: ImportedAgentSource, rootReal: string, abs: string, relPath: string): void => {
    if (agents.length >= cap) {
      capped = true;
      return;
    }
    if (!realPathInside(rootReal, abs)) return;
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      const stem = path.posix.basename(relPath, path.posix.extname(relPath));
      agents.push({
        id: `imported:${source}:${relPath}`,
        source,
        absolutePath: abs,
        relPath,
        name: stem,
        description: '',
        declaredTools: [],
        prompt: '',
        runsOn: [],
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    agents.push(parseImportedAgent(raw, { source, absolutePath: abs, relPath }));
  };

  for (const { source, dir } of importedAgentSourceDirs(scope)) {
    if (capped) break;
    let rootReal: string;
    let entries: fs.Dirent[];
    try {
      rootReal = fs.realpathSync(dir);
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable directory: no rows from it
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (capped) break;
      if (!visibleEntry(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const kind = entryKind(abs, ent);
      if (kind === 'file') {
        if (isMarkdown(ent.name)) addFile(source, rootReal, abs, ent.name);
        continue;
      }
      if (kind !== 'dir' || !realPathInside(rootReal, abs)) continue;
      // Depth 1: files inside one level of sub-folders, nothing deeper.
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (capped) break;
        if (!visibleEntry(child.name) || !isMarkdown(child.name)) continue;
        const childAbs = path.join(abs, child.name);
        if (entryKind(childAbs, child) !== 'file') continue;
        addFile(source, rootReal, childAbs, `${ent.name}/${child.name}`);
      }
    }
  }
  return { agents, capped };
}

/** Resolve one roster id against the scoped directories; null when unknown or out of bounds. */
export function readImportedAgentById(id: unknown, scope: ImportedAgentsScope): ImportedAgent | null {
  const parsed = parseImportedAgentId(id);
  if (!parsed || !isMarkdown(parsed.relPath)) return null;
  const match = importedAgentSourceDirs(scope).find((d) => d.source === parsed.source);
  if (!match) return null;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(match.dir);
  } catch {
    return null;
  }
  const abs = path.join(match.dir, parsed.relPath);
  if (!realPathInside(rootReal, abs)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  return parseImportedAgent(raw, { source: parsed.source, absolutePath: abs, relPath: parsed.relPath });
}

export interface ImportedAgentsWatcher {
  close(): void;
}

/** Debounced change notification for the given directories; missing ones are simply not watched. */
export function watchImportedAgents(
  dirs: readonly string[],
  onChange: () => void,
  debounceMs = 150,
): ImportedAgentsWatcher {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const watchers: fs.FSWatcher[] = [];
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!closed) onChange();
    }, debounceMs);
  };
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const watcher = fs.watch(dir, { recursive: true }, fire);
      watcher.on('error', () => undefined);
      watchers.push(watcher);
    } catch {
      // Watching is a convenience; the list still loads on demand.
    }
  }
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}

export type ImportedAgentReadResult =
  | { ok: true; agent: ImportedAgent }
  | { ok: false; reason: 'invalid' | 'not-found'; message: string };

export type ImportedAgentCopyResult =
  | { ok: true; slug: string; dir: string; file: string }
  | { ok: false; reason: 'invalid' | 'not-found' | 'exists'; message: string };

export interface ImportedAgentsHandlerDeps {
  /** Production: os.homedir(). Injected so tests use a temp tree. */
  homeDir: string;
  /** Production: ~/.cindy-harness/experts. */
  expertsRoot: string;
  assertTrusted(event: unknown): void;
  broadcast(channel: string, payload: unknown): void;
  /** Injected so tests need no native fs.watch (threads-pool SIGSEGV, ROADMAP Debt). */
  watch?: typeof watchImportedAgents;
}

export interface ImportedAgentsHandlerHandle {
  dispose(): void;
}

function projectDirArg(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

export function registerImportedAgentsHandlers(
  registry: IpcHandlerRegistry,
  deps: ImportedAgentsHandlerDeps,
): ImportedAgentsHandlerHandle {
  let watcher: ImportedAgentsWatcher | undefined;
  let watchedProjectDir: string | null = null;

  const arm = (projectDir: string | null): void => {
    watcher?.close();
    watchedProjectDir = projectDir;
    const dirs = importedAgentSourceDirs({ homeDir: deps.homeDir, projectDir }).map((d) => d.dir);
    watcher = (deps.watch ?? watchImportedAgents)(dirs, () => {
      deps.broadcast(
        MAKER_PUSH.IMPORTED_AGENTS_CHANGED,
        discoverImportedAgents({ homeDir: deps.homeDir, projectDir: watchedProjectDir }),
      );
    });
  };

  registry.handle(MAKER_INVOKE.IMPORTED_AGENTS_LIST, (event, projectDir: unknown) => {
    deps.assertTrusted(event);
    const next = projectDirArg(projectDir);
    if (!watcher || next !== watchedProjectDir) arm(next);
    return discoverImportedAgents({ homeDir: deps.homeDir, projectDir: next });
  });

  registry.handle(MAKER_INVOKE.IMPORTED_AGENTS_READ, (event, id: unknown, projectDir: unknown): ImportedAgentReadResult => {
    deps.assertTrusted(event);
    if (!isImportedAgentId(id)) {
      return { ok: false, reason: 'invalid', message: `invalid imported agent id "${String(id)}"` };
    }
    const agent = readImportedAgentById(id, { homeDir: deps.homeDir, projectDir: projectDirArg(projectDir) });
    if (!agent) {
      return { ok: false, reason: 'not-found', message: `no imported agent "${id}" in the known directories` };
    }
    return { ok: true, agent };
  });

  registry.handle(MAKER_INVOKE.IMPORTED_AGENTS_COPY_TO_EXPERT, (event, id: unknown, projectDir: unknown): ImportedAgentCopyResult => {
    deps.assertTrusted(event);
    if (!isImportedAgentId(id)) {
      return { ok: false, reason: 'invalid', message: `invalid imported agent id "${String(id)}"` };
    }
    const agent = readImportedAgentById(id, { homeDir: deps.homeDir, projectDir: projectDirArg(projectDir) });
    if (!agent) {
      return { ok: false, reason: 'not-found', message: `no imported agent "${id}" in the known directories` };
    }
    if (agent.error) {
      return { ok: false, reason: 'invalid', message: `"${agent.name}" cannot be copied: ${agent.error}` };
    }
    const draft = importedAgentToExpertDraft(agent, {
      isSlugTaken: (slug) => expertDraftExists(deps.expertsRoot, slug),
    });
    // The EXPERTS_SAVE create path: same 3.8 validation, atomic write, never overwrites.
    const res = saveExpert(deps.expertsRoot, { op: 'create', slug: draft.slug, fields: draft });
    if (!res.ok) {
      // Create can only fail validation or hit an existing folder; other reasons belong to edit/delete.
      return { ok: false, reason: res.reason === 'exists' ? 'exists' : 'invalid', message: res.message };
    }
    deps.broadcast(MAKER_PUSH.EXPERTS_CHANGED, loadExperts(deps.expertsRoot));
    return { ok: true, slug: res.slug, dir: res.dir, file: res.file };
  });

  return {
    dispose() {
      watcher?.close();
      watcher = undefined;
    },
  };
}
