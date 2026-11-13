/**
 * Imported agents (ROADMAP 12.1).
 *
 * An imported agent is a read-only definition Cindy finds in a foreign directory
 * (`~/.claude/agents`, `<project>/.claude/agents`, `~/.qwen/agents`,
 * `<project>/.qwen/agents`). Cindy never writes there. This module is pure: parsing,
 * the fail-closed tool map and the "copy to my experts" draft conversion. Discovery and
 * IPC live in the desktop host (`maker-ipc/importedAgents.ts`).
 *
 * `runsOn` fails closed: Claude Code always; Hermes only when every declared tool maps
 * to a real Hermes tool (the names below are the ones the auto-review policy already maps,
 * live-proven on Hermes 0.23.0). An unmapped tool is named in `blockedTools`.
 * `model:` is kept raw and never auto-mapped to a route (AGENTS.md §6.3).
 */

import * as path from 'node:path';

import { parseFrontmatter } from '../agents/shared/customization-scanner.js';
import { EXPERT_DRAFT_LIMITS, type ExpertDraft } from './expert-draft.js';
import { expertSlugFromName } from './expert-form.js';
import type { ExpertAgent } from './expert-loader.js';

export const IMPORTED_AGENT_SOURCES = ['claude-user', 'claude-project', 'qwen-user', 'qwen-project'] as const;
export type ImportedAgentSource = (typeof IMPORTED_AGENT_SOURCES)[number];

export interface ImportedAgent {
  /** `imported:<source>:<relPath>` — one id space with `expert:<slug>` (blueprint §1). */
  id: string;
  source: ImportedAgentSource;
  absolutePath: string;
  /** Path relative to the source directory, posix separators. */
  relPath: string;
  /** Frontmatter name, else the file stem. */
  name: string;
  /** ≤ 500 characters, as the shared scanner caps it. */
  description: string;
  /** Raw names from `tools:`, trimmed but otherwise untouched. */
  declaredTools: string[];
  /** Raw `model:` (e.g. "opus"); never auto-mapped to a route. */
  declaredModel?: string;
  /** The markdown body: the agent's prompt. */
  prompt: string;
  runsOn: ExpertAgent[];
  /** Tools that stopped it running on Hermes. */
  blockedTools?: string[];
  /** Malformed file → listed with the error, never thrown. */
  error?: string;
}

/**
 * Foreign tool name → Hermes tool name. Small and unit-tested on purpose: anything not
 * listed blocks Hermes (fail closed) instead of guessing. Own keys only — a tool named
 * `constructor` must not inherit a mapping from the prototype.
 */
export const IMPORTED_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Grep: 'search_files',
  Glob: 'search_files',
  Bash: 'terminal',
  Edit: 'patch',
  Write: 'write_file',
};

export interface ImportedAgentMeta {
  source: ImportedAgentSource;
  absolutePath: string;
  relPath: string;
}

export function importedAgentId(source: ImportedAgentSource, relPath: string): string {
  return `imported:${source}:${relPath.replace(/\\/g, '/')}`;
}

const IMPORTED_ID = /^imported:(claude-user|claude-project|qwen-user|qwen-project):(.+)$/;

/** Validate a roster id; refuses traversal, absolute paths and unknown sources. */
export function parseImportedAgentId(id: unknown): { source: ImportedAgentSource; relPath: string } | null {
  if (typeof id !== 'string') return null;
  const match = IMPORTED_ID.exec(id);
  if (!match) return null;
  const relPath = match[2];
  if (relPath.startsWith('/') || relPath.includes('\\')) return null;
  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return { source: match[1] as ImportedAgentSource, relPath };
}

export function isImportedAgentId(id: unknown): id is string {
  return parseImportedAgentId(id) !== null;
}

function readDeclaredTools(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    // Non-string entries are kept as raw text so they block Hermes instead of vanishing.
    return value.map((t) => (typeof t === 'string' ? t.trim() : String(t))).filter(Boolean);
  }
  return [];
}

function runsOnFor(declaredTools: readonly string[]): { runsOn: ExpertAgent[]; blockedTools?: string[] } {
  const blocked = [...new Set(declaredTools.filter((t) => !Object.hasOwn(IMPORTED_TOOL_MAP, t)))];
  const runsOn: ExpertAgent[] = ['claude-code'];
  if (blocked.length === 0) runsOn.push('hermes');
  return blocked.length > 0 ? { runsOn, blockedTools: blocked } : { runsOn };
}

/** Parse one foreign agent file. Never throws: a malformed file comes back with `error`. */
export function parseImportedAgent(raw: string, meta: ImportedAgentMeta): ImportedAgent {
  const relPath = meta.relPath.replace(/\\/g, '/');
  const stem = path.posix.basename(relPath, path.posix.extname(relPath)) || relPath;
  const base = {
    id: importedAgentId(meta.source, relPath),
    source: meta.source,
    absolutePath: meta.absolutePath,
    relPath,
  };
  const parsed = parseFrontmatter(raw);
  if (parsed.parseError) {
    return { ...base, name: stem, description: '', declaredTools: [], prompt: '', runsOn: [], error: `frontmatter: ${parsed.parseError}` };
  }
  const fm = parsed.frontmatter ?? {};
  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : stem;
  const declaredTools = readDeclaredTools(fm.tools);
  const declaredModel = typeof fm.model === 'string' && fm.model.trim() ? fm.model.trim() : undefined;
  const { runsOn, blockedTools } = runsOnFor(declaredTools);
  return {
    ...base,
    name,
    description: parsed.description ?? '',
    declaredTools,
    ...(declaredModel ? { declaredModel } : {}),
    prompt: (parsed.content ?? '').trim(),
    runsOn,
    ...(blockedTools ? { blockedTools } : {}),
  };
}

export interface ImportedAgentDraftOptions {
  /** True when an expert folder with this slug already exists (copy never overwrites). */
  isSlugTaken?: (slug: string) => boolean;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * "Copy to my experts" as a 3.8 draft: same validation as the expert creator, no `tools:`
 * and no `model:` (the owner adds those by hand; a foreign `model: opus` is never mapped
 * to a paid route). A slug clash gets a numbered slug, never an overwrite.
 */
export function importedAgentToExpertDraft(agent: ImportedAgent, opts: ImportedAgentDraftOptions = {}): ExpertDraft {
  const isTaken = opts.isSlugTaken ?? (() => false);
  const base = expertSlugFromName(agent.name);
  let slug = base;
  for (let n = 2; isTaken(slug); n += 1) {
    slug = `${base.slice(0, 60)}-${n}`;
  }
  const description = oneLine(agent.description).slice(0, EXPERT_DRAFT_LIMITS.description)
    || oneLine(`Imported from ${agent.source} (${agent.relPath})`).slice(0, EXPERT_DRAFT_LIMITS.description);
  return {
    slug,
    name: oneLine(agent.name).slice(0, EXPERT_DRAFT_LIMITS.name),
    description,
    tags: ['imported', agent.source],
    memory: false,
    prompt: agent.prompt,
  };
}
