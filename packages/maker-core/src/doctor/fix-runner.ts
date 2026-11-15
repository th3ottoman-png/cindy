/**
 * Cindy Doctor fix protocol runner (ROADMAP 14.6, blueprint §5).
 *
 * Enforces the 7-step invariant for every DoctorFix:
 *   1. preview() returns a FixPlan with zero side effects
 *   2. Caller confirms before any mutation
 *   3. Refuse when needsAppClosed (or plan.requiresAppClosed) and Cindy is running
 *   4. Take pre-fix:<fixId> LKG snapshot (files) or record pids + commands (processes)
 *   5. apply() executes atomic changes
 *   6. Re-run fix.recheck checks; any fail rolls back automatically and reports rolledBack: true
 *   7. Append one redacted JSON line to ~/.cindy-harness/doctor/fix-log.jsonl
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { assertNotDailyHermes } from './context.js';
import { redactText } from './redact.js';
import { runChecks } from './runner.js';
import { createLkgSnapshot } from './snapshots.js';
import type {
  CheckResult,
  DoctorContext,
  DoctorFix,
  DoctorPack,
  DoctorRegistry,
  FixOutcome,
  FixPlan,
  Severity,
} from './types.js';

export interface FixLogEntry {
  at: string;
  fixId: string;
  target: string | null;
  ok: boolean;
  rolledBack: boolean;
  recheckCounts: Record<Severity, number>;
}

export type FixPreviewResult =
  | { ok: true; fix: DoctorFix; plan: FixPlan }
  | { ok: false; error: string; unknownFix?: boolean };

export interface ApplyFixOptions {
  packs?: readonly DoctorPack[];
}

export interface RunFixOptions extends ApplyFixOptions {
  target?: string;
  confirm?: (plan: FixPlan, fix: DoctorFix) => Promise<boolean> | boolean;
  yes?: boolean;
}

interface TouchFileBackup {
  path: string;
  existed: boolean;
  bytes: Buffer | null;
}

function emptySeverityCounts(): Record<Severity, number> {
  return { ok: 0, warn: 0, fail: 0, skip: 0 };
}

function countCheckResults(results: readonly CheckResult[]): Record<Severity, number> {
  const counts = emptySeverityCounts();
  for (const r of results) {
    counts[r.severity] += 1;
  }
  return counts;
}

async function resolveAppRunningForFix(ctx: DoctorContext): Promise<boolean> {
  if (typeof ctx.appRunning === 'boolean') {
    return ctx.appRunning;
  }
  const { detectAppRunningState } = await import('./packs/processes.js');
  const state = await detectAppRunningState(ctx);
  return state.running;
}

async function writeFileAtomically(destPath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(destPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(destPath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function captureTouchFileBackups(touches: readonly string[]): Promise<TouchFileBackup[]> {
  const backups: TouchFileBackup[] = [];
  for (const touchPath of touches) {
    if (!path.isAbsolute(touchPath)) continue;
    try {
      const st = await fs.lstat(touchPath);
      if (st.isSymbolicLink() || st.isDirectory()) continue;
      if (st.isFile()) {
        backups.push({
          path: touchPath,
          existed: true,
          bytes: await fs.readFile(touchPath),
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        backups.push({
          path: touchPath,
          existed: false,
          bytes: null,
        });
      } else {
        throw err;
      }
    }
  }
  return backups;
}

async function hasAnyBackupDiverged(backups: readonly TouchFileBackup[]): Promise<boolean> {
  for (const backup of backups) {
    try {
      const st = await fs.lstat(backup.path);
      if (!backup.existed) return true;
      if (!st.isFile()) return true;
      const current = await fs.readFile(backup.path);
      if (!backup.bytes || !current.equals(backup.bytes)) {
        return true;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        if (backup.existed) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

async function restoreTouchFileBackups(
  backups: readonly TouchFileBackup[],
  movedAsideSocket?: { from: string; to: string } | null,
): Promise<boolean> {
  let restoredAny = false;
  let allSucceeded = true;

  if (movedAsideSocket) {
    try {
      await fs.lstat(movedAsideSocket.to);
      await fs.rename(movedAsideSocket.to, movedAsideSocket.from);
      restoredAny = true;
    } catch {
      allSucceeded = false;
    }
  }

  for (const backup of backups) {
    if (!backup.existed) {
      try {
        await fs.lstat(backup.path);
        await fs.rm(backup.path, { force: true });
        restoredAny = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          allSucceeded = false;
        }
      }
      continue;
    }

    if (backup.bytes !== null) {
      try {
        await writeFileAtomically(backup.path, backup.bytes);
        restoredAny = true;
      } catch {
        allSucceeded = false;
      }
    } else {
      allSucceeded = false;
    }
  }

  return restoredAny && allSucceeded;
}

export function resolveFixLogPath(ctx: DoctorContext): string {
  return path.join(ctx.paths.harnessDir, 'doctor', 'fix-log.jsonl');
}

async function appendFixLogEntry(ctx: DoctorContext, entry: FixLogEntry): Promise<string> {
  const logPath = resolveFixLogPath(ctx);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const sanitizedTarget =
    entry.target !== null
      ? redactText(entry.target, { homeDir: ctx.paths.home })
      : null;
  const line = `${JSON.stringify({
    ...entry,
    target: sanitizedTarget,
  })}\n`;
  await fs.appendFile(logPath, line, 'utf8');
  return logPath;
}

export async function previewFix(
  registry: DoctorRegistry,
  ctx: DoctorContext,
  fixId: string,
  options: { target?: string } = {},
): Promise<FixPreviewResult> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);
  const fix = registry.getFix(fixId);
  if (!fix) {
    return { ok: false, error: `Unknown doctor fix: ${fixId}`, unknownFix: true };
  }
  try {
    const plan = await fix.preview(ctx, options.target);
    return { ok: true, fix, plan };
  } catch (err) {
    return {
      ok: false,
      error: redactText(err instanceof Error ? err.message : String(err), { homeDir: ctx.paths.home }),
    };
  }
}

export async function applyFix(
  registry: DoctorRegistry,
  ctx: DoctorContext,
  plan: FixPlan,
  options: ApplyFixOptions = {},
): Promise<FixOutcome> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);

  const fix = registry.getFix(plan.fixId);
  if (!fix) {
    return {
      ok: false,
      rolledBack: false,
      message: `Unknown doctor fix: ${plan.fixId}`,
      recheck: [],
    };
  }

  // Step 3: refuse if Cindy app must be closed and is running
  if (fix.needsAppClosed || plan.requiresAppClosed) {
    const appRunning = await resolveAppRunningForFix(ctx);
    if (appRunning) {
      return {
        ok: false,
        rolledBack: false,
        message: `Refused: fix "${fix.id}" requires Cindy desktop app to be closed.`,
        recheck: [],
      };
    }
  }

  const planRefusal =
    plan.meta && typeof plan.meta.refusalReason === 'string' && plan.meta.refusalReason.length > 0
      ? plan.meta.refusalReason
      : null;
  if (planRefusal) {
    return {
      ok: false,
      rolledBack: false,
      message: planRefusal,
      recheck: [],
    };
  }

  // Step 4: capture rollback point before mutating
  let preFixSnapshotStamp: string | undefined;
  let touchBackups: TouchFileBackup[] = [];

  if (fix.risk === 'moves-files') {
    touchBackups = await captureTouchFileBackups(plan.touches);
    const snap = await createLkgSnapshot(ctx, {
      reason: `pre-fix:${fix.id}`,
      packs: options.packs,
    });
    preFixSnapshotStamp = snap.stamp;
  }

  // Step 5: execute fix.apply() atomically
  let applyOutcome: FixOutcome;
  let applyThrew = false;
  try {
    applyOutcome = await fix.apply(ctx, plan);
  } catch (err) {
    applyThrew = true;
    applyOutcome = {
      ok: false,
      rolledBack: false,
      message: redactText(err instanceof Error ? err.message : String(err), {
        homeDir: ctx.paths.home,
      }),
      recheck: [],
    };
  }

  // Step 6: re-run fix.recheck checks (or plan.meta.recheckOnly for targeted single-file repairs)
  const effectiveRecheck =
    Array.isArray(plan.meta?.recheckOnly) &&
    plan.meta.recheckOnly.every((id): id is string => typeof id === 'string' && id.length > 0) &&
    plan.meta.recheckOnly.length > 0
      ? plan.meta.recheckOnly
      : fix.recheck;

  let recheckResults: CheckResult[] = [];
  if (effectiveRecheck.length > 0) {
    try {
      recheckResults = (
        await runChecks(
          registry,
          { ...ctx, includeApi: false },
          { only: effectiveRecheck },
        )
      ).results;
    } catch (recheckErr) {
      const errMsg = redactText(
        recheckErr instanceof Error ? recheckErr.message : String(recheckErr),
        { homeDir: ctx.paths.home },
      );
      recheckResults = [
        {
          id: `${fix.id}.recheck`,
          layer: 'config',
          title: 'Post-fix verification recheck',
          severity: 'fail',
          summary: `recheck crashed: ${errMsg}`,
          durationMs: 0,
        },
      ];
    }
  }
  const recheckCounts = countCheckResults(recheckResults);

  let rolledBack = false;
  let finalOk = !applyThrew && applyOutcome.ok && recheckCounts.fail === 0;
  let finalMessage = applyOutcome.message;

  const shouldRollBack =
    fix.risk === 'moves-files' &&
    (applyThrew || recheckCounts.fail > 0 || (!applyOutcome.ok && (await hasAnyBackupDiverged(touchBackups))));

  if (shouldRollBack) {
    const movedAsideMeta =
      plan.meta &&
      typeof plan.meta.movedAsideSocketFrom === 'string' &&
      typeof plan.meta.movedAsideSocketTo === 'string'
        ? { from: plan.meta.movedAsideSocketFrom, to: plan.meta.movedAsideSocketTo }
        : null;
    const restored = await restoreTouchFileBackups(touchBackups, movedAsideMeta);
    rolledBack =
      touchBackups.length > 0 || movedAsideMeta !== null
        ? restored
        : Boolean(preFixSnapshotStamp);
    finalOk = false;
    finalMessage =
      recheckCounts.fail > 0
        ? `${applyOutcome.message}; rolled back from pre-fix state (${recheckCounts.fail} re-check(s) failed)`
        : `${applyOutcome.message}; rolled back from pre-fix state`;
  }

  // Step 7: append one line to fix-log.jsonl
  const fixLogPath = await appendFixLogEntry(ctx, {
    at: ctx.now().toISOString(),
    fixId: fix.id,
    target: plan.target ?? null,
    ok: finalOk,
    rolledBack,
    recheckCounts,
  });

  return {
    ok: finalOk,
    rolledBack,
    message: finalMessage,
    recheck: recheckResults,
    ...(preFixSnapshotStamp ? { preFixSnapshotStamp } : {}),
    fixLogPath,
  };
}

export async function runFix(
  registry: DoctorRegistry,
  ctx: DoctorContext,
  fixId: string,
  options: RunFixOptions = {},
): Promise<FixOutcome> {
  const preview = await previewFix(registry, ctx, fixId, { target: options.target });
  if (!preview.ok) {
    return {
      ok: false,
      rolledBack: false,
      message: preview.error,
      recheck: [],
    };
  }

  const confirmed = options.yes
    ? true
    : options.confirm
      ? await options.confirm(preview.plan, preview.fix)
      : false;

  if (!confirmed) {
    return {
      ok: false,
      rolledBack: false,
      message: 'Fix cancelled (confirmation required).',
      recheck: [],
    };
  }

  return applyFix(registry, ctx, preview.plan, { packs: options.packs });
}
