/**
 * Expert drafts (ROADMAP 3.8, ADR 0005/0007).
 *
 * The expert creator proposes a new expert as a draft; the owner approves it before anything
 * is written (option A). This module is the file side: it checks a draft against the same rules
 * the loader enforces, renders `expert.md`, and writes a NEW expert folder atomically:
 * a hidden temp folder in the experts root is written, loaded back through the real loader,
 * and only then renamed into place. An existing expert is never overwritten.
 *
 * A draft cannot grant tools: the written expert has no `tools:` line, so an expert creator
 * can never create another expert creator. The owner adds tools by hand if they want them.
 *
 * The Settings expert editor (ROADMAP 3.3) uses the same path: Create is `writeExpertDraft`,
 * Duplicate copies a folder through the same temp-folder commit, and Edit rewrites `expert.md`
 * (temp file loaded back, then renamed) only if the file still has the hash the editor read,
 * so a hand edit made meanwhile is never overwritten.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import { EXPERT_MEMORY_FILE } from './expert-memory';
import { loadExpert, type ExpertAgent } from './expert-loader';

/** Lowercase kebab-case folder name, 2–64 characters. */
const DRAFT_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const EXPERT_DRAFT_LIMITS = {
  name: 80,
  description: 300,
  model: 120,
  tags: 10,
  tag: 40,
  prompt: 20_000,
} as const;

export interface ExpertDraft {
  slug: string;
  name: string;
  description: string;
  /** Route name from routing.yaml, or a model id. Omitted: runs on whatever model the session uses. */
  model?: string;
  tags: string[];
  memory: boolean;
  /** The system prompt (body of expert.md). */
  prompt: string;
}

export type ExpertDraftCheck = { ok: true; draft: ExpertDraft } | { ok: false; errors: string[] };

function oneLine(value: string): boolean {
  return !/[\r\n]/.test(value);
}

/** Check untrusted input (a tool call) and normalise it into a draft. Never throws. */
export function validateExpertDraft(input: unknown): ExpertDraftCheck {
  const errors: string[] = [];
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const L = EXPERT_DRAFT_LIMITS;

  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  if (!DRAFT_SLUG.test(slug)) {
    errors.push('"slug" must be 2-64 characters of lowercase letters, digits and dashes, starting with a letter or digit (e.g. "uk-cold-email-writer")');
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) errors.push('"name" is required');
  else if (name.length > L.name || !oneLine(name)) errors.push(`"name" must be one line of at most ${L.name} characters`);

  let description = '';
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') errors.push('"description" must be a string');
    else description = raw.description.trim();
  }
  if (!description) errors.push('"description" is required (one sentence saying what the expert does)');
  else if (description.length > L.description || !oneLine(description)) {
    errors.push(`"description" must be one line of at most ${L.description} characters`);
  }

  let model: string | undefined;
  if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
    if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.trim().length > L.model || !oneLine(raw.model)) {
      errors.push(`"model" must be a route name of at most ${L.model} characters, or omitted`);
    } else {
      model = raw.model.trim();
    }
  }

  let tags: string[] = [];
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string' && t.trim() && t.trim().length <= L.tag && oneLine(t))) {
      errors.push(`"tags" must be a list of short words (each at most ${L.tag} characters)`);
    } else if (raw.tags.length > L.tags) {
      errors.push(`"tags" holds at most ${L.tags} entries`);
    } else {
      tags = [...new Set((raw.tags as string[]).map((t) => t.trim()))];
    }
  }

  let memory = false;
  if (raw.memory !== undefined && raw.memory !== null) {
    if (typeof raw.memory !== 'boolean') errors.push('"memory" must be true or false');
    else memory = raw.memory;
  }

  if (raw.tools !== undefined || (raw.agent !== undefined && raw.agent !== 'hermes')) {
    errors.push('drafts cannot set "tools" or a non-Hermes "agent"; the owner adds those by hand');
  }

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) errors.push('"prompt" (the expert\'s system prompt) is required');
  else if (prompt.length > L.prompt) errors.push(`"prompt" is ${prompt.length} characters; the limit is ${L.prompt}`);
  else if (/^---\s*$/m.test(prompt.split('\n')[0] ?? '')) errors.push('"prompt" must not start with a "---" line');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, draft: { slug, name, description, ...(model ? { model } : {}), tags, memory, prompt } };
}

