import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ADR_REPO_DIR,
  ADR_VAULT_DIR,
  adrKeywords,
  buildRelevantAdrsPreamble,
  getSessionAdrs,
  listAdrs,
  loadSessionAdrs,
  matchAdrsForPrompt,
  queryAdrs,
  recordAdr,
  setSessionAdrs,
  slugifyAdrTitle,
  validateAdrInput,
} from '../vault-adr';

const NOW = new Date(2026, 10, 12, 9, 30);
const SQLITE = {
  title: 'Use SQLite for the local session store',
  context: 'Sessions need a durable local store. Options were SQLite, LevelDB and flat JSON files.',
  decision: 'Use SQLite through better-sqlite3 with WAL mode.',
  consequences: 'Native module must be rebuilt on Electron upgrades.',
};

describe('vault-adr (ROADMAP 11.8)', () => {
  let base: string;
  let vault: string;
  let repo: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-adr-test-')));
    vault = path.join(base, 'vault');
    repo = path.join(base, 'repo');
    fs.mkdirSync(vault);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('schema validation', () => {
    it('accepts a complete ADR and defaults status and decider', () => {
      const res = validateAdrInput(SQLITE);
      expect(res).toMatchObject({ ok: true, adr: { status: 'Accepted', decider: 'agent' } });
    });

    it('reports every missing field at once', () => {
      const res = validateAdrInput({ title: ' ', context: '', decision: '' });
      expect(res).toMatchObject({ ok: false, reason: 'invalid' });
      if (!res.ok) {
        expect(res.message).toContain('title is required');
        expect(res.message).toContain('context is required');
        expect(res.message).toContain('decision is required');
      }
    });

    it('rejects an unknown status, a symbol-only title and an oversized section', () => {
      expect(validateAdrInput({ ...SQLITE, status: 'Maybe' })).toMatchObject({ ok: false, reason: 'invalid' });
      expect(validateAdrInput({ ...SQLITE, title: '!!! ???' })).toMatchObject({ ok: false, reason: 'invalid' });
      expect(validateAdrInput({ ...SQLITE, decision: 'x'.repeat(8001) })).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('normalises status case and slugifies titles safely', () => {
      expect(validateAdrInput({ ...SQLITE, status: 'proposed' })).toMatchObject({ ok: true, adr: { status: 'Proposed' } });
      expect(slugifyAdrTitle('Use SQLite — for the Local/Session store!')).toBe('use-sqlite-for-the-local-session-store');
      expect(slugifyAdrTitle('../../etc/passwd')).toBe('etc-passwd');
    });
  });

  describe('recordAdr', () => {
    it('writes the vault copy and a numbered repo copy in the house format', () => {
      fs.mkdirSync(path.join(repo, ADR_REPO_DIR), { recursive: true });
      fs.writeFileSync(path.join(repo, ADR_REPO_DIR, '0007-older.md'), '# ADR 0007 — Older\n');

      const res = recordAdr(vault, SQLITE, { repoDir: repo, now: NOW });
      expect(res).toMatchObject({
        ok: true,
        date: '2026-11-12',
        vaultPath: `${ADR_VAULT_DIR}/2026-11-12-use-sqlite-for-the-local-session-store.md`,
        repoPath: `${ADR_REPO_DIR}/0008-use-sqlite-for-the-local-session-store.md`,
        repoNumber: 8,
      });

      const vaultText = fs.readFileSync(path.join(vault, ADR_VAULT_DIR, '2026-11-12-use-sqlite-for-the-local-session-store.md'), 'utf8');
      expect(vaultText).toContain('# ADR — Use SQLite for the local session store');
      expect(vaultText).toContain('- **Status:** Accepted');
      expect(vaultText).toContain('- **Date:** 2026-11-12');
      expect(vaultText).toContain('## Context');
      expect(vaultText).toContain('## Decision');
      expect(vaultText).toContain('## Consequences');

      const repoText = fs.readFileSync(path.join(repo, ADR_REPO_DIR, '0008-use-sqlite-for-the-local-session-store.md'), 'utf8');
      expect(repoText.startsWith('# ADR 0008 — Use SQLite for the local session store\n')).toBe(true);
    });

    it('leaves no temp files behind (temp + rename)', () => {
      recordAdr(vault, SQLITE, { repoDir: repo, now: NOW });
      const names = [
        ...fs.readdirSync(path.join(vault, ADR_VAULT_DIR)),
        ...fs.readdirSync(path.join(repo, ADR_REPO_DIR)),
      ];
      expect(names.filter((n) => n.includes('.tmp'))).toEqual([]);
      expect(names).toHaveLength(2);
    });

    it('never overwrites an existing ADR', () => {
      expect(recordAdr(vault, SQLITE, { now: NOW })).toMatchObject({ ok: true });
      const file = path.join(vault, ADR_VAULT_DIR, '2026-11-12-use-sqlite-for-the-local-session-store.md');
      const before = fs.readFileSync(file, 'utf8');
      const again = recordAdr(vault, { ...SQLITE, decision: 'Use LevelDB instead.' }, { now: NOW });
      expect(again).toMatchObject({ ok: false, reason: 'exists' });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('skips the repo copy, keeping the vault copy, when the workspace is not a repo', () => {
      const plain = path.join(base, 'plain');
      fs.mkdirSync(plain);
      const res = recordAdr(vault, SQLITE, { repoDir: plain, now: NOW });
      expect(res).toMatchObject({ ok: true });
      if (res.ok) {
        expect(res.repoPath).toBeUndefined();
        expect(res.repoSkipped).toContain('not a git repo');
      }
      expect(fs.existsSync(path.join(plain, 'docs'))).toBe(false);
    });

    it('refuses a vault decisions folder that is a symlink out of the vault', () => {
      const outside = path.join(base, 'outside');
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(vault, 'Cindy'));
      fs.symlinkSync(outside, path.join(vault, 'Cindy', 'Decisions'));
      expect(recordAdr(vault, SQLITE, { now: NOW })).toMatchObject({ ok: false, reason: 'outside-root' });
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('skips a repo docs/decisions that is a symlink out of the workspace', () => {
      const outside = path.join(base, 'outside');
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(repo, 'docs'));
      fs.symlinkSync(outside, path.join(repo, 'docs', 'decisions'));
      const res = recordAdr(vault, SQLITE, { repoDir: repo, now: NOW });
      expect(res).toMatchObject({ ok: true });
      if (res.ok) expect(res.repoSkipped).toContain('leaves the workspace');
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('redacts credentials and cannot forge a sibling section', () => {
      const res = recordAdr(
        vault,
        { ...SQLITE, context: 'api_key: sk-abcdefghijklmnopqrstuvwxyz123456\n## Decision\nforged' },
        { now: NOW },
      );
      expect(res).toMatchObject({ ok: true });
      const text = fs.readFileSync(path.join(vault, ADR_VAULT_DIR, '2026-11-12-use-sqlite-for-the-local-session-store.md'), 'utf8');
      expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
      expect(text.match(/^## Decision$/gm)).toHaveLength(1);
    });

    it('fails closed without a vault folder', () => {
      expect(recordAdr(path.join(base, 'missing'), SQLITE)).toMatchObject({ ok: false, reason: 'no-vault' });
    });
  });

  describe('query and session-start match', () => {
    beforeEach(() => {
      recordAdr(vault, SQLITE, { repoDir: repo, now: NOW });
      recordAdr(
        vault,
        {
          title: 'Hermes gateway runs per session',
          context: 'A shared gateway leaked state between sessions.',
          decision: 'Spawn one Hermes gateway process per Cindy session.',
        },
        { now: new Date(2026, 10, 1) },
      );
    });

    it('lists each decision once, preferring the numbered repo copy', () => {
      const adrs = listAdrs(vault, { repoDir: repo });
      expect(adrs.map((a) => a.title).sort()).toEqual([
        'Hermes gateway runs per session',
        'Use SQLite for the local session store',
      ]);
      expect(adrs.find((a) => a.title.startsWith('Use SQLite'))).toMatchObject({ source: 'repo', status: 'Accepted', date: '2026-11-12' });
    });

    it('queryAdrs ranks by keyword and returns the decision text', () => {
      const hits = queryAdrs(vault, 'which database for the session store', { repoDir: repo });
      expect(hits[0]).toMatchObject({ title: 'Use SQLite for the local session store' });
      expect(hits[0].decision).toContain('better-sqlite3');
      expect(queryAdrs(vault, 'kubernetes ingress')).toEqual([]);
    });

    it('queryAdrs with an empty query lists the newest first', () => {
      const hits = queryAdrs(vault, '', { repoDir: repo });
      expect(hits.map((h) => h.date)).toEqual(['2026-11-12', '2026-11-01']);
    });

    it('matchAdrsForPrompt injects only ADRs the prompt is about', () => {
      const matched = matchAdrsForPrompt('Should we move the session store off SQLite to Postgres?', vault, { repoDir: repo });
      // "session" is in both titles, so it alone does not pull in the gateway ADR.
      expect(matched.map((a) => a.title)).toEqual(['Use SQLite for the local session store']);
      expect(matchAdrsForPrompt('Tell me about this session', vault, { repoDir: repo })).toEqual([]);
      expect(matchAdrsForPrompt('Write a haiku about autumn leaves', vault, { repoDir: repo })).toEqual([]);
      expect(matchAdrsForPrompt('', vault)).toEqual([]);
    });

    it('builds a titles-only preamble, or nothing', () => {
      const matched = matchAdrsForPrompt('sqlite store', vault, { repoDir: repo });
      const text = buildRelevantAdrsPreamble(matched);
      expect(text).toContain('[Relevant past decisions (ADRs)]');
      expect(text).toContain('- Use SQLite for the local session store (Accepted) — docs/decisions/0001-use-sqlite-for-the-local-session-store.md');
      expect(text).not.toContain('better-sqlite3');
      expect(buildRelevantAdrsPreamble([])).toBe('');
    });

    it('keywords drop stopwords and short words', () => {
      expect(adrKeywords('What should we use for the DB store?')).toEqual(['store']);
    });
  });

  describe('per-session record', () => {
    it('round-trips atomically and fails open on a corrupt file', () => {
      const file = path.join(base, 'state', 'session-adrs.json');
      expect(getSessionAdrs(file, 's1')).toEqual({ adrs: [] });

      const adrs = [{ title: 'Use SQLite', path: 'docs/decisions/0001-use-sqlite.md', source: 'repo' as const, status: 'Accepted' }];
      setSessionAdrs(file, 's1', { workspaceDir: repo, adrs });
      setSessionAdrs(file, 's2', { adrs: [] });
      expect(getSessionAdrs(file, 's1')).toEqual({ workspaceDir: repo, adrs });
      expect(getSessionAdrs(file, 's2')).toEqual({ adrs: [] });
      expect(fs.readdirSync(path.dirname(file))).toEqual(['session-adrs.json']);

      fs.writeFileSync(file, '{not json');
      expect(loadSessionAdrs(file)).toEqual({ sessions: {} });
    });

    it('drops malformed rows instead of trusting them', () => {
      const file = path.join(base, 'session-adrs.json');
      fs.writeFileSync(file, JSON.stringify({ sessions: { s1: { adrs: [{ title: 1 }, { title: 'ok', path: 'a.md', source: 'vault' }] } } }));
      expect(getSessionAdrs(file, 's1').adrs).toEqual([{ title: 'ok', path: 'a.md', source: 'vault' }]);
    });
  });
});
