/**
 * Per-session HERMES_HOME (ADR 0004). Hermes expands `${VAR}` in MCP `env:` blocks from the
 * *gateway* process, and gateways are keyed by home, so one home per Cindy session gives each
 * session its own gateway (started by its `hermes chat` client with that session's env).
 *
 * Layout: `<baseHome>/session-homes/<id>-<hash>/`. Shared by symlink from the base home
 * (credentials are never copied): `.env`, `auth.json`, `SOUL.md`, `skills`, `plugins`,
 * `memories`, `installs` (the 597 MB venv: sharing it takes a home from ~1 GB to ~5 MB).
 * `config.yaml` is a generated regular file (Cindy's writers rename over files, which would
 * replace a link). State (`state.db`, sessions, logs, gateway files) stays per home, so a
 * Cindy session must always reuse its own home to resume.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const SESSION_HOMES_DIRNAME = 'session-homes';

/** Probed in 1.5b-5a: symlinks to these survive a Hermes client + gateway start unchanged. */
export const DEFAULT_SHARED_ITEMS: readonly string[] = [
  '.env',
  'auth.json',
  'SOUL.md',
  'skills',
  'plugins',
  'memories',
  'installs',
];

export interface SessionHomeOptions {
  /** Base-home entries shared by symlink. Defaults to DEFAULT_SHARED_ITEMS. */
  sharedItems?: readonly string[];
  /** Rewrites the per-session config.yaml text (1.5b-5c adds the shim entries here). */
  transformConfig?: (baseConfig: string, ctx: { sessionId: string; home: string }) => string;
  /** Test seam: the home that must never be used. Defaults to the user's daily Hermes home. */
  dailyHome?: string;
  /** Start the session's gateway at query/start so the first turn does not pay the cold start. Default true. */
  prewarmGateway?: boolean;
  /** Startup reap of homes no registered session owns: idle time before removal. Default 24 h. */
  orphanHomeMinAgeMs?: number;
}

export function sessionHomesRoot(baseHome: string): string {
  return path.join(baseHome, SESSION_HOMES_DIRNAME);
}

export function sessionHomePath(baseHome: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'session';
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 10);
  return path.join(sessionHomesRoot(baseHome), `${safe}-${hash}`);
}

function assertNotDailyHome(target: string, dailyHome?: string): void {
  const daily = dailyHome ?? path.join(os.homedir(), '.hermes');
  const resolved = path.resolve(target);
  if (resolved === daily || resolved.startsWith(`${daily}${path.sep}`)) {
    throw new Error(`refusing to use the daily Hermes home (${daily})`);
  }
}

async function lstatOrNull(target: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

export interface PreparedSessionHome {
  home: string;
  linked: string[];
  /** Entries left untouched because the session home already has its own real file or dir. */
  skipped: string[];
}

/** Idempotent; cheap enough to run on every turn so config changes reach the session. */
export async function prepareSessionHome(
  baseHome: string,
  sessionId: string,
  opts: SessionHomeOptions = {},
): Promise<PreparedSessionHome> {
  assertNotDailyHome(baseHome, opts.dailyHome);
  const home = sessionHomePath(baseHome, sessionId);
  assertNotDailyHome(home, opts.dailyHome);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });

  const linked: string[] = [];
  const skipped: string[] = [];
  for (const item of opts.sharedItems ?? DEFAULT_SHARED_ITEMS) {
    if (item.includes('/') || item.includes('\\') || item === '..' || item === 'config.yaml') {
      throw new Error(`invalid shared item: ${item}`);
    }
    const source = path.join(baseHome, item);
    const target = path.join(home, item);
    if (!(await lstatOrNull(source))) continue;
    const existing = await lstatOrNull(target);
    if (existing?.isSymbolicLink()) {
      if ((await fs.readlink(target)) === source) {
        linked.push(item);
        continue;
      }
      await fs.unlink(target);
    } else if (existing) {
      skipped.push(item);
      continue;
    }
    await fs.symlink(source, target);
    linked.push(item);
  }

  let baseConfig = '';
  try {
    baseConfig = await fs.readFile(path.join(baseHome, 'config.yaml'), 'utf8');
  } catch {
    // No base config: the session home starts with an empty one.
  }
  const text = opts.transformConfig ? opts.transformConfig(baseConfig, { sessionId, home }) : baseConfig;
  const configPath = path.join(home, 'config.yaml');
  const current = await lstatOrNull(configPath);
  if (current?.isSymbolicLink()) await fs.unlink(configPath);
  let same = false;
  if (current && !current.isSymbolicLink()) {
    same = (await fs.readFile(configPath, 'utf8').catch(() => null)) === text;
  }
  if (!same) {
    const tmp = path.join(home, `.config.yaml.${randomBytes(6).toString('hex')}.tmp`);
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, configPath);
  }
  return { home, linked, skipped };
}

/** Removes only a directory under `<baseHome>/session-homes/`; links are removed, never followed. */
export async function removeSessionHome(baseHome: string, sessionId: string): Promise<void> {
  const home = sessionHomePath(baseHome, sessionId);
  const rel = path.relative(sessionHomesRoot(baseHome), home);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('refusing to remove a path outside the session-homes root');
  }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

export interface GatewayProcessOps {
  isAlive(pid: number): boolean;
  commandOf(pid: number): Promise<string | null>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  sleep(ms: number): Promise<void>;
}