/** The exact `expert.md` an approved draft becomes. */
export function renderExpertMarkdown(draft: ExpertDraft): string {
  const data: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
    agent: 'hermes',
    ...(draft.model ? { model: draft.model } : {}),
    memory: draft.memory,
    ...(draft.tags.length > 0 ? { tags: draft.tags } : {}),
  };
  // lineWidth -1: one line per field, so the owner can hand-edit it (no folded `>-` blocks).
  const text = matter.stringify(`${draft.prompt}\n`, data, { lineWidth: -1 } as Parameters<typeof matter.stringify>[2]);
  return text.endsWith('\n') ? text : `${text}\n`;
}

export type WriteExpertDraftResult =
  | { ok: true; dir: string; file: string }
  | { ok: false; reason: 'exists' | 'invalid'; message: string };

export function expertDraftExists(rootDir: string, slug: string): boolean {
  try {
    fs.lstatSync(path.join(rootDir, slug));
    return true;
  } catch {
    return false;
  }
}

function existsMessage(slug: string): string {
  return `an expert folder "${slug}" already exists; nothing was overwritten`;
}

/**
 * Create `<rootDir>/<slug>` all or nothing: `populate` fills a dot-prefixed temp folder (the
 * loader and the picker ignore it), the result is loaded back through the real loader, and only
 * then renamed into place. On any failure the temp folder is removed and nothing is created.
 */
function commitNewExpertFolder(
  rootDir: string,
  slug: string,
  kind: string,
  populate: (tmp: string) => void,
  now: () => number,
): WriteExpertDraftResult {
  const target = path.join(rootDir, slug);
  if (expertDraftExists(rootDir, slug)) return { ok: false, reason: 'exists', message: existsMessage(slug) };

  fs.mkdirSync(rootDir, { recursive: true });
  const tmp = path.join(rootDir, `.${slug}.${kind}-${process.pid}-${now()}`);
  try {
    fs.mkdirSync(tmp);
    populate(tmp);
    const loaded = loadExpert(tmp);
    if (!loaded.expert) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, reason: 'invalid', message: `the expert does not load: ${loaded.error ?? 'unknown error'}` };
    }
    if (expertDraftExists(rootDir, slug)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, reason: 'exists', message: existsMessage(slug) };
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return { ok: false, reason: 'exists', message: existsMessage(slug) };
    throw error;
  }
  return { ok: true, dir: target, file: path.join(target, 'expert.md') };
}

/**
 * Write an approved draft as `<rootDir>/<slug>/expert.md`. All or nothing: on any failure the
 * temp folder is removed and nothing under `<rootDir>/<slug>` is created or changed.
 */
export function writeExpertDraft(rootDir: string, draft: ExpertDraft, opts: { now?: () => number } = {}): WriteExpertDraftResult {
  const check = validateExpertDraft(draft);
  if (!check.ok) return { ok: false, reason: 'invalid', message: check.errors.join('; ') };
  const clean = check.draft;
  return commitNewExpertFolder(
    rootDir,
    clean.slug,
    'draft',
    (tmp) => fs.writeFileSync(path.join(tmp, 'expert.md'), renderExpertMarkdown(clean), { flag: 'wx' }),
    opts.now ?? Date.now,
  );
}

// ---------------------------------------------------------------------------------------------
// Settings expert editor (ROADMAP 3.3)
// ---------------------------------------------------------------------------------------------

/** The frontmatter fields and prompt the editor form changes. Everything else in the file is kept. */
export interface ExpertEditFields {
  name: string;
  description: string;
  model?: string;
  tags: string[];
  memory: boolean;
  prompt: string;
}

/** Frontmatter the form shows but does not change (hand-edit the file for these). */
export interface ExpertEditExtras {
  agent: ExpertAgent;
  temperature?: number;
  tools: string[];
  skills: string[];
}

/** The expert's memory notes (ROADMAP 3.4b), shown read-only; `text` is null when memory.md does not exist. */
export interface ExpertNotesSource {
  file: string;
  text: string | null;
}

export type ExpertSourceResult =
  | {
      ok: true;
      slug: string;
      file: string;
      markdown: string;
      hash: string;
      fields: ExpertEditFields;
      extras: ExpertEditExtras;
      notes: ExpertNotesSource;
    }
  | { ok: false; reason: 'missing' | 'invalid'; message: string };

export type ExpertSaveResult =
  | { ok: true; slug: string; dir: string; file: string; hash: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'exists' | 'conflict'; message: string };

