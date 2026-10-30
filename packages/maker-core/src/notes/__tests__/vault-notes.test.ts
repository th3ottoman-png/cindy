import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendNote, checkNotePath, listNotes, readNote, searchNotes } from '../vault-notes';

let vault: string;
let outside: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const f = path.join(vault, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

describe('checkNotePath', () => {
  it('accepts plain relative .md paths', () => {
    expect(checkNotePath('a/b.md')).toEqual({ ok: true, rel: 'a/b.md' });
  });
  it.each(['../x.md', 'a/../../x.md', '/etc/x.md', 'C:/x.md', 'a.txt', '.hidden/x.md', 'a/.x.md', '', 'a\0.md'])('rejects %j', (p) => {
    expect(checkNotePath(p).ok).toBe(false);
  });
  it('reports traversal as outside-vault', () => {
    expect(checkNotePath('../x.md')).toMatchObject({ ok: false, reason: 'outside-vault' });
  });
});

describe('listNotes', () => {
  it('lists only visible .md files, newest first, skipping dot dirs and symlinks', () => {
    write('old.md', 'o');
    write('sub/new.md', 'n');
    write('.obsidian/cfg.md', 'x');
    write('readme.txt', 'x');
    fs.symlinkSync(outside, path.join(vault, 'link'));
    fs.utimesSync(path.join(vault, 'old.md'), 1000, 1000);
    const res = listNotes(vault);
    expect(Array.isArray(res) && res.map((n) => n.path)).toEqual(['sub/new.md', 'old.md']);
  });
  it('honours limit and reports a missing vault', () => {
    write('a.md', 'a');
    write('b.md', 'b');
    expect((listNotes(vault, { limit: 1 }) as unknown[]).length).toBe(1);
    expect(listNotes(path.join(vault, 'nope'))).toMatchObject({ ok: false, reason: 'no-vault' });
  });
});

describe('readNote', () => {
  it('reads and truncates', () => {
    write('a.md', 'hello world');
    expect(readNote(vault, 'a.md')).toEqual({ ok: true, path: 'a.md', text: 'hello world', truncated: false });
    expect(readNote(vault, 'a.md', { maxChars: 5 })).toMatchObject({ text: 'hello', truncated: true });
  });
  it('reports missing notes and traversal', () => {
    expect(readNote(vault, 'nope.md')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(readNote(vault, '../a.md')).toMatchObject({ ok: false, reason: 'outside-vault' });
  });
  it('refuses a symlinked note that points outside the vault', () => {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'top secret');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(vault, 'leak.md'));
    expect(readNote(vault, 'leak.md')).toMatchObject({ ok: false, reason: 'outside-vault' });
  });
});

describe('searchNotes', () => {
  it('requires every term, ranks path matches first, and returns line snippets', () => {
    write('pension.md', 'nothing here');
    write('other.md', 'line one\nthe pension plan is\nanother pension line');
    write('unrelated.md', 'cats');
    const res = searchNotes(vault, 'Pension') as Exclude<ReturnType<typeof searchNotes>, { ok: false }>;
    expect(res.map((h) => h.path)).toEqual(['pension.md', 'other.md']);
    expect(res[1].snippets).toEqual([
      { line: 2, text: 'the pension plan is' },
      { line: 3, text: 'another pension line' },
    ]);
    expect((searchNotes(vault, 'pension plan zzz') as unknown[]).length).toBe(0);
  });
  it('rejects an empty query and skips oversized files', () => {
    write('big.md', 'needle '.repeat(100));
    expect(searchNotes(vault, '  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(searchNotes(vault, 'needle', { maxFileBytes: 10 })).toEqual([]);
  });
  it('redacts credentials in snippets', () => {
    write('k.md', 'my token: abcdefghijklmnop123');
    const res = searchNotes(vault, 'token') as { snippets: { text: string }[] }[];
    expect(res[0].snippets[0].text).not.toContain('abcdefghijklmnop123');
  });
});

describe('appendNote', () => {
  const NOW = new Date('2026-10-30T12:00:00Z');
  it('creates a note with a dated entry, then appends without touching earlier bytes', () => {
    expect(appendNote(vault, 'daily/today.md', 'first', { now: NOW })).toEqual({ ok: true, path: 'daily/today.md', created: true });
    const after1 = fs.readFileSync(path.join(vault, 'daily/today.md'), 'utf8');
    expect(after1).toBe('## 2026-10-30T12:00:00.000Z\n\nfirst\n');
    expect(appendNote(vault, 'daily/today.md', 'second', { now: NOW })).toMatchObject({ ok: true, created: false });
    const after2 = fs.readFileSync(path.join(vault, 'daily/today.md'), 'utf8');
    expect(after2.startsWith(after1)).toBe(true);
    expect(after2).toContain('second');
  });
  it('keeps hand-written content intact and neutralises headings in the body', () => {
    write('n.md', '# My note\nhand written');
    appendNote(vault, 'n.md', '# Sneaky\ntext', { now: NOW });
    const text = fs.readFileSync(path.join(vault, 'n.md'), 'utf8');
    expect(text.startsWith('# My note\nhand written\n\n## 2026')).toBe(true);
    expect(text).toContain('\\# Sneaky');
  });
  it('redacts credentials, rejects empty/too long, and leaves no temp files', () => {
    appendNote(vault, 'n.md', 'key sk-abcdefghijklmnopqrstuvwx', { now: NOW });
    expect(fs.readFileSync(path.join(vault, 'n.md'), 'utf8')).not.toContain('sk-abcdefgh');
    expect(appendNote(vault, 'n.md', '   ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(appendNote(vault, 'n.md', 'x'.repeat(8001))).toMatchObject({ ok: false, reason: 'too-long' });
    expect(fs.readdirSync(vault).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('cannot write outside the vault by traversal, symlinked note, or symlinked folder', () => {
    expect(appendNote(vault, '../evil.md', 'x')).toMatchObject({ ok: false, reason: 'outside-vault' });
    fs.writeFileSync(path.join(outside, 'target.md'), 'keep');
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(vault, 'l.md'));
    expect(appendNote(vault, 'l.md', 'x')).toMatchObject({ ok: false, reason: 'outside-vault' });
    fs.symlinkSync(outside, path.join(vault, 'dirlink'));
    expect(appendNote(vault, 'dirlink/new.md', 'x')).toMatchObject({ ok: false, reason: 'outside-vault' });
    expect(fs.readFileSync(path.join(outside, 'target.md'), 'utf8')).toBe('keep');
    expect(fs.readdirSync(outside)).toEqual(['target.md']);
  });
});
