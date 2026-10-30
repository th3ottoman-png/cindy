/**
 * Expert loader (ROADMAP 3.1a).
 *
 * An expert is a directory `<root>/<slug>/` holding `expert.md` (YAML frontmatter + system
 * prompt body) and optional `skills/`, `tools.yaml`, `knowledge/`. Files are the source of
 * truth: this module only reads them, never writes. An invalid expert is returned with its
 * error so the UI can list it; one bad expert never hides or breaks the others.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

export const EXPERT_AGENTS = ['hermes', 'claude-code', 'codex', 'pi'] as const;
export type ExpertAgent = (typeof EXPERT_AGENTS)[number];

export interface Expert {
  slug: string;
  dir: string;
  name: string;
  description: string;
  agent: ExpertAgent;
  /** Route name from routing.yaml (ROADMAP 2.3); resolved elsewhere. */
  model?: string;
  temperature?: number;
  tools: string[];
  skills: string[];
  memory: boolean;
  tags: string[];
  /** The markdown body of expert.md: the system prompt. */
  prompt: string;
  /** Absolute paths of `skills/<name>/SKILL.md` files, sorted. */
  skillFiles: string[];
  /** Absolute path of `tools.yaml` when present (parsed by the tool-policy layer, not here). */
  toolsFile?: string;
  /** Absolute path of `knowledge/` when present. */
  knowledgeDir?: string;
}

export interface ExpertEntry {
  slug: string;
  dir: string;
  expert?: Expert;
  /** Set when the expert could not be loaded; `expert` is then absent. */
  error?: string;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

function optionalStringList(data: Record<string, unknown>, key: string): string[] {
  const v = data[key];
  if (v === undefined || v === null) return [];
  if (!isStringArray(v)) throw new Error(`"${key}" must be a list of non-empty strings`);
  return v.map((x) => x.trim());
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function listSkillFiles(dir: string): string[] {
  const skillsDir = path.join(dir, 'skills');
  let names: string[];
  try {
    names = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .map((n) => path.join(skillsDir, n, 'SKILL.md'))
    .filter(exists)
    .sort();
}

/** Load one expert directory. Never throws: failures come back as `error`. */
export function loadExpert(dir: string): ExpertEntry {
  const slug = path.basename(dir);
  const entry: ExpertEntry = { slug, dir };
  try {
    const file = path.join(dir, 'expert.md');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error('expert.md is missing');
    }
    // gray-matter caches by input string; pass an empty options object to skip the cache
    // so a re-read after an edit is never stale.
    const parsed = matter(raw, {});
    const data = parsed.data as Record<string, unknown>;

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) throw new Error('frontmatter "name" is required');

    const agentRaw = data.agent === undefined ? 'hermes' : data.agent;
    if (typeof agentRaw !== 'string' || !(EXPERT_AGENTS as readonly string[]).includes(agentRaw)) {
      throw new Error(`"agent" must be one of ${EXPERT_AGENTS.join(', ')}`);
    }

    if (data.description !== undefined && typeof data.description !== 'string') {
      throw new Error('"description" must be a string');
    }
    if (data.model !== undefined && (typeof data.model !== 'string' || !data.model.trim())) {
      throw new Error('"model" must be a non-empty string (a route name)');
    }
    let temperature: number | undefined;
    if (data.temperature !== undefined) {
      if (typeof data.temperature !== 'number' || data.temperature < 0 || data.temperature > 2) {
        throw new Error('"temperature" must be a number between 0 and 2');
      }
      temperature = data.temperature;
    }
    if (data.memory !== undefined && typeof data.memory !== 'boolean') {
      throw new Error('"memory" must be true or false');
    }

    const prompt = parsed.content.trim();
    if (!prompt) throw new Error('expert.md has no system prompt body');

    const toolsFile = path.join(dir, 'tools.yaml');
    const knowledgeDir = path.join(dir, 'knowledge');
    entry.expert = {
      slug,
      dir,
      name,
      description: typeof data.description === 'string' ? data.description.trim() : '',
      agent: agentRaw as ExpertAgent,
      ...(typeof data.model === 'string' ? { model: data.model.trim() } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      tools: optionalStringList(data, 'tools'),
      skills: optionalStringList(data, 'skills'),
      memory: data.memory === true,
      tags: optionalStringList(data, 'tags'),
      prompt,
      skillFiles: listSkillFiles(dir),
      ...(exists(toolsFile) ? { toolsFile } : {}),
      ...(exists(knowledgeDir) ? { knowledgeDir } : {}),
    };
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  return entry;
}

/** Load every expert directory under `root`, sorted by slug. A missing root is an empty list. */
export function loadExperts(root: string): ExpertEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .sort()
    .map((n) => path.join(root, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .map(loadExpert);
}

export interface ExpertWatcher {
  close(): void;
}

/**
 * Re-load all experts whenever anything under `root` changes (debounced) and hand the fresh
 * list to `onChange`. If `root` does not exist yet, watch its parent until it appears.
 */
export function watchExperts(
  root: string,
  onChange: (entries: ExpertEntry[]) => void,
  debounceMs = 150,
): ExpertWatcher {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  let poll: NodeJS.Timeout | undefined;

  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!closed) onChange(loadExperts(root));
    }, debounceMs);
  };

  const arm = (): void => {
    if (closed) return;
    watcher?.close();
    if (poll) clearInterval(poll);
    poll = undefined;
    try {
      if (exists(root)) {
        watcher = fs.watch(root, { recursive: true }, fire);
      } else {
        const parent = path.dirname(root);
        const rootAppeared = (): void => {
          if (exists(root)) {
            arm();
            fire();
          }
        };
        watcher = fs.watch(parent, rootAppeared);
        // fs.watch can miss the parent event under load; a slow poll guarantees the root is found.
        poll = setInterval(rootAppeared, 500);
        poll.unref();
      }
      watcher.on('error', () => undefined);
    } catch {
      // Watching is a convenience; without it the list still loads on demand.
    }
  };
  arm();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      watcher?.close();
    },
  };
}
