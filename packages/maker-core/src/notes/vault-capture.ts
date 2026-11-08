/**
 * Quick-capture and session context pinning for local notes vault (ROADMAP 6.5).
 *
 * Provides:
 * - Quick-capture of thoughts, snippets, or session insights directly into vault (default "Inbox.md").
 * - File-backed persistent pinning of vault notes per session (or globally).
 * - Generation of bounded prompt preambles for pinned notes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactSecrets } from '../export/session-markdown';
import { checkNotePath, readNote } from './vault-notes';

export const MAX_QUICK_CAPTURE_CHARS = 8000;
export const DEFAULT_PINNED_NOTE_PREAMBLE_CHARS = 3000;
export const DEFAULT_CAPTURE_TARGET = 'Inbox.md';

export interface QuickCaptureInput {
  content: string;
  targetFile?: string;
  tags?: string[];
  title?: string;
  sourceSessionId?: string;
  sourceSessionTitle?: string;
}

export type QuickCaptureResult =
  | { ok: true; relPath: string; bytesWritten: number; created: boolean }
  | { ok: false; reason: 'bad-path' | 'outside-vault' | 'empty' | 'too-long' | 'no-vault' | 'io-error' | 'not-found'; message: string };

export interface PinnedNotesConfig {
  sessions: Record<string, string[]>;
  globalPins?: string[];
}

function vaultRoot(vaultDir: string): string | undefined {
  try {
    return fs.realpathSync(vaultDir);
  } catch {
    return undefined;
  }
}

function inside(root: string, target: string): boolean {
  const r = path.relative(root, target);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function writeAtomic(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${path.basename(targetPath)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
}

/**
 * Quick-capture content into a markdown note in the notes vault.
 * Appends to existing note or creates new one with header.
 */
export function quickCaptureNote(vaultDir: string, input: QuickCaptureInput): QuickCaptureResult {
  const root = vaultRoot(vaultDir);
  if (!root) {
    return { ok: false, reason: 'no-vault', message: 'vault directory does not exist or is inaccessible' };
  }

  if (typeof input.content !== 'string' || input.content.trim() === '') {
    return { ok: false, reason: 'empty', message: 'content cannot be empty' };
  }

  if (input.content.length > MAX_QUICK_CAPTURE_CHARS) {
    return {
      ok: false,
      reason: 'too-long',
      message: `content exceeds maximum length of ${MAX_QUICK_CAPTURE_CHARS} characters`,
    };
  }

  const targetRel = input.targetFile ? input.targetFile.trim() : DEFAULT_CAPTURE_TARGET;
  const pathCheck = checkNotePath(targetRel);
  if (!pathCheck.ok) {
    return { ok: false, reason: pathCheck.reason, message: pathCheck.message };
  }

  const normRel = pathCheck.rel;
  const targetAbs = path.join(root, normRel);
  const targetDir = path.dirname(targetAbs);

  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      return { ok: false, reason: 'io-error', message: `failed to create directory: ${(err as Error).message}` };
    }
  }

  let realDir: string;
  try {
    realDir = fs.realpathSync(targetDir);
  } catch (err) {
    return { ok: false, reason: 'io-error', message: `failed to resolve directory: ${(err as Error).message}` };
  }

  if (!inside(root, realDir)) {
    return { ok: false, reason: 'outside-vault', message: 'target directory leaves the vault' };
  }

  const fileExists = fs.existsSync(targetAbs);
  let existingContent = '';
  if (fileExists) {
    try {
      const realTarget = fs.realpathSync(targetAbs);
      if (!inside(root, realTarget)) {
        return { ok: false, reason: 'outside-vault', message: 'target note resolves outside the vault' };
      }
      existingContent = fs.readFileSync(targetAbs, 'utf8');
    } catch (err) {
      return { ok: false, reason: 'io-error', message: `failed to read existing note: ${(err as Error).message}` };
    }
  }

  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 19);

  let entryHeader = `\n\n### Captured ${dateStr}`;
  if (input.title?.trim()) {
    entryHeader += ` — ${input.title.trim()}`;
  }

  let metadataBlock = '';
  if (input.sourceSessionId) {
    const sTitle = input.sourceSessionTitle ? `"${input.sourceSessionTitle.trim()}" ` : '';
    metadataBlock += `\n> Source: ${sTitle}(\`${input.sourceSessionId.trim()}\`)\n`;
  }

  let tagsBlock = '';
  if (Array.isArray(input.tags) && input.tags.length > 0) {
    const cleanTags = input.tags
      .map((t) => (t.startsWith('#') ? t.slice(1) : t).trim())
      .filter(Boolean)
      .map((t) => `#${t}`);
    if (cleanTags.length > 0) {
      tagsBlock = `\n${cleanTags.join(' ')}\n`;
    }
  }

  const sanitizedBody = redactSecrets(input.content.trim());
  const entryText = `${entryHeader}\n${metadataBlock}${tagsBlock}\n${sanitizedBody}\n`;

  let finalContent: string;
  let created = false;

  if (!fileExists) {
    created = true;
    const docTitle = input.targetFile ? path.basename(normRel, '.md') : 'Inbox';
    const docHeader = `# ${docTitle}\n\nQuick captures and notes saved from Cindy sessions.`;
    finalContent = `${docHeader}${entryText}`;
  } else {
    finalContent = existingContent.endsWith('\n') ? `${existingContent.trimEnd()}${entryText}` : `${existingContent}${entryText}`;
  }

  try {
    writeAtomic(targetAbs, finalContent);
    return {
      ok: true,
      relPath: normRel,
      bytesWritten: Buffer.byteLength(entryText, 'utf8'),
      created,
    };
  } catch (err) {
    return { ok: false, reason: 'io-error', message: `failed to write note: ${(err as Error).message}` };
  }
}

