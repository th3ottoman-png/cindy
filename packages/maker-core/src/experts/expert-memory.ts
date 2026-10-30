/**
 * Expert memory (ROADMAP 3.4a).
 *
 * Opt-in (`memory: true` in `expert.md`), append-only notes in `<expertDir>/memory.md`: plain
 * Markdown the owner can read and hand-edit. Entries are `## <ISO timestamp>` + body. This module
 * only ever appends (existing bytes are never rewritten by it) and writes atomically
 * (temp file in the same directory, then rename), so a crash cannot leave a half-written file.
 * The agent-facing tool and the editor UI are 3.4b.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Expert } from './expert-loader';

export const EXPERT_MEMORY_FILE = 'memory.md';
export const MAX_MEMORY_ENTRY_CHARS = 4000;

export type MemoryTarget = Pick<Expert, 'dir' | 'memory'>;

export function expertMemoryPath(expert: Pick<Expert, 'dir'>): string {
  return path.join(expert.dir, EXPERT_MEMORY_FILE);
}

/**
 * Read the notes for injection at session start. When the file is longer than `maxChars`, the
 * NEWEST part is returned (cut at an entry boundary when possible) and `truncated` is true.
 * Returns empty notes when memory is off or the file is missing; never throws.
 */
export function readExpertMemory(expert: MemoryTarget, opts: { maxChars?: number } = {}): { text: string; truncated: boolean } {
  if (!expert.memory) return { text: '', truncated: false };
  let text: string;
  try {
    text = fs.readFileSync(expertMemoryPath(expert), 'utf8');
  } catch {
    return { text: '', truncated: false };
  }
  const max = opts.maxChars;
  if (max === undefined || text.length <= max) return { text, truncated: false };
  const tail = text.slice(text.length - max);
  const boundary = tail.indexOf('\n## ');
  return { text: boundary >= 0 ? tail.slice(boundary + 1) : tail, truncated: true };
}

export type AppendMemoryResult = { ok: true; path: string; entry: string } | { ok: false; reason: 'memory-disabled' | 'empty' | 'too-long'; message: string };

/** Make the body safe to sit under a `##` heading: no headings of its own level or above. */
function neutraliseHeadings(body: string): string {
  return body.replace(/^(#{1,2})(\s)/gm, (_m, hashes: string, ws: string) => `\\${hashes}${ws}`);
}

/** Append one dated entry. Existing content is preserved byte for byte. */
export function appendExpertMemory(expert: MemoryTarget, note: string, opts: { now?: Date } = {}): AppendMemoryResult {
  if (!expert.memory) return { ok: false, reason: 'memory-disabled', message: 'this expert has memory: false' };
  const body = note.trim();
  if (!body) return { ok: false, reason: 'empty', message: 'nothing to save' };
  if (body.length > MAX_MEMORY_ENTRY_CHARS) {
    return { ok: false, reason: 'too-long', message: `note is ${body.length} chars; the limit is ${MAX_MEMORY_ENTRY_CHARS}` };
  }

  const file = expertMemoryPath(expert);
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  const stamp = (opts.now ?? new Date()).toISOString();
  const entry = `## ${stamp}\n\n${neutraliseHeadings(body)}\n`;
  const separator = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';

  const tmp = path.join(expert.dir, `.${EXPERT_MEMORY_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, existing + separator + entry);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { ok: true, path: file, entry };
}
