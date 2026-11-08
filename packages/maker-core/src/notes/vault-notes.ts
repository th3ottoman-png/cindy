/**
 * Local notes vault bridge (ROADMAP 5.1a).
 *
 * Pure-logic read / search / append over a folder of Markdown notes (Obsidian-style). The vault
 * path is supplied by the caller; nothing here picks or remembers one. Every note path is
 * relative, `.md` only, and must stay inside the vault after symlinks are resolved. Appending
 * never rewrites existing bytes (temp file in the same directory, then rename) and redacts
 * obvious credentials. The agent-facing tool and the `tools.yaml` opt-in are 5.1b.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactSecrets } from '../export/session-markdown';

export const MAX_NOTE_APPEND_CHARS = 8000;
const SKIP_DIRS = new Set(['node_modules']);

export type NoteError = { ok: false; reason: 'bad-path' | 'outside-vault' | 'not-found' | 'empty' | 'too-long' | 'no-vault'; message: string };

export interface NoteInfo {
  path: string;
  mtimeMs: number;
}

function vaultRoot(vaultDir: string): string | undefined {
  try {
    return fs.realpathSync(vaultDir);
  } catch {
    return undefined;
  }
}

/** Validate a vault-relative note path. Returns the normalised relative path. */
export function checkNotePath(rel: string): { ok: true; rel: string } | NoteError {
  if (typeof rel !== 'string' || rel.trim() === '' || rel.includes('\0')) return { ok: false, reason: 'bad-path', message: 'empty or invalid path' };
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(norm) || /^[A-Za-z]:/.test(norm)) return { ok: false, reason: 'bad-path', message: 'path must be relative to the vault' };
  const parts = norm.split('/');
  if (parts.some((p) => p === '..')) return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };
  if (parts.some((p) => p.startsWith('.'))) return { ok: false, reason: 'bad-path', message: 'hidden files and folders are not allowed' };
  if (!norm.toLowerCase().endsWith('.md')) return { ok: false, reason: 'bad-path', message: 'only .md notes are allowed' };
  return { ok: true, rel: norm };
}

/** True when `target` (already realpath'd) is `root` or inside it. */
function inside(root: string, target: string): boolean {
  const r = path.relative(root, target);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

export function listNotes(vaultDir: string, opts: { limit?: number } = {}): NoteInfo[] | NoteError {
  const root = vaultRoot(vaultDir);
  if (!root) return { ok: false, reason: 'no-vault', message: 'vault folder does not exist' };
  const out: NoteInfo[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        try {
          out.push({ path: rel, mtimeMs: fs.statSync(path.join(dir, e.name)).mtimeMs });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(root, '');
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}

export function readNote(vaultDir: string, rel: string, opts: { maxChars?: number } = {}): { ok: true; path: string; text: string; truncated: boolean } | NoteError {
  const checked = checkNotePath(rel);
  if (!checked.ok) return checked;
  const root = vaultRoot(vaultDir);
  if (!root) return { ok: false, reason: 'no-vault', message: 'vault folder does not exist' };
  let real: string;
  try {
    real = fs.realpathSync(path.join(root, checked.rel));
  } catch {
    return { ok: false, reason: 'not-found', message: `no note at ${checked.rel}` };
  }
  if (!inside(root, real)) return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };
  const text = fs.readFileSync(real, 'utf8');
  const max = opts.maxChars;
  if (max !== undefined && text.length > max) return { ok: true, path: checked.rel, text: text.slice(0, max), truncated: true };
  return { ok: true, path: checked.rel, text, truncated: false };
}

export interface SearchHit {
  path: string;
  score: number;
  /** Up to `maxSnippets` matching lines, trimmed, with 1-based line numbers. */
  snippets: { line: number; text: string }[];
}

/**
 * Case-insensitive search. Every whitespace-separated term must appear somewhere in the note
 * (path or body). Path matches rank above body matches; more body hits rank higher.
 */
export function searchNotes(
  vaultDir: string,
  query: string,
  opts: { limit?: number; maxSnippets?: number; maxFileBytes?: number } = {},
): SearchHit[] | NoteError {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { ok: false, reason: 'empty', message: 'empty query' };
  const notes = listNotes(vaultDir);
  if (!Array.isArray(notes)) return notes;
  const root = vaultRoot(vaultDir) as string;
  const maxBytes = opts.maxFileBytes ?? 512 * 1024;
  const maxSnippets = opts.maxSnippets ?? 3;
  const hits: SearchHit[] = [];
  for (const n of notes) {
    const file = path.join(root, n.path);
    let text: string;
    try {
      if (fs.statSync(file).size > maxBytes) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const pathLower = n.path.toLowerCase();
    const lower = text.toLowerCase();
    if (!terms.every((t) => pathLower.includes(t) || lower.includes(t))) continue;
    const snippets: SearchHit['snippets'] = [];
    let bodyHits = 0;
    text.split('\n').forEach((line, i) => {
      const l = line.toLowerCase();
      if (terms.some((t) => l.includes(t))) {
        bodyHits++;
        if (snippets.length < maxSnippets) snippets.push({ line: i + 1, text: redactSecrets(line.trim()).slice(0, 200) });
      }
    });
    const pathScore = terms.filter((t) => pathLower.includes(t)).length * 100;
    hits.push({ path: n.path, score: pathScore + bodyHits, snippets });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
}

/**
 * Append a dated entry (`## <ISO timestamp>` + body) to a note, creating the note (and folders
 * inside the vault) when missing. Existing content is preserved byte for byte.
 */
export function appendNote(vaultDir: string, rel: string, text: string, opts: { now?: Date } = {}): { ok: true; path: string; created: boolean } | NoteError {
  const checked = checkNotePath(rel);
  if (!checked.ok) return checked;
  const body = redactSecrets(text.trim());
  if (!body) return { ok: false, reason: 'empty', message: 'nothing to append' };
  if (body.length > MAX_NOTE_APPEND_CHARS) return { ok: false, reason: 'too-long', message: `note is ${body.length} chars; the limit is ${MAX_NOTE_APPEND_CHARS}` };
  const root = vaultRoot(vaultDir);
  if (!root) return { ok: false, reason: 'no-vault', message: 'vault folder does not exist' };

  const target = path.join(root, checked.rel);
  const dir = path.dirname(target);
  // Create missing folders one level at a time, re-checking containment after each.
  const missing: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    fs.mkdirSync(d);
    if (!inside(root, fs.realpathSync(d))) {
      fs.rmdirSync(d);
      return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };
    }
  }
  if (!inside(root, fs.realpathSync(dir))) return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };

  let existing = '';
  let created = true;
  try {
    // realpath guards a symlinked note pointing outside the vault.
    if (!inside(root, fs.realpathSync(target))) return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };
    existing = fs.readFileSync(target, 'utf8');
    created = false;
  } catch {
    existing = '';
  }
  const stamp = (opts.now ?? new Date()).toISOString();
  const entry = `## ${stamp}\n\n${body.replace(/^(#{1,2})(\s)/gm, '\\$1$2')}\n`;
  const sep = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, existing + sep + entry);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { ok: true, path: checked.rel, created };
}

