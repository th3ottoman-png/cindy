import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNotDailyHermes,
  createBackup,
  restoreBackup,
  type BackupPaths,
} from '../localBackup';

const roots: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-backup-test-'));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function sqlite(db: string, sql: string): string {
  return execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();
}

function fixture(root: string): BackupPaths {
  const paths: BackupPaths = {
    userDataDir: path.join(root, 'userData'),
    hermesHome: path.join(root, 'hermes-cindy'),
    expertsDir: path.join(root, 'harness', 'experts'),
  };
  fs.mkdirSync(paths.userDataDir, { recursive: true });
  sqlite(
    path.join(paths.userDataDir, 'xdt-maker-u1.db'),
    "create table t(v text); insert into t values ('original');",
  );
  fs.writeFileSync(path.join(paths.userDataDir, 'Preferences'), 'not-a-db');
  fs.mkdirSync(path.join(paths.hermesHome, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(paths.hermesHome, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(paths.hermesHome, 'config.yaml'), 'model:\n  default: m1\n');
  fs.writeFileSync(path.join(paths.hermesHome, 'skills', 's.md'), 'skill');
  fs.writeFileSync(path.join(paths.hermesHome, 'cache', 'big.bin'), 'cache');
  sqlite(
    path.join(paths.hermesHome, 'state.db'),
    "pragma journal_mode=wal; create table s(v text); insert into s values ('hermes-original');",
  );
  fs.writeFileSync(path.join(paths.hermesHome, 'state.db-wal'), 'stale-wal-must-not-be-archived');
  fs.writeFileSync(path.join(paths.hermesHome, '.env'), 'DEEPSEEK_API_KEY=not-a-real-key');
  fs.writeFileSync(path.join(paths.hermesHome, 'auth.json'), '{"x":1}');
  fs.mkdirSync(path.join(paths.expertsDir, 'reviewer'), { recursive: true });
  fs.writeFileSync(
    path.join(paths.expertsDir, 'reviewer', 'expert.md'),
    '---\nname: reviewer\n---\n',
  );
  return paths;
}

describe('local backup / restore round trip', () => {
  it('archives DB, Hermes home and experts, excluding caches and credentials', () => {
    const root = tmp();
    const paths = fixture(root);
    const { archivePath, manifest } = createBackup({
      paths,
      outDir: path.join(root, 'out'),
      now: new Date('2026-10-29T12:00:00Z'),
    });

    expect(path.basename(archivePath)).toBe('cindy-backup-20261029T120000Z.tar.gz');
    expect(manifest.sections).toEqual(['userdata', 'hermes', 'experts']);
    expect(manifest.dbFiles).toEqual(['xdt-maker-u1.db']);

    const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
    expect(listing).toContain('hermes/config.yaml');
    expect(listing).toContain('hermes/skills/s.md');
    expect(listing).toContain('experts/reviewer/expert.md');
    expect(listing).toContain('userdata/xdt-maker-u1.db');
    expect(listing).toContain('hermes/state.db');
    expect(listing).not.toContain('state.db-wal');
    expect(listing).not.toContain('state.db-shm');
    expect(listing).not.toContain('Preferences');
    expect(listing).not.toContain('cache/big.bin');
    expect(listing).not.toContain('.env');
    expect(listing).not.toContain('auth.json');
  });

  it('restores from the archive, renaming (never deleting) what it replaces', () => {
    const root = tmp();
    const paths = fixture(root);
    const { archivePath } = createBackup({ paths, outDir: path.join(root, 'out') });

    // Damage everything the backup covers.
    sqlite(path.join(paths.userDataDir, 'xdt-maker-u1.db'), "update t set v='corrupted';");
    fs.writeFileSync(path.join(paths.hermesHome, 'config.yaml'), 'model:\n  default: WRONG\n');
    fs.rmSync(paths.expertsDir, { recursive: true });

    const result = restoreBackup({
      archive: archivePath,
      paths,
      now: new Date('2026-10-29T13:00:00Z'),
    });

    expect(sqlite(path.join(paths.userDataDir, 'xdt-maker-u1.db'), 'select v from t;')).toBe(
      'original',
    );
    expect(fs.readFileSync(path.join(paths.hermesHome, 'config.yaml'), 'utf8')).toContain(
      'default: m1',
    );
    expect(fs.existsSync(path.join(paths.expertsDir, 'reviewer', 'expert.md'))).toBe(true);
    expect(sqlite(path.join(paths.hermesHome, 'state.db'), 'select v from s;')).toBe(
      'hermes-original',
    );
    // Credentials and caches that were not archived are left exactly as they were.
    expect(fs.readFileSync(path.join(paths.hermesHome, '.env'), 'utf8')).toContain(
      'DEEPSEEK_API_KEY',
    );
    expect(fs.existsSync(path.join(paths.hermesHome, 'cache', 'big.bin'))).toBe(true);
    // The replaced files were moved aside, with their pre-restore content.
    const aside = result.movedAside.find((p) => p.includes('config.yaml'))!;
    expect(fs.readFileSync(aside, 'utf8')).toContain('WRONG');
    const dbAside = result.movedAside.find((p) =>
      p.endsWith('xdt-maker-u1.db.pre-restore-20261029T130000Z'),
    )!;
    expect(sqlite(dbAside, 'select v from t;')).toBe('corrupted');
  });

  it('rejects a non-backup archive', () => {
    const root = tmp();
    const paths = fixture(root);
    const junk = path.join(root, 'junk.tar.gz');
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    execFileSync('tar', ['-czf', junk, '-C', root, 'a.txt']);
    expect(() => restoreBackup({ archive: junk, paths })).toThrow(/manifest/);
  });

  it('refuses the daily Hermes home', () => {
    const home = tmp();
    expect(() => assertNotDailyHermes(path.join(home, '.hermes'), home)).toThrow(/daily Hermes/);
    expect(() => assertNotDailyHermes(path.join(home, '.hermes', 'x'), home)).toThrow(
      /daily Hermes/,
    );
    expect(() => assertNotDailyHermes(path.join(home, '.hermes-cindy'), home)).not.toThrow();
  });
});
