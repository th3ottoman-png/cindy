import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendNote, checkNotePath, listNotes, readNote, readVaultConfig, searchNotes, watchVault, writeVaultConfig } from '../vault-notes';

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

describe('readVaultConfig / writeVaultConfig', () => {
  it('reads empty config when file does not exist', () => {
    const missing = path.join(outside, 'vault.json');
    const res = readVaultConfig(missing);
    expect(res).toEqual({ config: { vaultDir: '' } });
  });

  it('reads and writes valid vault config atomically', () => {
    const file = path.join(outside, 'vault.json');
    writeVaultConfig(file, { vaultDir: vault });
    const res = readVaultConfig(file);
    expect(res).toEqual({ config: { vaultDir: vault } });
  });

  it('reports invalid JSON as an issue', () => {
    const file = path.join(outside, 'bad.json');
    fs.writeFileSync(file, '{ not-json');
    const res = readVaultConfig(file);
    expect(res.config.vaultDir).toBe('');
    expect(res.issue).toContain('not valid JSON');
  });

  it('reports non-existent directory as an issue', () => {
    const file = path.join(outside, 'missing-dir.json');
    const fakeDir = path.join(outside, 'does-not-exist');
    fs.writeFileSync(file, JSON.stringify({ vaultDir: fakeDir }));
    const res = readVaultConfig(file);
    expect(res.config.vaultDir).toBe(fakeDir);
    expect(res.issue).toContain('does not exist');
  });

  it('reports non-directory path as an issue', () => {
    const file = path.join(outside, 'file-not-dir.json');
    const aFile = path.join(outside, 'plain.txt');
    fs.writeFileSync(aFile, 'hello');
    fs.writeFileSync(file, JSON.stringify({ vaultDir: aFile }));
    const res = readVaultConfig(file);
    expect(res.config.vaultDir).toBe(aFile);
    expect(res.issue).toContain('not a directory');
  });

  it('supports vaultPath key for compatibility', () => {
    const file = path.join(outside, 'vault-path.json');
    fs.writeFileSync(file, JSON.stringify({ vaultPath: vault }));
    const res = readVaultConfig(file);
    expect(res).toEqual({ config: { vaultDir: vault } });
  });

  it('reads and writes allSessionsSearch flag', () => {
    const file = path.join(outside, 'all-search.json');
    writeVaultConfig(file, { vaultDir: vault, allSessionsSearch: true });
    const res = readVaultConfig(file);
    expect(res).toEqual({ config: { vaultDir: vault, allSessionsSearch: true } });

    writeVaultConfig(file, { vaultDir: vault, allSessionsSearch: false });
    const resFalse = readVaultConfig(file);
    expect(resFalse).toEqual({ config: { vaultDir: vault, allSessionsSearch: false } });
  });
});

describe('watchVault', () => {
  it('notifies on note creation and modification, ignoring hidden files', async () => {
    let callCount = 0;
    const watcher = watchVault(vault, () => {
      callCount++;
    }, 20);
    // Allow macOS fs.watch stream to settle before mutating
    await new Promise((r) => setTimeout(r, 50));

    try {
      // 1. Create a note in vault
      write('note1.md', 'Initial content');
      await vi.waitFor(() => {
        expect(callCount).toBeGreaterThan(0);
      }, { timeout: 3000 });
      // Settle any trailing macOS write/stat events before recording baseline
      await new Promise((r) => setTimeout(r, 60));

      const prevCount = callCount;

      // 2. Modify hidden file inside .obsidian - should not trigger
      const obsDir = path.join(vault, '.obsidian');
      fs.mkdirSync(obsDir, { recursive: true });
      fs.writeFileSync(path.join(obsDir, 'workspace.json'), '{}');

      // Wait a moment and assert callCount didn't increase
      await new Promise((r) => setTimeout(r, 60));
      expect(callCount).toBe(prevCount);

      // 3. Close watcher and write another note
      watcher.close();
      write('note2.md', 'After close');
      await new Promise((r) => setTimeout(r, 60));
      expect(callCount).toBe(prevCount);
    } finally {
      watcher.close();
    }
  });

  it('still notifies when the startup window swallows the fs event', async () => {
    // Measured on macOS 2026-11-13: a write issued right after arming sometimes
    // produced NO event at all (a 20 s budget did not save it; 3 of 8 loaded
    // runs), so the note count stayed stale in the UI until the next change.
    // The fake watcher never emits, so only the post-arm fingerprint check can
    // deliver this notification.
    let callCount = 0;
    const silent = {
      on: () => silent,
      close: () => undefined,
      unref: () => silent,
      ref: () => silent,
    } as unknown as fs.FSWatcher;
    const watcher = watchVault(vault, () => {
      callCount++;
    }, 20, { watch: () => silent, armCatchupMs: 50 });
    try {
      write('during-arm.md', 'landed in the blind window');
      await vi.waitFor(() => {
        expect(callCount).toBeGreaterThan(0);
      }, { timeout: 3000 });
    } finally {
      watcher.close();
    }
  });

  it('does not notify after arming when nothing changed', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const silent = {
      on: () => silent,
      close: () => undefined,
      unref: () => silent,
      ref: () => silent,
    } as unknown as fs.FSWatcher;
    const watcher = watchVault(vault, () => {
      callCount++;
    }, 20, { watch: () => silent, armCatchupMs: 50 });
    try {
      // Fake timers: the point is that the post-arm check runs and stays silent,
      // so the catch-up must be advanced deterministically rather than slept on.
      await vi.advanceTimersByTimeAsync(200);
      expect(callCount).toBe(0);
    } finally {
      watcher.close();
      vi.useRealTimers();
    }
  });

  it('fails open when directory does not exist or is invalid', () => {
    const watcher = watchVault(path.join(outside, 'non-existent'), () => undefined);
    expect(() => watcher.close()).not.toThrow();
  });
});

