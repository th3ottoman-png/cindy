/**
 * Deterministic, fail-closed check runner for Cindy Doctor (ROADMAP 14.1, blueprint §2.2).
 *
 * - Runs checks in layer order (`environment -> runtimes -> config -> endpoints -> processes -> data`),
 *   then registration order within each layer.
 * - Bounds concurrent independent checks (default 4) while always returning results in the
 *   fixed layer/registration order.
 * - Never throws: check errors and per-cost timeouts become `fail`.
 */

import {
  CHECK_TIMEOUT_MS,
  DOCTOR_LAYERS,
  type CheckCost,
  type CheckResult,
  type CheckRunOutput,
  type DoctorCheck,
  type DoctorContext,
  type DoctorHostInfo,
  type DoctorRegistry,
  type DoctorReport,
  type RunChecksOptions,
  type Severity,
} from './types.js';

const LAYER_INDEX = new Map(DOCTOR_LAYERS.map((layer, index) => [layer, index]));
const VALID_SEVERITIES = new Set<Severity>(['ok', 'warn', 'fail', 'skip']);
const DEFAULT_CONCURRENCY = 4;

function defaultHostInfo(): DoctorHostInfo {
  const proc = typeof process !== 'undefined' ? process : undefined;
  return {
    node: proc?.version ?? 'unknown',
    platform: proc?.platform ?? 'unknown',
  };
}

function selectChecks(checks: readonly DoctorCheck[], options: RunChecksOptions): DoctorCheck[] {
  const onlySet = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const costSet = options.cost ? new Set(options.cost) : null;

  const indexed = checks
    .map((check, index) => ({ check, index }))
    .filter(({ check }) => {
      if (onlySet && !onlySet.has(check.id) && !onlySet.has(check.layer)) return false;
      if (costSet && !costSet.has(check.cost)) return false;
      return true;
    });

  indexed.sort((a, b) => {
    const layerDiff = (LAYER_INDEX.get(a.check.layer) ?? 99) - (LAYER_INDEX.get(b.check.layer) ?? 99);
    return layerDiff !== 0 ? layerDiff : a.index - b.index;
  });

  return indexed.map((entry) => entry.check);
}

function resolveAppRunning(
  explicit: boolean | undefined,
  resultsById: ReadonlyMap<string, CheckResult>,
): boolean | undefined {
  if (typeof explicit === 'boolean') return explicit;
  const procApp = resultsById.get('proc.app');
  if (procApp?.evidence && typeof procApp.evidence.running === 'boolean') {
    return procApp.evidence.running;
  }
  return undefined;
}

