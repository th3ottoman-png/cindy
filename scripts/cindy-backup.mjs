#!/usr/bin/env node
/**
 * Local backup / restore CLI (ROADMAP 0.11). Thin wrapper over
 * apps/desktop/src/main/backup/localBackup.ts, which Node 22 loads directly (type stripping).
 *
 *   pnpm backup:create  [--out <dir>] [--user-data <dir>] [--hermes-home <dir>] [--experts <dir>]
 *   pnpm backup:restore <archive.tar.gz> [--user-data <dir>] [--hermes-home <dir>] [--experts <dir>]
 *
 * Quit Cindy before restoring. Restore renames whatever it replaces to `<name>.pre-restore-<stamp>`
 * (nothing is deleted). Credentials (`.env`, `auth.json`) are never archived or restored.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(path.join(root, 'apps/desktop/src/main/backup/localBackup.ts'));

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}

const defaults = mod.defaultBackupPaths();
const paths = {
  userDataDir: flags['user-data'] ?? defaults.userDataDir,
  hermesHome: flags['hermes-home'] ?? defaults.hermesHome,
  expertsDir: flags.experts ?? defaults.expertsDir,
};

try {
  if (cmd === 'create') {
    const outDir = flags.out ?? path.join(os.homedir(), '.cindy-harness', 'backups');
    const { archivePath, manifest } = mod.createBackup({ paths, outDir });
    console.log(`backup written: ${archivePath}`);
    console.log(`sections: ${manifest.sections.join(', ') || '(none)'}; db files: ${manifest.dbFiles.join(', ') || '(none)'}`);
  } else if (cmd === 'restore') {
    const archive = positional[0];
    if (!archive) throw new Error('usage: backup:restore <archive.tar.gz>');
    const r = mod.restoreBackup({ archive: path.resolve(archive), paths });
    console.log(`restored ${r.restored.length} entries from backup created ${r.manifest.createdAt}`);
    for (const p of r.movedAside) console.log(`  moved aside: ${p}`);
  } else {
    throw new Error('usage: cindy-backup.mjs create|restore [options]');
  }
} catch (err) {
  console.error(`cindy-backup: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
