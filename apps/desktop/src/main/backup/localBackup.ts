/**
 * Local backup / restore (ROADMAP 0.11).
 *
 * One dated .tar.gz holding:
 *   userdata/   the Cindy SQLite DB(s) (`<prefix>-<ownerId>.db`), snapshotted with sqlite3 `.backup`
 *   hermes/     ~/.hermes-cindy minus caches, installs, logs and credentials
 *   experts/    the experts directory (~/.cindy-harness/experts), when present
 *   manifest.json
 *
 * Deliberately Node-only (no Electron imports, no TS-only syntax) so scripts/cindy-backup.mjs can
 * run it directly and the Settings IPC handler can call the same code.
 * Credentials (`.env`, `auth.json`) are never archived: AGENTS.md forbids persisting provider keys.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const BACKUP_FORMAT_VERSION = 1;

/** Top-level entries of the Hermes home that are caches/derived/ephemeral. */
export const HERMES_EXCLUDED = [
  'cache',
  'installs',
  'logs',
  'audio_cache',
  'image_cache',
  'models_dev_cache.json',
  'plugin-update-checks',
  'source-checks',
  'backups',
  'runtime',
  'terminal-sessions',
  'worker-outboxes',
  'pending_messages',
];
/** Credential files: never archived. */
export const HERMES_SECRET_FILES = ['.env', 'auth.json', 'auth.lock'];

export interface BackupPaths {
  /** Electron userData dir holding `<dbFilePrefix>-<ownerId>.db`. */
  userDataDir: string;
  hermesHome: string;
  expertsDir: string;
}

export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  sections: Array<'userdata' | 'hermes' | 'experts'>;
  dbFiles: string[];
  excludedSecrets: string[];
  hermesExcluded: string[];
}

export function defaultBackupPaths(home: string = os.homedir()): BackupPaths {
  return {
    userDataDir: path.join(home, 'Library', 'Application Support', 'CindyGlobal-dev2-private'),
    hermesHome: path.join(home, '.hermes-cindy'),
    expertsDir: path.join(home, '.cindy-harness', 'experts'),
  };
}

/** Fail closed: the daily Hermes home must never be read or written. */
export function assertNotDailyHermes(hermesHome: string, home: string = os.homedir()): void {
  const resolved = path.resolve(hermesHome);
  const daily = path.join(home, '.hermes');
  if (resolved === daily || resolved.startsWith(daily + path.sep)) {
    throw new Error(`refusing to touch the daily Hermes home (${daily})`);
  }
}

const stamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function copyTree(src: string, dest: string, skipTop: (name: string) => boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skipTop(name)) continue;
    const from = path.join(src, name);
    const st = fs.lstatSync(from);
    if (st.isSocket() || st.isFIFO()) continue;
    fs.cpSync(from, path.join(dest, name), {
      recursive: true,
      filter: (p) => {
        const s = fs.lstatSync(p);
        return !(s.isSocket() || s.isFIFO());
      },
    });
  }
}

function snapshotSqlite(src: string, dest: string): void {
  try {
    execFileSync('sqlite3', [src, `.backup '${dest.replace(/'/g, "''")}'`], { stdio: 'pipe' });
  } catch {
    // No sqlite3 CLI: fall back to a plain file copy (consistent only if the app is closed).
    fs.copyFileSync(src, dest);
    return;
  }
  try {
    // `.backup` keeps the source's WAL mode, so the snapshot grows its own -wal/-shm.
    // Switch the copy to rollback journaling: checkpoints it and leaves one self-contained file.
    execFileSync('sqlite3', [dest, 'pragma journal_mode=delete;'], { stdio: 'pipe' });
  } catch {
    // Snapshot is already valid; leftover sidecars are only the copy's own.
  }
  // The copy's own sidecars may linger (an empty -shm). Drop them only when nothing is in the WAL.
  const wal = `${dest}-wal`;
  if (!fs.existsSync(wal) || fs.statSync(wal).size === 0) {
    fs.rmSync(wal, { force: true });
    fs.rmSync(`${dest}-shm`, { force: true });
  }
}

export interface CreateBackupOptions {
  paths: BackupPaths;
  outDir: string;
  /** DB file name prefix, e.g. BRAND_IDENTITY.dbFilePrefix. Default `xdt-maker`. */
  dbFilePrefix?: string;
  now?: Date;
}

