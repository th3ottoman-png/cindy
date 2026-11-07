/**
 * Auto-save every conversation to the notes vault (ROADMAP 5.5).
 *
 * Pure config handling plus one careful writer. Unlike the 5.2 export (a new file per export,
 * never overwritten), auto-save keeps **one stable file per conversation**: the name is fixed at
 * the first save (`YYYY-MM-DD-<slug>-<short id>.md`) and found again later by its short id plus
 * the `session_id` line in its frontmatter, so a title change never renames it. Each save
 * rewrites the file atomically (temp file in the same folder + rename). The writer refuses to
 * leave the vault, symlinks included.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { exportFileName, renderSessionMarkdown, type ExportSession } from './session-markdown.js';

export const DEFAULT_AUTOSAVE_FOLDER = 'Cindy/Chats';

export interface ChatAutosaveConfig {
  enabled: boolean;
  /** Folder inside the vault, relative, e.g. `Cindy/Chats`. */
  folder: string;
}

export interface ChatAutosaveConfigRead {
  config: ChatAutosaveConfig;
  issue?: string;
}

const DEFAULTS: ChatAutosaveConfig = { enabled: false, folder: DEFAULT_AUTOSAVE_FOLDER };

/** A relative folder inside the vault: no absolute path, no `..`, no empty segments. */
export function checkAutosaveFolder(folder: string): { ok: true; folder: string } | { ok: false; message: string } {
  const trimmed = folder.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return { ok: false, message: 'folder must not be empty' };
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    return { ok: false, message: 'folder must be relative to the vault' };
  }
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    return { ok: false, message: 'folder must not contain "..", "." or empty parts' };
  }
  return { ok: true, folder: parts.join('/') };
}

/** Missing file → defaults (off). Bad content → defaults plus an issue. */
export function readAutosaveConfig(configFile: string): ChatAutosaveConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: { ...DEFAULTS } };
    return { config: { ...DEFAULTS }, issue: `could not read ${configFile}: ${(err as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: { ...DEFAULTS }, issue: `${configFile} is not valid JSON` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: { ...DEFAULTS }, issue: 'auto-save config must be an object like { "enabled": true, "folder": "Cindy/Chats" }' };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled === true;
  if (obj.folder === undefined) return { config: { enabled, folder: DEFAULT_AUTOSAVE_FOLDER } };
  if (typeof obj.folder !== 'string') {
    return { config: { enabled: false, folder: DEFAULT_AUTOSAVE_FOLDER }, issue: '"folder" must be a string' };
  }
  const checked = checkAutosaveFolder(obj.folder);
  if (!checked.ok) {
    // Fail closed on a bad folder: never write somewhere unexpected.
    return { config: { enabled: false, folder: obj.folder }, issue: `"folder" ${checked.message}` };
  }
  return { config: { enabled, folder: checked.folder } };
}

/** Atomic write (temp file in the same folder + rename). Throws on a bad folder. */
export function writeAutosaveConfig(configFile: string, config: ChatAutosaveConfig): ChatAutosaveConfig {
  const checked = checkAutosaveFolder(typeof config.folder === 'string' ? config.folder : '');
  if (!checked.ok) throw new Error(`invalid auto-save folder: ${checked.message}`);
  const clean: ChatAutosaveConfig = { enabled: config.enabled === true, folder: checked.folder };
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(configFile)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, configFile);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return clean;
}

/** First 8 alphanumeric characters of the session id, lower-case; never empty. */
export function autosaveShortId(sessionId: string): string {
  return sessionId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'session';
}

/** `2026-11-07-fix-the-login-bug-1a2b3c4d.md`, fixed at the first save. */
export function autosaveFileName(title: string, firstSavedAt: Date, sessionId: string): string {
  return `${exportFileName(title, firstSavedAt)}-${autosaveShortId(sessionId)}.md`;
}

/** 5.2 Markdown plus `session_id` and `autosave: true` in the frontmatter. */
export function renderAutosaveMarkdown(session: ExportSession, sessionId: string, savedAt: Date): string {
  const markdown = renderSessionMarkdown(session, { exportedAt: savedAt });
  const extra = [`session_id: ${JSON.stringify(sessionId)}`, 'autosave: true'].join('\n');
  return markdown.replace(/^---\n/, `---\n${extra}\n`);
}

/** The existing auto-save file for this session in `dir`, if any. */
export function findAutosaveFile(dir: string, sessionId: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const suffix = `-${autosaveShortId(sessionId)}.md`;
  const marker = `session_id: ${JSON.stringify(sessionId)}`;
  for (const name of names.filter((n) => n.endsWith(suffix)).sort()) {
    const full = path.join(dir, name);
    let head = '';
    let fd: number | undefined;
    try {
      fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } catch {
      continue;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (!head.startsWith('---\n')) continue;
    const end = head.indexOf('\n---', 4);
    const frontmatter = end === -1 ? head.slice(4) : head.slice(4, end);
    if (frontmatter.split('\n').includes(marker)) return full;
  }
  return undefined;
}

export type WriteAutosaveResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; reason: 'no-vault' | 'bad-folder' | 'write-failed'; message: string };

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Write (or rewrite) this conversation's auto-save file under `<vaultDir>/<folder>/`.
 * No vault or a missing vault folder → `no-vault` (the caller stays quiet). The folder inside the
 * vault is created when missing.
 */
export function writeChatAutosave(
  vaultDir: string,
  folder: string,
  sessionId: string,
  session: ExportSession,
  savedAt: Date,
): WriteAutosaveResult {
  if (!vaultDir.trim()) return { ok: false, reason: 'no-vault', message: 'no vault folder is configured' };
  let root: string;
  try {
    root = fs.realpathSync(vaultDir);
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, reason: 'no-vault', message: `vault folder is missing: ${vaultDir}` };
  }
  const checked = checkAutosaveFolder(folder);
  if (!checked.ok) return { ok: false, reason: 'bad-folder', message: checked.message };
  if (!sessionId.trim()) return { ok: false, reason: 'write-failed', message: 'sessionId is required' };

  try {
    // Walk one segment at a time and check each real path before creating the next one, so a
    // symlink inside the vault can never make us create folders outside it.
    let dir = root;
    for (const part of checked.folder.split('/')) {
      const next = path.join(dir, part);
      if (!fs.existsSync(next)) fs.mkdirSync(next);
      dir = fs.realpathSync(next);
      if (!isInside(root, dir) || !fs.statSync(dir).isDirectory()) {
        return { ok: false, reason: 'bad-folder', message: 'folder escapes the vault or is not a folder' };
      }
    }

    const existing = findAutosaveFile(dir, sessionId);
    const target = existing ?? path.join(dir, autosaveFileName(session.title, savedAt, sessionId));
    const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.writeFileSync(tmp, renderAutosaveMarkdown(session, sessionId, savedAt), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, target);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { ok: true, path: target, created: !existing };
  } catch (err) {
    return { ok: false, reason: 'write-failed', message: err instanceof Error ? err.message : String(err) };
  }
}