export function hashExpertMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

function readExpertFile(rootDir: string, slug: string): { file: string; markdown: string } | ExpertSourceResult {
  // Hand-made folders may use any name the loader lists (no dot-prefix, no path separators).
  if (typeof slug !== 'string' || !/^[^./\\][^/\\]{0,127}$/.test(slug) || slug.includes('..')) {
    return { ok: false, reason: 'invalid', message: `invalid expert folder name "${String(slug)}"` };
  }
  const file = path.join(rootDir, slug, 'expert.md');
  try {
    return { file, markdown: fs.readFileSync(file, 'utf8') };
  } catch {
    return { ok: false, reason: 'missing', message: `no expert "${slug}" (expected ${file})` };
  }
}

/** Read one expert for the editor. Never throws; an expert the loader rejects comes back with its error. */
export function readExpertSource(rootDir: string, slug: string): ExpertSourceResult {
  const read = readExpertFile(rootDir, slug);
  if ('ok' in read) return read;
  const loaded = loadExpert(path.join(rootDir, slug));
  if (!loaded.expert) return { ok: false, reason: 'invalid', message: loaded.error ?? 'the expert does not load' };
  const e = loaded.expert;
  const notesFile = path.join(rootDir, slug, 'memory.md');
  let notesText: string | null = null;
  try {
    notesText = fs.readFileSync(notesFile, 'utf8');
  } catch {
    notesText = null;
  }
  return {
    ok: true,
    slug,
    file: read.file,
    markdown: read.markdown,
    hash: hashExpertMarkdown(read.markdown),
    fields: {
      name: e.name,
      description: e.description,
      ...(e.model ? { model: e.model } : {}),
      tags: e.tags,
      memory: e.memory,
      prompt: e.prompt,
    },
    extras: {
      agent: e.agent,
      ...(e.temperature !== undefined ? { temperature: e.temperature } : {}),
      tools: e.tools,
      skills: e.skills,
    },
    // Not part of `hash`: an appended note must not make an open edit form look stale.
    notes: { file: notesFile, text: notesText },
  };
}

/** Same field rules as a draft (one-line name/description, limits), without the tools/agent rule. */
function checkEditFields(slug: string, fields: unknown): { ok: true; fields: ExpertEditFields } | { ok: false; message: string } {
  const raw = (fields && typeof fields === 'object' ? fields : {}) as Record<string, unknown>;
  const check = validateExpertDraft({
    slug: DRAFT_SLUG.test(slug) ? slug : 'edited-expert',
    name: raw.name,
    description: raw.description,
    model: raw.model,
    tags: raw.tags,
    memory: raw.memory,
    prompt: raw.prompt,
  });
  if (!check.ok) return { ok: false, message: check.errors.join('; ') };
  const { slug: _slug, ...clean } = check.draft;
  return { ok: true, fields: clean };
}

function renderEditedMarkdown(current: string, fields: ExpertEditFields): string {
  const parsed = matter(current, {});
  const data: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) };
  data.name = fields.name;
  data.description = fields.description;
  if (fields.model) data.model = fields.model;
  else delete data.model;
  data.memory = fields.memory;
  if (fields.tags.length > 0) data.tags = fields.tags;
  else delete data.tags;
  const text = matter.stringify(`${fields.prompt}\n`, data, { lineWidth: -1 } as Parameters<typeof matter.stringify>[2]);
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Save the editor form into `<rootDir>/<slug>/expert.md`. Refused with `conflict` when the file
 * no longer has `baseHash` (it was edited by hand since the editor read it): the file wins.
 * Other frontmatter keys (agent, tools, skills, temperature, anything unknown) are kept; YAML
 * comments in the frontmatter are not.
 */