export function createBackup(opts: CreateBackupOptions): {
  archivePath: string;
  manifest: BackupManifest;
} {
  const { paths } = opts;
  assertNotDailyHermes(paths.hermesHome);
  const now = opts.now ?? new Date();
  const prefix = opts.dbFilePrefix ?? 'xdt-maker';
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-backup-'));
  try {
    const sections: BackupManifest['sections'] = [];
    const dbFiles: string[] = [];

    if (fs.existsSync(paths.userDataDir)) {
      const dbs = fs
        .readdirSync(paths.userDataDir)
        .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.db'));
      if (dbs.length) {
        fs.mkdirSync(path.join(staging, 'userdata'));
        for (const db of dbs) {
          snapshotSqlite(path.join(paths.userDataDir, db), path.join(staging, 'userdata', db));
          dbFiles.push(db);
        }
        sections.push('userdata');
      }
    }
    if (fs.existsSync(paths.hermesHome)) {
      const isSqliteSidecar = (n: string): boolean => /\.db-(wal|shm)$/.test(n);
      copyTree(
        paths.hermesHome,
        path.join(staging, 'hermes'),
        (n) =>
          HERMES_EXCLUDED.includes(n) ||
          HERMES_SECRET_FILES.includes(n) ||
          n.includes('.bak-') ||
          isSqliteSidecar(n),
      );
      // Hermes's own SQLite files (state.db, kanban.db, ...): replace the plain copy with a
      // consistent snapshot so a live WAL is never archived half-written.
      for (const n of fs.readdirSync(paths.hermesHome)) {
        if (n.endsWith('.db')) {
          snapshotSqlite(path.join(paths.hermesHome, n), path.join(staging, 'hermes', n));
        }
      }
      sections.push('hermes');
    }
    if (fs.existsSync(paths.expertsDir)) {
      copyTree(paths.expertsDir, path.join(staging, 'experts'), () => false);
      sections.push('experts');
    }

    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: now.toISOString(),
      sections,
      dbFiles,
      excludedSecrets: HERMES_SECRET_FILES,
      hermesExcluded: HERMES_EXCLUDED,
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    fs.mkdirSync(opts.outDir, { recursive: true });
    const archivePath = path.join(opts.outDir, `cindy-backup-${stamp(now)}.tar.gz`);
    execFileSync('tar', ['-czf', archivePath, '-C', staging, '.'], { stdio: 'pipe' });
    return { archivePath, manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export interface RestoreBackupOptions {
  archive: string;
  paths: BackupPaths;
  now?: Date;
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** Existing entries renamed aside (never deleted) before being replaced. */
  movedAside: string[];
  restored: string[];
}

/** Restores each archived top-level entry; whatever it replaces is renamed to `<name>.pre-restore-<stamp>`. */
export function restoreBackup(opts: RestoreBackupOptions): RestoreResult {
  const { paths } = opts;
  assertNotDailyHermes(paths.hermesHome);
  const now = opts.now ?? new Date();
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-restore-'));
  try {
    execFileSync('tar', ['-xzf', opts.archive, '-C', staging], { stdio: 'pipe' });
    const manifestPath = path.join(staging, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('not a Cindy backup: manifest.json missing');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
      throw new Error(`unsupported backup format ${manifest.formatVersion}`);
    }
    const targets: Record<string, string> = {
      userdata: paths.userDataDir,
      hermes: paths.hermesHome,
      experts: paths.expertsDir,
    };
    const movedAside: string[] = [];
    const restored: string[] = [];
    const tag = `.pre-restore-${stamp(now)}`;
    for (const section of manifest.sections) {
      const from = path.join(staging, section);
      const to = targets[section];
      if (!to || !fs.existsSync(from)) continue;
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        const dest = path.join(to, name);
        if (fs.existsSync(dest)) {
          fs.renameSync(dest, dest + tag);
          movedAside.push(dest + tag);
        }
        if (section === 'userdata') {
          // A restored DB must not inherit the old DB's WAL/SHM.
          for (const ext of ['-wal', '-shm']) {
            if (fs.existsSync(dest + ext)) {
              fs.renameSync(dest + ext, dest + ext + tag);
              movedAside.push(dest + ext + tag);
            }
          }
        }
        fs.cpSync(path.join(from, name), dest, { recursive: true });
        restored.push(dest);
      }
    }
    return { manifest, movedAside, restored };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
