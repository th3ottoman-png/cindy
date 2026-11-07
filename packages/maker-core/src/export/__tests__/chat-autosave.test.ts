import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AUTOSAVE_FOLDER,
  autosaveFileName,
  checkAutosaveFolder,
  findAutosaveFile,
  readAutosaveConfig,
  writeAutosaveConfig,
  writeChatAutosave,
} from '../chat-autosave';
import type { ExportSession } from '../session-markdown';

const SID = '1A2B3C4D-5e6f-7a8b-9c0d-ef0123456789';
const T1 = new Date('2026-11-07T10:00:00Z');
const T2 = new Date('2026-11-08T11:00:00Z');

function session(title: string, extra: string[] = []): ExportSession {
  return {
    title,
    agent: 'hermes',
    model: 'deepseek-flash',
    messages: [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
      ...extra.map((text) => ({ role: 'user' as const, text })),
    ],
  };
}

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-autosave-'));
  vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('checkAutosaveFolder (ROADMAP 5.5)', () => {
  it('accepts relative folders and normalises slashes', () => {
    expect(checkAutosaveFolder(' Cindy/Chats/ ')).toEqual({ ok: true, folder: 'Cindy/Chats' });
    expect(checkAutosaveFolder('./a\\b')).toEqual({ ok: true, folder: 'a/b' });
  });

  it('refuses absolute, parent and empty paths', () => {
    for (const bad of ['', '   ', '/etc', 'C:/x', '../out', 'a/../../b', 'a//b', 'a/./b']) {
      expect(checkAutosaveFolder(bad).ok, bad).toBe(false);
    }
  });
});

describe('auto-save config file', () => {
  it('is off with the default folder when the file is missing', () => {
    expect(readAutosaveConfig(path.join(tmp, 'none.json'))).toEqual({
      config: { enabled: false, folder: DEFAULT_AUTOSAVE_FOLDER },
    });
  });

  it('round-trips through an atomic write and leaves no temp file', () => {
    const file = path.join(tmp, 'h', 'chat-autosave.json');
    writeAutosaveConfig(file, { enabled: true, folder: 'Notes/Chats/' });
    expect(readAutosaveConfig(file)).toEqual({ config: { enabled: true, folder: 'Notes/Chats' } });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['chat-autosave.json']);
  });

  it('refuses to write a folder that escapes the vault', () => {
    const file = path.join(tmp, 'chat-autosave.json');
    expect(() => writeAutosaveConfig(file, { enabled: true, folder: '../x' })).toThrow(/invalid auto-save folder/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('fails closed (off) on a hand-edited bad folder, and reports bad JSON', () => {
    const file = path.join(tmp, 'c.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, folder: '/tmp/out' }));
    const read = readAutosaveConfig(file);
    expect(read.config.enabled).toBe(false);
    expect(read.issue).toMatch(/relative/);
    fs.writeFileSync(file, '{oops');
    expect(readAutosaveConfig(file).issue).toMatch(/not valid JSON/);
  });
});

describe('writeChatAutosave', () => {
  it('creates one file named date + slug + short id, with session_id and autosave in the frontmatter', () => {
    const res = writeChatAutosave(vault, 'Cindy/Chats', SID, session('Fix the login bug'), T1);
    expect(res).toMatchObject({ ok: true, created: true });
    if (!res.ok) return;
    expect(path.basename(res.path)).toBe('2026-11-07-fix-the-login-bug-1a2b3c4d.md');
    expect(path.dirname(res.path)).toBe(path.join(fs.realpathSync(vault), 'Cindy', 'Chats'));
    const text = fs.readFileSync(res.path, 'utf8');
    expect(text.startsWith(`---\nsession_id: "${SID}"\nautosave: true\ntitle: "Fix the login bug"\n`)).toBe(true);
    expect(text).toContain('## User\n\nhello');
  });

  it('rewrites the same file after a title change and a later day, never a second file', () => {
    const first = writeChatAutosave(vault, 'Cindy/Chats', SID, session('Old title'), T1);
    const second = writeChatAutosave(vault, 'Cindy/Chats', SID, session('New title', ['one more']), T2);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.path).toBe(first.path);
    expect(second.created).toBe(false);
    const dir = path.dirname(first.path);
    expect(fs.readdirSync(dir)).toEqual([path.basename(first.path)]);
    const text = fs.readFileSync(first.path, 'utf8');
    expect(text).toContain('title: "New title"');
    expect(text).toContain('one more');
    expect(text).toContain(`exported: ${T2.toISOString()}`);
  });

  it('does not adopt a file that only shares the short id', () => {
    const dir = path.join(vault, 'Cindy', 'Chats');
    fs.mkdirSync(dir, { recursive: true });
    const decoy = path.join(dir, '2026-01-01-other-1a2b3c4d.md');
    fs.writeFileSync(decoy, '---\nsession_id: "1a2b3c4d-other"\n---\nmine\n');
    const res = writeChatAutosave(vault, 'Cindy/Chats', SID, session('Mine'), T1);
    expect(res.ok && res.path !== decoy).toBe(true);
    expect(fs.readFileSync(decoy, 'utf8')).toBe('---\nsession_id: "1a2b3c4d-other"\n---\nmine\n');
    expect(findAutosaveFile(fs.realpathSync(dir), SID)).toBe(res.ok ? res.path : undefined);
  });

  it('keeps two sessions in two files', () => {
    const a = writeChatAutosave(vault, 'C', 'aaaaaaaa-1', session('Same'), T1);
    const b = writeChatAutosave(vault, 'C', 'bbbbbbbb-2', session('Same'), T1);
    expect(a.ok && b.ok && a.path !== b.path).toBe(true);
  });

  it('is quietly off when no vault is configured or the vault folder is missing', () => {
    expect(writeChatAutosave('', 'C', SID, session('x'), T1)).toMatchObject({ ok: false, reason: 'no-vault' });
    expect(writeChatAutosave(path.join(tmp, 'gone'), 'C', SID, session('x'), T1)).toMatchObject({
      ok: false,
      reason: 'no-vault',
    });
    expect(fs.existsSync(path.join(tmp, 'gone'))).toBe(false);
  });

  it('refuses a folder that escapes the vault, by path or by symlink', () => {
    expect(writeChatAutosave(vault, '../out', SID, session('x'), T1)).toMatchObject({ ok: false, reason: 'bad-folder' });
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(vault, 'link'));
    expect(writeChatAutosave(vault, 'link/Chats', SID, session('x'), T1)).toMatchObject({ ok: false, reason: 'bad-folder' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('redacts credentials like the 5.2 export', () => {
    const res = writeChatAutosave(vault, 'C', SID, { ...session('k'), messages: [{ role: 'user', text: 'key sk-abcdefghijklmnopqrstuvwx' }] }, T1);
    expect(res.ok && fs.readFileSync(res.path, 'utf8')).toContain('[redacted]');
  });
});

describe('autosaveFileName', () => {
  it('falls back to "session" for an id with no letters or digits', () => {
    expect(autosaveFileName('', T1, '---')).toBe('2026-11-07-session-session.md');
  });
});