export const defaultGatewayProcessOps: GatewayProcessOps = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  commandOf(pid) {
    return new Promise((resolve) => {
      execFile('ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => {
        resolve(error ? null : stdout.trim() || null);
      });
    });
  },
  kill(pid, signal) {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type StopGatewayResult =
  | { stopped: true; forced: boolean }
  | {
      stopped: false;
      reason: 'no-pid-file' | 'not-a-gateway' | 'wrong-home' | 'not-running' | 'not-hermes' | 'timeout';
    };

/**
 * Stops the gateway recorded in `<home>/gateway.pid` (JSON: pid, kind, hermes_home) after
 * checking it really is a Hermes gateway for THIS home, so a stale pid file can never make us
 * signal an unrelated process.
 */
export async function stopSessionGateway(
  home: string,
  ops: GatewayProcessOps = defaultGatewayProcessOps,
  timeoutMs = 5000,
): Promise<StopGatewayResult> {
  let record: { pid?: unknown; kind?: unknown; hermes_home?: unknown };
  try {
    record = JSON.parse(await fs.readFile(path.join(home, 'gateway.pid'), 'utf8'));
  } catch {
    return { stopped: false, reason: 'no-pid-file' };
  }
  const pid = record.pid;
  if (record.kind !== 'hermes-gateway' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) {
    return { stopped: false, reason: 'not-a-gateway' };
  }
  const real = async (p: string): Promise<string> => fs.realpath(p).catch(() => path.resolve(p));
  if (typeof record.hermes_home !== 'string' || (await real(record.hermes_home)) !== (await real(home))) {
    return { stopped: false, reason: 'wrong-home' };
  }
  if (!ops.isAlive(pid)) return { stopped: false, reason: 'not-running' };
  const command = await ops.commandOf(pid);
  if (!command || !/hermes/i.test(command)) return { stopped: false, reason: 'not-hermes' };

  ops.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (ops.isAlive(pid) && Date.now() < deadline) await ops.sleep(50);
  if (!ops.isAlive(pid)) return { stopped: true, forced: false };
  ops.kill(pid, 'SIGKILL');
  const killDeadline = Date.now() + 2000;
  while (ops.isAlive(pid) && Date.now() < killDeadline) await ops.sleep(50);
  return ops.isAlive(pid) ? { stopped: false, reason: 'timeout' } : { stopped: true, forced: true };
}

/** Startup: stop gateways of session homes whose session is no longer registered. Homes are kept. */
export async function reapOrphanGateways(
  baseHome: string,
  knownSessionIds: Iterable<string>,
  ops: GatewayProcessOps = defaultGatewayProcessOps,
): Promise<string[]> {
  const known = new Set([...knownSessionIds].map((id) => path.basename(sessionHomePath(baseHome, id))));
  let names: string[];
  try {
    names = await fs.readdir(sessionHomesRoot(baseHome));
  } catch {
    return [];
  }
  const reaped: string[] = [];
  for (const name of names) {
    if (known.has(name)) continue;
    const result = await stopSessionGateway(path.join(sessionHomesRoot(baseHome), name), ops);
    if (result.stopped) reaped.push(name);
  }
  return reaped;
}

/** A home no registered session owns is unreachable (the key is the session id), so it can only be waste. */
export const DEFAULT_ORPHAN_HOME_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface ReapOrphanHomesOptions {
  /** Only homes untouched for this long are removed. Guards a record that is not flushed yet. */
  minAgeMs?: number;
  /** Test seam. */
  now?: () => number;
  ops?: GatewayProcessOps;
}

/** Newest mtime of the home dir and its direct entries; symlinks are lstat'ed, never followed. */
async function newestMtimeMs(dir: string): Promise<number> {
  const top = await fs.lstat(dir);
  let newest = top.mtimeMs;
  for (const name of await fs.readdir(dir)) {
    const st = await lstatOrNull(path.join(dir, name));
    if (st && !st.isSymbolicLink() && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}

/**
 * Startup, after reapOrphanGateways: removes session homes whose session is no longer registered
 * and that have been idle for `minAgeMs`. Only real directories named `<id>-<10 hex>` directly
 * under `<baseHome>/session-homes/` qualify; a home whose gateway cannot be stopped is kept.
 * Returns the removed home names.
 */
export async function reapOrphanHomes(
  baseHome: string,
  knownSessionIds: Iterable<string>,
  opts: ReapOrphanHomesOptions = {},
): Promise<string[]> {
  const root = sessionHomesRoot(baseHome);
  const known = new Set([...knownSessionIds].map((id) => path.basename(sessionHomePath(baseHome, id))));
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const now = (opts.now ?? Date.now)();
  const minAge = opts.minAgeMs ?? DEFAULT_ORPHAN_HOME_MIN_AGE_MS;
  const removed: string[] = [];
  for (const name of names) {
    if (known.has(name) || !/^.+-[0-9a-f]{10}$/.test(name)) continue;
    const home = path.join(root, name);
    const st = await lstatOrNull(home);
    if (!st || !st.isDirectory()) continue;
    try {
      if (now - (await newestMtimeMs(home)) < minAge) continue;
      const stop = await stopSessionGateway(home, opts.ops);
      if (!stop.stopped && stop.reason !== 'no-pid-file' && stop.reason !== 'not-running') continue;
      await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      removed.push(name);
    } catch {
      // Best effort: an unreadable or busy home stays for the next start.
    }
  }
  return removed;
}