function checkNeedsSkipReason(
  check: DoctorCheck,
  appRunning: boolean | undefined,
): string | null {
  if (!check.needs || check.needs.length === 0) return null;
  if (appRunning === undefined) {
    return 'skipped: app running state unknown';
  }
  if (check.needs.includes('app-closed') && appRunning) {
    return 'skipped: app is running (requires app closed)';
  }
  if (check.needs.includes('app-running') && !appRunning) {
    return 'skipped: app is closed (requires app running)';
  }
  return null;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function normalizeOutput(raw: unknown): CheckRunOutput {
  if (!raw || typeof raw !== 'object') {
    return { severity: 'fail', summary: 'check crashed: invalid check result' };
  }
  const candidate = raw as Partial<CheckRunOutput>;
  if (!candidate.severity || !VALID_SEVERITIES.has(candidate.severity) || typeof candidate.summary !== 'string') {
    return { severity: 'fail', summary: 'check crashed: invalid check result' };
  }
  return {
    severity: candidate.severity,
    summary: candidate.summary,
    ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
    ...(candidate.action !== undefined ? { action: candidate.action } : {}),
    ...(candidate.fixIds !== undefined ? { fixIds: candidate.fixIds } : {}),
    ...(candidate.evidence !== undefined ? { evidence: candidate.evidence } : {}),
  };
}

async function runSingleCheck(
  check: DoctorCheck,
  ctx: DoctorContext,
  timeoutMs: number,
  appRunning: boolean | undefined,
): Promise<CheckResult> {
  const startedAtMs = ctx.now().getTime();
  const base = { id: check.id, layer: check.layer, title: check.title };

  const needsSkip = checkNeedsSkipReason(check, appRunning);
  if (needsSkip) {
    return { ...base, severity: 'skip', summary: needsSkip, durationMs: 0 };
  }

  if (ctx.signal.aborted) {
    return { ...base, severity: 'fail', summary: 'check crashed: aborted', durationMs: 0 };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const execution = Promise.resolve().then(() => check.run(ctx));
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`__DOCTOR_TIMEOUT__:${timeoutMs}`));
      }, timeoutMs);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('aborted'));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });

    const raw = await Promise.race([execution, timeoutPromise, abortPromise]);
    const output = normalizeOutput(raw);
    const durationMs = Math.max(0, ctx.now().getTime() - startedAtMs);
    return { ...base, ...output, durationMs };
  } catch (error) {
    const durationMs = Math.max(0, ctx.now().getTime() - startedAtMs);
    const message = formatErrorMessage(error);
    if (message === `__DOCTOR_TIMEOUT__:${timeoutMs}`) {
      return {
        ...base,
        severity: 'fail',
        summary: `check timed out after ${timeoutMs} ms`,
        durationMs,
      };
    }
    return {
      ...base,
      severity: 'fail',
      summary: `check crashed: ${message}`,
      durationMs,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

export async function runChecks(
  registry: DoctorRegistry,
  ctx: DoctorContext,
  options: RunChecksOptions = {},
): Promise<DoctorReport> {
  const runStarted = ctx.now();
  const availableChecks = registry.resolveChecks
    ? await registry.resolveChecks(ctx)
    : registry.checks;
  const ordered = selectChecks(availableChecks, options);
  const selectedIds = new Set(ordered.map((c) => c.id));
  const timeouts: Record<CheckCost, number> = {
    ...CHECK_TIMEOUT_MS,
    ...(options.timeouts ?? {}),
  };
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const explicitAppRunning = options.appRunning ?? ctx.appRunning;

  const resultsById = new Map<string, CheckResult>();
  const remaining = [...ordered];
  const inFlight = new Set<Promise<void>>();

  while (remaining.length > 0 || inFlight.size > 0) {
    let settledSkip = false;

    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      const check = remaining[i];
      const deps = (check.dependsOn ?? []).filter((depId) => selectedIds.has(depId));
      const failedDep = deps.find((depId) => {
        const depResult = resultsById.get(depId);
        return depResult && (depResult.severity === 'fail' || depResult.severity === 'skip');
      });

      if (failedDep) {
        const depResult = resultsById.get(failedDep)!;
        const reason = depResult.severity === 'fail' ? 'failed' : 'skipped';
        resultsById.set(check.id, {
          id: check.id,
          layer: check.layer,
          title: check.title,
          severity: 'skip',
          summary: `skipped: ${failedDep} ${reason}`,
          ...(depResult.detail ? { detail: depResult.detail } : {}),
          durationMs: 0,
        });
        remaining.splice(i, 1);
        settledSkip = true;
      }
    }

    if (settledSkip) continue;

    while (inFlight.size < concurrency) {
      const nextIndex = remaining.findIndex((check) => {
        const deps = (check.dependsOn ?? []).filter((depId) => selectedIds.has(depId));
        return deps.every((depId) => resultsById.has(depId));
      });
      if (nextIndex === -1) break;

      const [check] = remaining.splice(nextIndex, 1);
      const appRunning = resolveAppRunning(explicitAppRunning, resultsById);
      const task = runSingleCheck(check, ctx, timeouts[check.cost], appRunning).then((res) => {
        resultsById.set(check.id, res);
      });
      const wrapped = task.finally(() => {
        inFlight.delete(wrapped);
      });
      inFlight.add(wrapped);
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight);
      continue;
    }

    if (remaining.length > 0) {
      // Cyclic or unresolvable dependency: fail closed and exit loop.
      for (const stuck of remaining.splice(0, remaining.length)) {
        resultsById.set(stuck.id, {
          id: stuck.id,
          layer: stuck.layer,
          title: stuck.title,
          severity: 'fail',
          summary: 'check crashed: cyclic dependsOn',
          durationMs: 0,
        });
      }
    }
  }

  const results = ordered.map((check) => resultsById.get(check.id)!);
  const counts: Record<Severity, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) {
    counts[result.severity] += 1;
  }

  const durationMs = Math.max(0, ctx.now().getTime() - runStarted.getTime());

  return {
    startedAt: runStarted.toISOString(),
    durationMs,
    host: ctx.host ?? defaultHostInfo(),
    counts,
    results,
  };
}
