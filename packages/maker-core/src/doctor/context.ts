/**
 * Real Node runtime context for `@cindy/maker-core/doctor` (ROADMAP 14.2, blueprint §2).
 *
 * Works with the Cindy desktop app closed or running. Zero Electron imports.
 */

import { execFile } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeEndpoint } from '../providers/discovery.js';
import type { DoctorContext, DoctorExecResult, DoctorPaths } from './types.js';

const USER_DATA_DIR_NAME = 'CindyGlobal-dev2-private';
const DAILY_HERMES_LEAF = ['.', 'hermes'].join('');
const DEFAULT_HERMES_LEAF = '.hermes-cindy';
const DEFAULT_HARNESS_LEAF = '.cindy-harness';

export interface CreateNodeContextOptions {
  home?: string;
  hermesHome?: string;
  harnessDir?: string;
  userDataDir?: string;
  repoRoot?: string;
  socketPath?: string;
  appRunning?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  hermesPinnedVersion?: string;
  pnpmPinnedVersion?: string;
  signal?: AbortSignal;
}

function defaultRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function defaultUserDataDirForHome(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', USER_DATA_DIR_NAME);
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, USER_DATA_DIR_NAME);
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, USER_DATA_DIR_NAME);
}

function normalizePathForCompare(target: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(target);
  return platform === 'darwin' || platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Returns true if `candidate` resolves to or inside a user's daily Hermes home
 * directory. Never construct daily-home references in user-facing output.
 */
export function isDailyHermesPath(
  candidate: string,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizePathForCompare(candidate, platform);
  const homes = new Set([home, os.homedir()].filter(Boolean));
  for (const h of homes) {
    const daily = normalizePathForCompare(path.join(h, DAILY_HERMES_LEAF), platform);
    if (normalized === daily || normalized.startsWith(daily + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Fail closed if `hermesHome` points at or inside the daily Hermes home. */
export function assertNotDailyHermes(hermesHome: string, home: string = os.homedir()): void {
  if (isDailyHermesPath(hermesHome, home)) {
    throw new Error('refusing to touch the daily Hermes home; must use isolated .hermes-cindy');
  }
}

export function resolveDefaultPaths(options: CreateNodeContextOptions = {}): DoctorPaths {
  const env = options.env ?? process.env;
  const home = path.resolve(options.home ?? env.HOME ?? os.homedir());
  const hermesHome = path.resolve(options.hermesHome ?? path.join(home, DEFAULT_HERMES_LEAF));
  const harnessDir = path.resolve(options.harnessDir ?? path.join(home, DEFAULT_HARNESS_LEAF));
  const userDataDir = path.resolve(
    options.userDataDir ??
      (!options.home && env.XDT_USER_DATA_DIR ? env.XDT_USER_DATA_DIR : defaultUserDataDirForHome(home, process.platform, env)),
  );
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot());

  return {
    home,
    hermesHome,
    harnessDir,
    userDataDir,
    repoRoot,
    ...(options.socketPath ? { socketPath: path.resolve(options.socketPath) } : {}),
  };
}

function readPinnedPnpmVersionFromRepo(repoRoot: string): string | undefined {
  try {
    const raw = fsSync.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { packageManager?: unknown };
    if (typeof pkg.packageManager === 'string') {
      const m = pkg.packageManager.match(/^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      if (m) return m[1];
    }
  } catch {
    // ignore; check handles missing pin gracefully
  }
  return undefined;
}

function readPinnedHermesVersionFromRepo(repoRoot: string): string | undefined {
  try {
    const src = fsSync.readFileSync(
      path.join(repoRoot, 'packages', 'maker-hermes-manager', 'src', 'hermes-version.ts'),
      'utf8',
    );
    const m = src.match(/HERMES_CLI_PINNED_VERSION\s*=\s*['"](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)['"]/);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return undefined;
}

function createExecAdapter(env: Readonly<Record<string, string | undefined>>, signal: AbortSignal) {
  return function execCommand(
    cmd: string,
    args: string[],
    opts: { timeoutMs: number },
  ): Promise<DoctorExecResult> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ code: null, stdout: '', stderr: 'aborted' });
        return;
      }
      try {
        execFile(
          cmd,
          args,
          {
            encoding: 'utf8',
            timeout: Math.max(1, opts.timeoutMs),
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: env as NodeJS.ProcessEnv,
            signal,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
              return;
            }
            const errObj = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
            const numericCode = typeof errObj.code === 'number' ? errObj.code : null;
            const stderrText =
              stderr && stderr.trim().length > 0
                ? stderr
                : errObj.killed
                  ? `command timed out after ${opts.timeoutMs} ms`
                  : error.message;
            resolve({ code: numericCode, stdout: stdout ?? '', stderr: stderrText });
          },
        );
      } catch (err) {
        resolve({
          code: null,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };
}

function loadSqliteInMemory(): void {
  const req = createRequire(import.meta.url);
  const Database = req('better-sqlite3') as new (file: string) => { close(): void };
  const db = new Database(':memory:');
  db.close();
}

export function createNodeContext(options: CreateNodeContextOptions = {}): DoctorContext {
  const env = options.env ?? process.env;
  const paths = resolveDefaultPaths({ ...options, env });
  const signal = options.signal ?? new AbortController().signal;

  return {
    paths,
    fs: {
      readFile: fs.readFile,
      stat: fs.stat,
      readdir: fs.readdir,
      access: fs.access,
    },
    exec: createExecAdapter(env, signal),
    probe: probeEndpoint,
    now: () => new Date(),
    signal,
    ...(options.appRunning !== undefined ? { appRunning: options.appRunning } : {}),
    host: {
      node: process.versions.node,
      platform: process.platform,
    },
    env,
    platform: process.platform,
    arch: process.arch,
    hermesPinnedVersion: options.hermesPinnedVersion ?? readPinnedHermesVersionFromRepo(paths.repoRoot),
    pnpmPinnedVersion: options.pnpmPinnedVersion ?? readPinnedPnpmVersionFromRepo(paths.repoRoot),
    statfs: async (targetPath: string) => {
      const stats = await fs.statfs(targetPath);
      return { bavail: Number(stats.bavail), bsize: Number(stats.bsize) };
    },
    loadNativeSqlite: loadSqliteInMemory,
  };
}
