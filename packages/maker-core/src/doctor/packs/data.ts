/**
 * Data doctor pack (`data.*`, ROADMAP 14.4, blueprint §3 & §11).
 *
 * Strictly read-only checks for SQLite integrity (`data.sqlite`, `data.hermes-state`),
 * daemon session registry consistency (`data.registry`), storage totals via `planHousekeeping`
 * (`data.storage`), and recent fatal patterns across logs (`data.logs`). Never writes,
 * checkpoints, or deletes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  DEFAULT_RETENTION_DAYS,
  planHousekeeping,
  type HousekeepingCandidate,
} from '../../storage/housekeeping.js';
import { isDailyHermesPath } from '../context.js';
import { redactText } from '../redact.js';
import type { CheckRunOutput, DoctorContext, DoctorPack } from '../types.js';

const MAX_RECENT_HERMES_HOMES = 20;
const STORAGE_SCAN_BUDGET_MS = 1_500;
const LOG_TAIL_LINES = 200;
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const STORAGE_WARN_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const STORAGE_WARN_RECLAIMABLE_BYTES = 2 * 1024 * 1024 * 1024;

const SESSION_HOME_SUFFIX = /^(.+)-[0-9a-f]{10}$/;
const BACKUP_NAME = /^(.+)\.bak[-.]/;

interface FatalLogPattern {
  pattern: RegExp;
  meaning: string;
}

/** Known fatal log signatures matched against the last 200 lines of agent/desktop logs. */
export const FATAL_LOG_PATTERNS: readonly FatalLogPattern[] = [
  {
    pattern: /database disk image is malformed|SQLITE_CORRUPT/i,
    meaning: 'SQLite database corruption detected',
  },
  {
    pattern: /FATAL ERROR:.*heap limit|Allocation failed - JavaScript heap out of memory/i,
    meaning: 'Node/Electron JavaScript process ran out of heap memory',
  },
  {
    pattern: /\bUncaught Exception\b|\bUnhandledPromiseRejection\b|Traceback \(most recent call last\):/i,
    meaning: 'unhandled exception or Python crash recorded',
  },
  {
    pattern: /\bERR_MODULE_NOT_FOUND\b|Cannot find module ['"]/i,
    meaning: 'missing module or broken runtime dependency path',
  },
  {
    pattern: /\bEADDRINUSE\b|Address already in use/i,
    meaning: 'port conflict prevented a service from binding',
  },
  {
    pattern: /\bEMFILE\b|too many open files/i,
    meaning: 'process hit open file descriptor limit',
  },
  {
    pattern: /\bSegmentation fault\b|\bSIGSEGV\b/i,
    meaning: 'native crash (segmentation fault)',
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let val = bytes / 1024;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit += 1;
  }
  return `${val.toFixed(1)} ${units[unit]}`;
}

function requireQuickCheckFn(ctx: DoctorContext): (dbPath: string) => Promise<string[]> | string[] {
  if (!ctx.sqliteQuickCheck) {
    throw new Error('sqliteQuickCheck helper missing from DoctorContext');
  }
  return ctx.sqliteQuickCheck;
}

async function runDataSqlite(ctx: DoctorContext): Promise<CheckRunOutput> {
  const dbPath = path.join(ctx.paths.userDataDir, 'cindy-local-v1.db');
  try {
    await ctx.fs.stat(dbPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { severity: 'ok', summary: 'cindy-local-v1.db does not exist yet (new profile)' };
    }
    return {
      severity: 'fail',
      summary: `Could not stat cindy-local-v1.db: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const quickCheck = requireQuickCheckFn(ctx);
    const rows = await quickCheck(dbPath);
    const allOk = rows.length === 1 && rows[0]!.trim().toLowerCase() === 'ok';
    if (!allOk) {
      return {
        severity: 'fail',
        summary: `cindy-local-v1.db failed PRAGMA quick_check: ${rows[0] ?? 'unknown failure'}`,
        detail: rows.join('\n'),
        action: 'Restore cindy-local-v1.db from a backup (`pnpm backup:restore`) while Cindy is closed.',
      };
    }
    return {
      severity: 'ok',
      summary: 'cindy-local-v1.db passed read-only PRAGMA quick_check',
    };
  } catch (err) {
    return {
      severity: 'fail',
      summary: `cindy-local-v1.db read-only integrity check failed: ${redactText(err instanceof Error ? err.message : String(err), { homeDir: ctx.paths.home })}`,
      action: 'Restore cindy-local-v1.db from a backup (`pnpm backup:restore`) while Cindy is closed.',
    };
  }
}

async function runDataHermesState(ctx: DoctorContext): Promise<CheckRunOutput> {
  if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    return {
      severity: 'fail',
      summary: 'Refusing to inspect non-isolated daily Hermes home; ~/.hermes-cindy is required',
    };
  }

  const homesRoot = path.join(ctx.paths.hermesHome, 'session-homes');
  let names: string[];
  try {
    names = await ctx.fs.readdir(homesRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { severity: 'ok', summary: 'No session homes exist yet' };
    }
    return {
      severity: 'warn',
      summary: `Could not read session-homes directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const lstatFn = ctx.lstat ?? fs.lstat;
  const homesWithMtime: Array<{ name: string; fullPath: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const fullPath = path.join(homesRoot, name);
    try {
      const st = await lstatFn(fullPath);
      if (!st.isSymbolicLink() && st.isDirectory()) {
        homesWithMtime.push({ name, fullPath, mtimeMs: st.mtimeMs });
      }
    } catch {
      /* ignore vanishing temp entries */
    }
  }

  homesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const recentHomes = homesWithMtime.slice(0, MAX_RECENT_HERMES_HOMES);
  if (recentHomes.length === 0) {
    return { severity: 'ok', summary: 'No session home directories found' };
  }

  const quickCheck = requireQuickCheckFn(ctx);
  let checkedDbs = 0;
  const broken: string[] = [];

  for (const home of recentHomes) {
    const dbPath = path.join(home.fullPath, 'state.db');
    try {
      await ctx.fs.stat(dbPath);
    } catch {
      continue;
    }

    checkedDbs += 1;
    const sessionId = SESSION_HOME_SUFFIX.exec(home.name)?.[1] ?? home.name;
    try {
      const rows = await quickCheck(dbPath);
      const ok = rows.length === 1 && rows[0]!.trim().toLowerCase() === 'ok';
      if (!ok) {
        broken.push(`${sessionId} (${home.name}): ${rows[0] ?? 'quick_check failed'}`);
      }
    } catch (err) {
      broken.push(
        `${sessionId} (${home.name}): ${redactText(err instanceof Error ? err.message : String(err), { homeDir: ctx.paths.home })}`,
      );
    }
  }

  if (broken.length > 0) {
    return {
      severity: 'warn',
      summary: `${broken.length} of ${checkedDbs} recent session state.db failed read-only check (${broken[0]})`,
      detail: broken.join('\n'),
      action: 'Broken session transcripts can be inspected or archived under Settings → Storage.',
      evidence: { inspectedHomes: recentHomes.length, checkedDbs, brokenCount: broken.length },
    };
  }

  return {
    severity: 'ok',
    summary: `Checked ${checkedDbs} recent session home state.db file(s) (of ${recentHomes.length} newest homes); all readable`,
    evidence: { inspectedHomes: recentHomes.length, checkedDbs, brokenCount: 0 },
  };
}

async function readSessionRegistryRecords(ctx: DoctorContext): Promise<
  | { exists: false }
  | { exists: true; error: string }
  | { exists: true; records: Array<{ sessionId?: unknown; running?: unknown }> }
> {
  const regPath = path.join(ctx.paths.hermesHome, 'hermes-mgr', 'sessions.json');
  let raw: string;
  try {
    raw = await ctx.fs.readFile(regPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { exists: false };
    return { exists: true, error: err instanceof Error ? err.message : String(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      exists: true,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { exists: true, error: 'Expected top-level JSON array in sessions.json' };
  }

  return { exists: true, records: parsed as Array<{ sessionId?: unknown; running?: unknown }> };
}

async function runDataRegistry(ctx: DoctorContext): Promise<CheckRunOutput> {
  if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    return {
      severity: 'fail',
      summary: 'Refusing to inspect non-isolated daily Hermes home; ~/.hermes-cindy is required',
    };
  }

  const reg = await readSessionRegistryRecords(ctx);
  if (!reg.exists) {
    return { severity: 'ok', summary: 'Daemon session registry does not exist yet' };
  }
  if ('error' in reg) {
    return {
      severity: 'fail',
      summary: `Daemon sessions.json failed to parse: ${reg.error}`,
      action: 'Back up and repair ~/.hermes-cindy/hermes-mgr/sessions.json.',
    };
  }

  const homesRoot = path.join(ctx.paths.hermesHome, 'session-homes');
  let homeNames: string[] = [];
  try {
    homeNames = await ctx.fs.readdir(homesRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        severity: 'warn',
        summary: `Could not read session-homes directory: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const homeSet = new Set(homeNames);
  const missing: string[] = [];

  for (let i = 0; i < reg.records.length; i += 1) {
    const rec = reg.records[i];
    if (!rec || typeof rec !== 'object' || typeof rec.sessionId !== 'string' || !rec.sessionId) {
      missing.push(`record[${i}]: missing valid sessionId`);
      continue;
    }
    const sid = rec.sessionId;
    const hasHome =
      homeSet.has(sid) || homeNames.some((dirName) => dirName.startsWith(`${sid}-`));
    if (!hasHome) {
      missing.push(`${sid}: session home directory missing`);
    }
  }

  if (missing.length > 0) {
    return {
      severity: 'warn',
      summary: `${missing.length} session registry entry/entries missing session home(s)`,
      detail: missing.join('\n'),
      action: 'Open Settings → Storage to review orphaned or missing session homes.',
      evidence: { recordCount: reg.records.length, missingCount: missing.length },
    };
  }

  return {
    severity: 'ok',
    summary: `Validated ${reg.records.length} daemon session registry record(s)`,
    evidence: { recordCount: reg.records.length, missingCount: 0 },
  };
}

async function measureDirTree(
  ctx: DoctorContext,
  target: string,
  deadlineMs: number,
  state: { truncated: boolean },
  lstatFn: NonNullable<DoctorContext['lstat']>,
): Promise<{ bytes: number; newestMs: number }> {
  if (ctx.now().getTime() > deadlineMs) {
    state.truncated = true;
    return { bytes: 0, newestMs: 0 };
  }
  let st;
  try {
    st = await lstatFn(target);
  } catch {
    return { bytes: 0, newestMs: 0 };
  }
  if (st.isSymbolicLink()) return { bytes: 0, newestMs: 0 };
  if (st.isFile()) return { bytes: st.size, newestMs: st.mtimeMs };
  if (!st.isDirectory()) return { bytes: 0, newestMs: 0 };

  let entries: string[];
  try {
    entries = await ctx.fs.readdir(target);
  } catch {
    return { bytes: 0, newestMs: st.mtimeMs };
  }

  let bytes = 0;
  let newestMs = st.mtimeMs;
  for (const name of entries) {
    if (ctx.now().getTime() > deadlineMs) {
      state.truncated = true;
      break;
    }
    const sub = await measureDirTree(ctx, path.join(target, name), deadlineMs, state, lstatFn);
    bytes += sub.bytes;
    if (sub.newestMs > newestMs) newestMs = sub.newestMs;
  }
  return { bytes, newestMs };
}

async function runDataStorage(ctx: DoctorContext): Promise<CheckRunOutput> {
  if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    return {
      severity: 'fail',
      summary: 'Refusing to inspect non-isolated daily Hermes home; ~/.hermes-cindy is required',
    };
  }

  const lstatFn = ctx.lstat ?? fs.lstat;
  const nowMs = ctx.now().getTime();
  const deadlineMs = nowMs + STORAGE_SCAN_BUDGET_MS;
  const state = { truncated: false };

  const reg = await readSessionRegistryRecords(ctx);
  const regRecords = reg.exists && 'records' in reg ? reg.records : [];
  const owners = new Set(
    regRecords.map((r) => (typeof r.sessionId === 'string' ? r.sessionId : '')).filter(Boolean),
  );
  const protectedIds = new Set(
    regRecords
      .filter((r) => r.running === true && typeof r.sessionId === 'string')
      .map((r) => r.sessionId as string),
  );

  const candidates: HousekeepingCandidate[] = [];
  const homesRoot = path.join(ctx.paths.hermesHome, 'session-homes');
  let sessionHomeBytes = 0;
  let orphanBytes = 0;
  let orphanCount = 0;

  let homeEntries: string[] = [];
  try {
    homeEntries = await ctx.fs.readdir(homesRoot);
  } catch {
    homeEntries = [];
  }

  for (const name of homeEntries) {
    if (ctx.now().getTime() > deadlineMs) {
      state.truncated = true;
      break;
    }
    const homeDir = path.join(homesRoot, name);
    let st;
    try {
      st = await lstatFn(homeDir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;

    const walked = await measureDirTree(ctx, homeDir, deadlineMs, state, lstatFn);
    sessionHomeBytes += walked.bytes;
    const owner = SESSION_HOME_SUFFIX.exec(name)?.[1];
    const isOrphan = !owner || !owners.has(owner);

    if (isOrphan) {
      orphanCount += 1;
      orphanBytes += walked.bytes;
      candidates.push({
        path: homeDir,
        root: homesRoot,
        kind: 'session-home',
        sizeBytes: walked.bytes,
        idleSinceMs: walked.newestMs || st.mtimeMs,
        isSymlink: false,
        isDirectory: true,
        isRegularFile: false,
        registryFlushedAfterIdle: true,
      });
      continue;
    }

    for (const rel of ['models_dev_cache.json', 'models_dev_cache.etag']) {
      const target = path.join(homeDir, rel);
      try {
        const cst = await lstatFn(target);
        if (!cst.isSymbolicLink() && cst.isFile()) {
          candidates.push({
            path: target,
            root: homesRoot,
            kind: 'home-model-catalog',
            sizeBytes: cst.size,
            idleSinceMs: walked.newestMs || st.mtimeMs,
            isSymlink: false,
            isDirectory: false,
            isRegularFile: true,
            ownerSessionId: owner,
          });
        }
      } catch {
        /* absent */
      }
    }
  }

  const cacheWalk = await measureDirTree(
    ctx,
    path.join(ctx.paths.hermesHome, 'cache'),
    deadlineMs,
    state,
    lstatFn,
  );
  const uvDir = path.join(ctx.paths.hermesHome, 'cache', 'uv');
  try {
    const uvStat = await lstatFn(uvDir);
    if (!uvStat.isSymbolicLink() && uvStat.isDirectory()) {
      const uvWalk = await measureDirTree(ctx, uvDir, deadlineMs, state, lstatFn);
      candidates.push({
        path: uvDir,
        root: ctx.paths.hermesHome,
        kind: 'base-uv-cache',
        sizeBytes: uvWalk.bytes,
        idleSinceMs: uvWalk.newestMs || uvStat.mtimeMs,
        isSymlink: false,
        isDirectory: true,
        isRegularFile: false,
      });
    }
  } catch {
    /* absent */
  }

  let harnessBackupBytes = 0;
  try {
    for (const name of await ctx.fs.readdir(ctx.paths.harnessDir)) {
      const bakMatch = BACKUP_NAME.exec(name);
      if (!bakMatch) continue;
      const full = path.join(ctx.paths.harnessDir, name);
      const st = await lstatFn(full).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      const bytes = st.isDirectory()
        ? (await measureDirTree(ctx, full, deadlineMs, state, lstatFn)).bytes
        : st.size;
      harnessBackupBytes += bytes;
      candidates.push({
        path: full,
        root: ctx.paths.harnessDir,
        kind: 'harness-backup',
        sizeBytes: bytes,
        idleSinceMs: st.mtimeMs,
        isSymlink: false,
        isDirectory: st.isDirectory(),
        isRegularFile: st.isFile(),
        backupBase: bakMatch[1],
      });
    }
  } catch {
    /* absent */
  }

  const hermesLogsWalk = await measureDirTree(
    ctx,
    path.join(ctx.paths.hermesHome, 'logs'),
    deadlineMs,
    state,
    lstatFn,
  );
  const desktopLogsWalk = await measureDirTree(
    ctx,
    path.join(ctx.paths.repoRoot, 'apps', 'desktop', 'logs'),
    deadlineMs,
    state,
    lstatFn,
  );

  const plan = planHousekeeping(candidates, nowMs, DEFAULT_RETENTION_DAYS, protectedIds);
  const reclaimableBytes = plan.estimatedFreedBytes;
  const totalBytes =
    sessionHomeBytes +
    cacheWalk.bytes +
    harnessBackupBytes +
    hermesLogsWalk.bytes +
    desktopLogsWalk.bytes;

  const overTotal = totalBytes >= STORAGE_WARN_TOTAL_BYTES;
  const overReclaimable = reclaimableBytes >= STORAGE_WARN_RECLAIMABLE_BYTES;
  const suffix = state.truncated ? ' (scan budget reached; lower bound)' : '';

  if (overTotal || overReclaimable) {
    return {
      severity: 'warn',
      summary: `Storage totals over threshold: ${formatBytes(totalBytes)} total, ${formatBytes(reclaimableBytes)} reclaimable${suffix}`,
      detail: [
        `Session homes: ${formatBytes(sessionHomeBytes)} (${orphanCount} orphan(s): ${formatBytes(orphanBytes)})`,
        `Hermes cache: ${formatBytes(cacheWalk.bytes)}`,
        `Harness backups: ${formatBytes(harnessBackupBytes)}`,
        `Logs: ${formatBytes(hermesLogsWalk.bytes + desktopLogsWalk.bytes)}`,
      ].join('\n'),
      action: 'Settings → Storage',
      evidence: {
        totalBytes,
        reclaimableBytes,
        sessionHomeBytes,
        orphanCount,
        truncated: state.truncated,
      },
    };
  }

  return {
    severity: 'ok',
    summary: `Storage within thresholds (${formatBytes(totalBytes)} total, ${formatBytes(reclaimableBytes)} reclaimable)${suffix}`,
    evidence: {
      totalBytes,
      reclaimableBytes,
      sessionHomeBytes,
      orphanCount,
      truncated: state.truncated,
    },
  };
}

async function readTailLines(ctx: DoctorContext, filePath: string): Promise<{ size: number; lines: string[] } | null> {
  let st;
  try {
    st = await ctx.fs.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }

  let content: string;
  if (st.size <= LOG_TAIL_MAX_BYTES) {
    content = await ctx.fs.readFile(filePath, 'utf8');
  } else {
    const start = Math.max(0, st.size - LOG_TAIL_MAX_BYTES);
    const len = st.size - start;
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      content = buf.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  const lines = content.split(/\r?\n/);
  return { size: st.size, lines: lines.slice(-LOG_TAIL_LINES) };
}

async function measureDirAndNewestFile(
  ctx: DoctorContext,
  dirPath: string,
): Promise<{ totalBytes: number; newestFile?: string }> {
  let names: string[];
  try {
    names = await ctx.fs.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { totalBytes: 0 };
    throw err;
  }

  let totalBytes = 0;
  let newestFile: string | undefined;
  let newestMtime = -1;

  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dirPath, name);
    try {
      const st = await ctx.fs.stat(full);
      if (!st.isFile()) continue;
      totalBytes += st.size;
      if (st.mtimeMs > newestMtime) {
        newestMtime = st.mtimeMs;
        newestFile = full;
      }
    } catch {
      /* ignore vanishing files */
    }
  }

  return { totalBytes, newestFile };
}

function findFatalMatchInTail(
  label: string,
  lines: readonly string[],
  homeDir: string,
): { label: string; meaning: string; line: string } | null {
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx]!;
    if (!line.trim()) continue;
    for (const entry of FATAL_LOG_PATTERNS) {
      if (entry.pattern.test(line)) {
        const safe = redactText(line.trim(), { homeDir });
        return {
          label,
          meaning: entry.meaning,
          line: safe.length > 240 ? `${safe.slice(0, 237)}...` : safe,
        };
      }
    }
  }
  return null;
}

async function runDataLogs(ctx: DoctorContext): Promise<CheckRunOutput> {
  if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    return {
      severity: 'fail',
      summary: 'Refusing to inspect non-isolated daily Hermes home; ~/.hermes-cindy is required',
    };
  }

  const agentLogPath = path.join(ctx.paths.hermesHome, 'logs', 'agent.log');
  const desktopLogsDir = path.join(ctx.paths.repoRoot, 'apps', 'desktop', 'logs');

  const agentTail = await readTailLines(ctx, agentLogPath).catch(() => null);
  const desktopDirInfo = await measureDirAndNewestFile(ctx, desktopLogsDir).catch(() => ({
    totalBytes: 0,
    newestFile: undefined,
  }));
  const desktopTail = desktopDirInfo.newestFile
    ? await readTailLines(ctx, desktopDirInfo.newestFile).catch(() => null)
    : null;

  const matches: Array<{ label: string; meaning: string; line: string }> = [];
  if (agentTail) {
    const hit = findFatalMatchInTail('agent.log', agentTail.lines, ctx.paths.home);
    if (hit) matches.push(hit);
  }
  if (desktopTail && desktopDirInfo.newestFile) {
    const hit = findFatalMatchInTail(
      path.basename(desktopDirInfo.newestFile),
      desktopTail.lines,
      ctx.paths.home,
    );
    if (hit) matches.push(hit);
  }

  const agentSize = agentTail?.size ?? 0;
  const desktopSize = desktopDirInfo.totalBytes;

  if (matches.length > 0) {
    const first = matches[0]!;
    return {
      severity: 'warn',
      summary: `Fatal pattern in ${first.label}: ${first.meaning}`,
      detail: matches.map((m) => `[${m.label}] (${m.meaning}) ${m.line}`).join('\n'),
      action: 'Inspect the referenced log file for full context.',
      evidence: {
        agentLogBytes: agentSize,
        desktopLogsBytes: desktopSize,
        matchCount: matches.length,
      },
    };
  }

  return {
    severity: 'ok',
    summary: `Recent logs clean (agent.log ${formatBytes(agentSize)}, desktop logs ${formatBytes(desktopSize)})`,
    evidence: {
      agentLogBytes: agentSize,
      desktopLogsBytes: desktopSize,
      matchCount: 0,
    },
  };
}

export const dataPack: DoctorPack = {
  name: 'data',
  checks: [
    {
      id: 'data.sqlite',
      layer: 'data',
      title: 'Cindy SQLite integrity (read-only)',
      cost: 'fast',
      run: runDataSqlite,
    },
    {
      id: 'data.hermes-state',
      layer: 'data',
      title: 'Recent session state.db integrity',
      cost: 'fast',
      run: runDataHermesState,
    },
    {
      id: 'data.registry',
      layer: 'data',
      title: 'Daemon session registry consistency',
      cost: 'fast',
      run: runDataRegistry,
    },
    {
      id: 'data.storage',
      layer: 'data',
      title: 'Storage usage & reclaimable totals',
      cost: 'fast',
      run: runDataStorage,
    },
    {
      id: 'data.logs',
      layer: 'data',
      title: 'Log sizes & fatal pattern scan',
      cost: 'fast',
      run: runDataLogs,
    },
  ],
};