/**
 * Load pinned notes configuration from JSON file.
 * Fails open: returns empty structure on missing or corrupted file.
 */
export function loadPinnedNotes(filePath: string): PinnedNotesConfig {
  try {
    if (!fs.existsSync(filePath)) {
      return { sessions: {}, globalPins: [] };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const sessions = typeof parsed?.sessions === 'object' && parsed.sessions !== null ? parsed.sessions : {};
    const globalPins = Array.isArray(parsed?.globalPins) ? parsed.globalPins.filter((p: unknown): p is string => typeof p === 'string') : [];
    return { sessions, globalPins };
  } catch {
    return { sessions: {}, globalPins: [] };
  }
}

/**
 * Save pinned notes configuration to JSON file atomically.
 */
export function savePinnedNotes(filePath: string, config: PinnedNotesConfig): void {
  const safeConfig: PinnedNotesConfig = {
    sessions: {},
    globalPins: Array.isArray(config.globalPins) ? [...new Set(config.globalPins)] : [],
  };

  for (const [sid, list] of Object.entries(config.sessions || {})) {
    if (typeof sid === 'string' && Array.isArray(list)) {
      const cleanList = [...new Set(list.filter((item): item is string => typeof item === 'string'))];
      if (cleanList.length > 0) {
        safeConfig.sessions[sid] = cleanList;
      }
    }
  }

  writeAtomic(filePath, JSON.stringify(safeConfig, null, 2) + '\n');
}

/**
 * Pin a vault note to a specific session.
 */
export function pinNoteToSession(
  filePath: string,
  sessionId: string,
  notePath: string,
): { ok: boolean; pinnedNotes: string[]; error?: string } {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, pinnedNotes: [], error: 'invalid sessionId' };
  }
  const check = checkNotePath(notePath);
  if (!check.ok) {
    return { ok: false, pinnedNotes: [], error: check.message };
  }

  const config = loadPinnedNotes(filePath);
  const current = config.sessions[sessionId] ?? [];
  if (!current.includes(check.rel)) {
    config.sessions[sessionId] = [...current, check.rel];
    savePinnedNotes(filePath, config);
  }
  return { ok: true, pinnedNotes: config.sessions[sessionId] };
}

/**
 * Unpin a vault note from a specific session.
 */
export function unpinNoteFromSession(
  filePath: string,
  sessionId: string,
  notePath: string,
): { ok: boolean; pinnedNotes: string[] } {
  const check = checkNotePath(notePath);
  const targetRel = check.ok ? check.rel : notePath.replace(/\\/g, '/');

  const config = loadPinnedNotes(filePath);
  const current = config.sessions[sessionId] ?? [];
  const updated = current.filter((p) => p !== targetRel);
  if (updated.length !== current.length) {
    if (updated.length === 0) {
      delete config.sessions[sessionId];
    } else {
      config.sessions[sessionId] = updated;
    }
    savePinnedNotes(filePath, config);
  }
  return { ok: true, pinnedNotes: updated };
}

/**
 * Retrieve all pinned notes for a session (including global pins).
 */
export function getPinnedNotesForSession(filePath: string, sessionId: string): string[] {
  const config = loadPinnedNotes(filePath);
  const sessionPins = sessionId && config.sessions[sessionId] ? config.sessions[sessionId] : [];
  const globalPins = config.globalPins ?? [];
  return [...new Set([...globalPins, ...sessionPins])];
}

/**
 * Build a structured Markdown preamble from pinned vault notes.
 * Bounded per-note to prevent context explosion.
 */
export function buildPinnedNotesPreamble(
  vaultDir: string,
  notePaths: string[],
  maxCharsPerNote = DEFAULT_PINNED_NOTE_PREAMBLE_CHARS,
): string {
  if (!vaultDir || !Array.isArray(notePaths) || notePaths.length === 0) {
    return '';
  }

  const sections: string[] = [];
  for (const rel of notePaths) {
    const res = readNote(vaultDir, rel, { maxChars: maxCharsPerNote });
    if (res.ok && res.text.trim()) {
      const truncatedNotice = res.truncated ? '\n[...truncated to character budget...]' : '';
      sections.push(
        `[Pinned Vault Note: ${rel}]\n${res.text.trim()}${truncatedNotice}\n[/Pinned Vault Note: ${rel}]`,
      );
    }
  }

  if (sections.length === 0) {
    return '';
  }

  return `The following reference notes are pinned from the user's local notes vault:\n\n${sections.join('\n\n')}`;
}