export function saveExpertEdit(
  rootDir: string,
  slug: string,
  input: { baseHash: string; fields: unknown },
  opts: { now?: () => number } = {},
): ExpertSaveResult {
  const read = readExpertFile(rootDir, slug);
  if ('ok' in read) return read as ExpertSaveResult;
  const conflict = (): ExpertSaveResult => ({
    ok: false,
    reason: 'conflict',
    message: `${read.file} changed on disk since the editor opened it; reload it, then save again`,
  });
  if (hashExpertMarkdown(read.markdown) !== input.baseHash) return conflict();
  const check = checkEditFields(slug, input.fields);
  if (!check.ok) return { ok: false, reason: 'invalid', message: check.message };

  let markdown: string;
  try {
    markdown = renderEditedMarkdown(read.markdown, check.fields);
  } catch (error) {
    return { ok: false, reason: 'invalid', message: `the current file does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
  const dir = path.join(rootDir, slug);
  const tmp = path.join(rootDir, `.${slug}.edit-${process.pid}-${(opts.now ?? Date.now)()}`);
  try {
    fs.mkdirSync(tmp);
    const tmpFile = path.join(tmp, 'expert.md');
    fs.writeFileSync(tmpFile, markdown, { flag: 'wx' });
    const loaded = loadExpert(tmp);
    if (!loaded.expert) return { ok: false, reason: 'invalid', message: `the edited expert does not load: ${loaded.error ?? 'unknown error'}` };
    // Re-check right before the rename: a hand edit that landed while we rendered still wins.
    let now: string;
    try {
      now = fs.readFileSync(read.file, 'utf8');
    } catch {
      return { ok: false, reason: 'missing', message: `${read.file} was removed while saving` };
    }
    if (hashExpertMarkdown(now) !== input.baseHash) return conflict();
    fs.renameSync(tmpFile, read.file);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: true, slug, dir, file: read.file, hash: hashExpertMarkdown(markdown) };
}

/**
 * Copy `<rootDir>/<from>` to a new `<rootDir>/<slug>` with a new name. Everything is copied
 * (prompt, tools, skills, knowledge) except the expert's memory notes and dot-files.
 * Never overwrites; all or nothing.
 */
export function duplicateExpert(
  rootDir: string,
  from: string,
  input: { slug: unknown; name: unknown },
  opts: { now?: () => number } = {},
): ExpertSaveResult {
  const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!DRAFT_SLUG.test(slug)) {
    return { ok: false, reason: 'invalid', message: '"slug" must be 2-64 characters of lowercase letters, digits and dashes' };
  }
  if (!name || name.length > EXPERT_DRAFT_LIMITS.name || !oneLine(name)) {
    return { ok: false, reason: 'invalid', message: `"name" must be one line of at most ${EXPERT_DRAFT_LIMITS.name} characters` };
  }
  const read = readExpertFile(rootDir, from);
  if ('ok' in read) return read as ExpertSaveResult;
  const source = path.join(rootDir, from);

  const res = commitNewExpertFolder(
    rootDir,
    slug,
    'copy',
    (tmp) => {
      fs.cpSync(source, tmp, {
        recursive: true,
        filter: (src) => {
          const rel = path.relative(source, src);
          if (rel === '') return true;
          if (rel === EXPERT_MEMORY_FILE) return false;
          return !path.basename(src).startsWith('.');
        },
      });
      const parsed = matter(read.markdown, {});
      const data = { ...(parsed.data as Record<string, unknown>), name };
      const text = matter.stringify(parsed.content, data, { lineWidth: -1 } as Parameters<typeof matter.stringify>[2]);
      fs.writeFileSync(path.join(tmp, 'expert.md'), text.endsWith('\n') ? text : `${text}\n`);
    },
    opts.now ?? Date.now,
  );
  if (!res.ok) return res;
  return { ok: true, slug, dir: res.dir, file: res.file, hash: hashExpertMarkdown(fs.readFileSync(res.file, 'utf8')) };
}

/**
 * Delete an expert folder by its slug.
 * Fails closed on invalid folder names, path traversal, or non-existent experts.
 */
export function deleteExpert(rootDir: string, slug: string): ExpertSaveResult {
  if (typeof slug !== 'string' || !/^[^./\\][^/\\]{0,127}$/.test(slug) || slug.includes('..')) {
    return { ok: false, reason: 'invalid', message: `invalid expert folder name "${String(slug)}"` };
  }
  const expertDir = path.join(rootDir, slug);
  const resolvedExpertDir = path.resolve(expertDir);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolvedExpertDir.startsWith(resolvedRoot + path.sep)) {
    return { ok: false, reason: 'invalid', message: `expert folder outside root: "${slug}"` };
  }
  if (!fs.existsSync(resolvedExpertDir)) {
    return { ok: false, reason: 'missing', message: `no expert "${slug}"` };
  }
  try {
    fs.rmSync(resolvedExpertDir, { recursive: true, force: true });
    return { ok: true, slug, dir: '', file: '', hash: '' };
  } catch (err) {
    return { ok: false, reason: 'invalid', message: err instanceof Error ? err.message : String(err) };
  }
}

