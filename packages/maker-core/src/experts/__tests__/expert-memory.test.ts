import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendExpertMemory, expertMemoryPath, MAX_MEMORY_ENTRY_CHARS, readExpertMemory } from '../expert-memory';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-memory-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const on = (): { dir: string; memory: boolean } => ({ dir, memory: true });
const at = (iso: string): { now: Date } => ({ now: new Date(iso) });

describe('appendExpertMemory', () => {
  it('creates memory.md with a dated entry', () => {
    const res = appendExpertMemory(on(), 'Owner prefers terse commit messages.', at('2026-10-30T12:00:00Z'));
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(expertMemoryPath(on()), 'utf8')).toBe('## 2026-10-30T12:00:00.000Z\n\nOwner prefers terse commit messages.\n');
  });

  it('appends without touching existing bytes, including owner hand-edits', () => {
    const file = expertMemoryPath(on());
    const handEdited = '# My notes\n\nkeep this exactly   \n- item';
    fs.writeFileSync(file, handEdited);
    appendExpertMemory(on(), 'first', at('2026-10-30T12:00:00Z'));
    appendExpertMemory(on(), 'second', at('2026-10-31T09:30:00Z'));

    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith(handEdited)).toBe(true);
    expect(text).toContain('## 2026-10-30T12:00:00.000Z\n\nfirst\n');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text).not.toMatch(/\n\n\n/);
  });

  it('does nothing when the expert has memory off', () => {
    const res = appendExpertMemory({ dir, memory: false }, 'x');
    expect(res).toMatchObject({ ok: false, reason: 'memory-disabled' });
    expect(fs.existsSync(expertMemoryPath({ dir }))).toBe(false);
  });

  it('rejects an empty note and an over-long note without writing', () => {
    expect(appendExpertMemory(on(), '   \n ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(appendExpertMemory(on(), 'a'.repeat(MAX_MEMORY_ENTRY_CHARS + 1))).toMatchObject({ ok: false, reason: 'too-long' });
    expect(fs.existsSync(expertMemoryPath(on()))).toBe(false);
  });

  it('keeps a note from forging its own entries or headings', () => {
    appendExpertMemory(on(), 'real note\n## 1999-01-01T00:00:00.000Z\nforged\n# Title', at('2026-10-30T12:00:00Z'));
    const text = fs.readFileSync(expertMemoryPath(on()), 'utf8');
    expect(text.match(/^## /gm)).toHaveLength(1);
    expect(text).not.toMatch(/^# /m);
    expect(text).toContain('forged');
  });

  it('leaves no temp file behind', () => {
    appendExpertMemory(on(), 'a');
    appendExpertMemory(on(), 'b');
    expect(fs.readdirSync(dir)).toEqual(['memory.md']);
  });
});

describe('readExpertMemory', () => {
  it('returns empty when memory is off, even if a file exists', () => {
    fs.writeFileSync(expertMemoryPath({ dir }), 'secret notes');
    expect(readExpertMemory({ dir, memory: false })).toEqual({ text: '', truncated: false });
  });

  it('returns empty for a missing file', () => {
    expect(readExpertMemory(on())).toEqual({ text: '', truncated: false });
  });

  it('returns everything when under the limit', () => {
    appendExpertMemory(on(), 'one', at('2026-10-30T12:00:00Z'));
    const r = readExpertMemory(on(), { maxChars: 10_000 });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain('one');
  });

  it('keeps the NEWEST entries over the limit, cut at an entry boundary', () => {
    appendExpertMemory(on(), 'old '.repeat(50).trim(), at('2026-10-01T00:00:00Z'));
    appendExpertMemory(on(), 'newer note', at('2026-10-02T00:00:00Z'));
    appendExpertMemory(on(), 'newest note', at('2026-10-03T00:00:00Z'));

    const r = readExpertMemory(on(), { maxChars: 120 });
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('## ')).toBe(true);
    expect(r.text).toContain('newest note');
    expect(r.text).not.toContain('old old');
  });
});