export interface VaultConfig {
  vaultDir: string;
  allSessionsSearch?: boolean;
}

export interface VaultConfigRead {
  config: VaultConfig;
  issue?: string;
}

/**
 * Read the vault configuration file (~/.cindy-harness/vault.json). Never throws.
 * Missing file returns an empty vaultDir with no issue.
 */
export function readVaultConfig(configFile: string): VaultConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: { vaultDir: '' } };
    }
    return {
      config: { vaultDir: '' },
      issue: `cannot read vault config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return {
      config: { vaultDir: '' },
      issue: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      config: { vaultDir: '' },
      issue: 'vault config must be an object like { "vaultDir": "/path/to/vault" }',
    };
  }
  const raw = doc as Record<string, unknown>;
  const allSessionsSearch = typeof raw.allSessionsSearch === 'boolean' ? raw.allSessionsSearch : undefined;
  const dirVal = raw.vaultDir ?? raw.vaultPath;
  if (dirVal === undefined || dirVal === null || dirVal === '') {
    return { config: { vaultDir: '', ...(allSessionsSearch !== undefined ? { allSessionsSearch } : {}) } };
  }
  if (typeof dirVal !== 'string') {
    return {
      config: { vaultDir: '', ...(allSessionsSearch !== undefined ? { allSessionsSearch } : {}) },
      issue: '"vaultDir" must be a string path',
    };
  }
  const vaultDir = dirVal.trim();
  if (vaultDir === '') {
    return { config: { vaultDir: '', ...(allSessionsSearch !== undefined ? { allSessionsSearch } : {}) } };
  }
  try {
    if (!fs.existsSync(vaultDir)) {
      return {
        config: { vaultDir, ...(allSessionsSearch !== undefined ? { allSessionsSearch } : {}) },
        issue: `configured vault folder does not exist: ${vaultDir}`,
      };
    }
    const stat = fs.statSync(vaultDir);
    if (!stat.isDirectory()) {
      return {
        config: { vaultDir, ...(allSessionsSearch !== undefined ? { allSessionsSearch } : {}) },
        issue: `configured vault path is not a directory: ${vaultDir}`,
      };
    }
  } catch (error) {
    return {
      config: { vaultDir, ...(allSessionsSearch !== undefined ? { allSessionsSearch } : {}) },
      issue: `cannot access vault folder: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { config: { vaultDir, ...(allSessionsSearch !== undefined ? { allSessionsSearch } : {}) } };
}

/**
 * Write vault configuration atomically (temp file in same folder + rename).
 */
export function writeVaultConfig(configFile: string, config: VaultConfig): void {
  if (typeof config !== 'object' || config === null || typeof config.vaultDir !== 'string') {
    throw new Error('invalid vault config: vaultDir must be a string');
  }
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(configFile)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const payload: VaultConfig = {
    vaultDir: config.vaultDir.trim(),
    ...(typeof config.allSessionsSearch === 'boolean' ? { allSessionsSearch: config.allSessionsSearch } : {}),
  };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, configFile);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

