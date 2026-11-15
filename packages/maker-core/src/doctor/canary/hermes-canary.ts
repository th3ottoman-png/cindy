/**
 * Hermes upgrade canary runner (ROADMAP 14.7, blueprint §6).
 *
 * Builds an isolated throwaway HERMES_HOME under `$TMPDIR/cindy-doctor-canary-<stamp>/`,
 * symlinks only `installs` / `venv` (never `.env` or `auth.json`, never touches the daily Hermes home
 * or `~/.hermes-cindy`), runs one `chat` turn against a local route by default using
 * `--safe-mode --provider custom --base-url`, evaluates all five HANDOVER §3 contracts,
 * writes `~/.cindy-harness/doctor/canary/hermes-<version>.json`, and removes the temp home.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseNdjsonEvents,
  selectNewestRealHermesFixture,
  type HermesStreamEvent,
} from '../../agents/hermes/event-shapes.js';
import {
  parseProvidersYaml,
  type ProviderFileEntry,
} from '../../providers/providers-file.js';
import { parseRoutingYaml } from '../../providers/routing-file.js';
import { assertNotDailyHermes, isDailyHermesPath } from '../context.js';
import { resolveCommandOnPath } from '../packs/environment.js';
import { probeHermes } from '../packs/runtimes.js';
import type { DoctorContext } from '../types.js';
import {
  CANARY_NOT_COVERED_PROBES,
  evaluateHermesCanaryContracts,
  HERMES_CANARY_PROMPT,
  readHermesCanaryRecord,
  resolveHermesCanaryRecordPath,
  type CanaryContractResult,
  type CanaryNotCoveredProbe,
  type HermesCanaryRecord,
  type HermesCanaryRecordRoute,
} from './contracts.js';

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 2_000;

export type ResolvedCanaryRoute = HermesCanaryRecordRoute;
export type { HermesCanaryRecord };
export { readHermesCanaryRecord, resolveHermesCanaryRecordPath };

export type RouteSelectionOutcome =
  | { kind: 'ok'; route: ResolvedCanaryRoute; expectedCostNote?: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; reason: string };

export interface PaidConfirmationRequest {
  routeName: string;
  providerId: string;
  model: string;
  expectedCost: string;
}

export interface HermesCanarySpawnRequest {
  binPath: string;
  args: string[];
  cwd: string;
  hermesHome: string;
  env: Record<string, string | undefined>;
  stdinText: string;
  timeoutMs: number;
}

export interface HermesCanarySpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunHermesCanaryOptions {
  modelRoute?: string;
  paid?: boolean;
  confirmPaid?: (req: PaidConfirmationRequest) => Promise<boolean>;
  timeoutMs?: number;
  tmpDir?: string;
  spawnTurn?: (req: HermesCanarySpawnRequest) => Promise<HermesCanarySpawnResult>;
}

export interface RunHermesCanaryResult {
  ok: boolean;
  status: 'passed' | 'failed' | 'skip' | 'refused' | 'error';
  version: string | null;
  launcherPath: string | null;
  execBinPath: string | null;
  route: ResolvedCanaryRoute | null;
  verdict: string;
  detail?: string;
  recordPath: string | null;
  record: HermesCanaryRecord | null;
  contracts: CanaryContractResult[];
  notCovered: readonly CanaryNotCoveredProbe[];
}

export function isLocalProviderEntry(entry: Pick<ProviderFileEntry, 'kind' | 'baseUrl'>): boolean {
  if (entry.kind === 'lmstudio' || entry.kind === 'ollama') return true;
  try {
    const host = new URL(entry.baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function toHermesOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function estimateCanaryCost(routeName: string, providerId: string, model: string): string {
  return `route="${routeName}" provider="${providerId}" model="${model}" — 1 minimal turn (~500-3,000 input tokens, <=20 output tokens; typically <$0.01 USD)`;
}

async function readOptionalFile(ctx: DoctorContext, filePath: string): Promise<string | null> {
  try {
    return await ctx.fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export async function resolveHermesCanaryRoute(
  ctx: DoctorContext,
  options: Pick<RunHermesCanaryOptions, 'modelRoute' | 'paid' | 'confirmPaid'> = {},
): Promise<RouteSelectionOutcome> {
  const providersText = await readOptionalFile(
    ctx,
    path.join(ctx.paths.harnessDir, 'providers.yaml'),
  );
  if (providersText === null) {
    return {
      kind: 'skip',
      reason: 'providers.yaml not found; configure a local endpoint first',
    };
  }
  const providersParsed = parseProvidersYaml(providersText);
  const providersById = new Map(providersParsed.providers.map((p) => [p.id, p]));
  const routingText = await readOptionalFile(ctx, path.join(ctx.paths.harnessDir, 'routing.yaml'));
  const routing = routingText
    ? parseRoutingYaml(routingText, providersById.keys())
    : { routes: {}, rules: {}, issues: [] };

  // 1. Explicit `--model <route>` requested by user
  if (options.modelRoute) {
    const entry = routing.routes[options.modelRoute];
    if (!entry) {
      return {
        kind: 'error',
        reason: `route "${options.modelRoute}" is not defined in routing.yaml`,
      };
    }
    const provider = providersById.get(entry.provider);
    if (!provider) {
      return {
        kind: 'error',
        reason: `route "${options.modelRoute}" references unknown provider "${entry.provider}"`,
      };
    }
    const local = isLocalProviderEntry(provider);
    if (!local) {
      if (!options.paid) {
        return {
          kind: 'refused',
          reason: `route "${options.modelRoute}" uses API provider "${provider.id}" (paid); re-run with --paid after owner confirmation in chat`,
        };
      }
      if (provider.keyEnv && !ctx.env?.[provider.keyEnv]) {
        return {
          kind: 'error',
          reason: `paid route "${options.modelRoute}" requires env var ${provider.keyEnv} (not set)`,
        };
      }
      const expectedCost = estimateCanaryCost(options.modelRoute, provider.id, entry.model);
      const confirmed = options.confirmPaid
        ? await options.confirmPaid({
            routeName: options.modelRoute,
            providerId: provider.id,
            model: entry.model,
            expectedCost,
          })
        : false;
      if (!confirmed) {
        return {
          kind: 'refused',
          reason: `paid canary cancelled (confirmation required for ${expectedCost})`,
        };
      }
      return {
        kind: 'ok',
        route: {
          routeName: options.modelRoute,
          providerId: provider.id,
          model: entry.model,
          baseUrl: toHermesOpenAiBaseUrl(provider.baseUrl),
          local: false,
          ...(provider.keyEnv ? { keyEnv: provider.keyEnv } : {}),
        },
        expectedCostNote: expectedCost,
      };
    }

    const probe = await ctx.probe(provider, { timeoutMs: PROBE_TIMEOUT_MS, env: ctx.env });
    if (probe.status !== 'online') {
      return {
        kind: 'skip',
        reason: `local provider "${provider.id}" for route "${options.modelRoute}" is ${probe.status}: ${probe.error ?? 'offline'}`,
      };
    }
    return {
      kind: 'ok',
      route: {
        routeName: options.modelRoute,
        providerId: provider.id,
        model: entry.model,
        baseUrl: toHermesOpenAiBaseUrl(provider.baseUrl),
        local: true,
      },
    };
  }

  // 2. Default local selection: routing.yaml `local-small`, else any online local route,
  // else first online local provider's first discovered model.
  const localProviders = providersParsed.providers.filter(isLocalProviderEntry);
  if (localProviders.length === 0) {
    return {
      kind: 'skip',
      reason: 'no local provider configured in providers.yaml (or pass --model <route> --paid)',
    };
  }

  const probeResults = new Map<string, Awaited<ReturnType<DoctorContext['probe']>>>();
  const probeLocal = async (p: ProviderFileEntry) => {
    const existing = probeResults.get(p.id);
    if (existing) return existing;
    const res = await ctx.probe(p, { timeoutMs: PROBE_TIMEOUT_MS, env: ctx.env });
    probeResults.set(p.id, res);
    return res;
  };

  // Prefer `local-small` first if configured on a local provider
  const orderedRouteNames = [
    ...(routing.routes['local-small'] ? ['local-small'] : []),
    ...Object.keys(routing.routes).filter((n) => n !== 'local-small'),
  ];

  for (const name of orderedRouteNames) {
    const r = routing.routes[name];
    if (!r) continue;
    const provider = providersById.get(r.provider);
    if (!provider || !isLocalProviderEntry(provider)) continue;
    const probe = await probeLocal(provider);
    if (probe.status !== 'online') continue;
    if (probe.models.length > 0 && !probe.models.includes(r.model)) continue;
    return {
      kind: 'ok',
      route: {
        routeName: name,
        providerId: provider.id,
        model: r.model,
        baseUrl: toHermesOpenAiBaseUrl(provider.baseUrl),
        local: true,
      },
    };
  }

  // Fallback: first online local provider with any discovered model
  for (const provider of localProviders) {
    const probe = await probeLocal(provider);
    if (probe.status === 'online' && probe.models.length > 0) {
      return {
        kind: 'ok',
        route: {
          routeName: `provider:${provider.id}`,
          providerId: provider.id,
          model: probe.models[0]!,
          baseUrl: toHermesOpenAiBaseUrl(provider.baseUrl),
          local: true,
        },
      };
    }
  }

  return {
    kind: 'skip',
    reason: `no local endpoint online (tried: ${localProviders.map((p) => p.id).join(', ')})`,
  };
}

/**
 * Resolve the executable to spawn for isolated throwaway runs.
 *
 * `hermes-cindy` is a safety wrapper that hardcodes `export HERMES_HOME="$HOME/.hermes-cindy"`
 * before `exec hermes "$@"`. If we spawned `hermes-cindy` directly, it would clobber the
 * canary's throwaway `HERMES_HOME` back to `~/.hermes-cindy`. After verifying `hermes-cindy`
 * itself passes safety checks, unwrap `exec <cmd>` when it exports `HERMES_HOME=` so the
 * child runs inside the throwaway directory only.
 */
async function resolveIsolatedHermesBinary(
  ctx: DoctorContext,
  launcherPath: string,
): Promise<string> {
  try {
    const scriptText = await ctx.fs.readFile(launcherPath, 'utf8');
    if (/\bexport\s+HERMES_HOME=/.test(scriptText)) {
      const execMatch = scriptText.match(/^\s*exec\s+([^\s'"]+|'[^']+'|"[^"]+")/m);
      if (execMatch) {
        const rawTarget = execMatch[1]!.replace(/^['"]|['"]$/g, '');
        if (path.isAbsolute(rawTarget)) {
          if (!isDailyHermesPath(rawTarget, ctx.paths.home, ctx.platform)) {
            return rawTarget;
          }
        } else if (rawTarget && rawTarget !== 'hermes-cindy') {
          const resolved = await resolveCommandOnPath(rawTarget, ctx);
          if (resolved) return resolved;
        }
      }
    }
  } catch {
    // non-script binary or unreadable; run launcherPath directly
  }
  return launcherPath;
}

export interface ThrowawayCanaryHome {
  rootDir: string;
  hermesHome: string;
  cwd: string;
  linked: string[];
}

/**
 * Build a fresh throwaway `HERMES_HOME` under `$TMPDIR/cindy-doctor-canary-<stamp>/`.
 * Symlinks ONLY the shared Python runtime cache (`installs` / `venv`), generates minimal
 * `config.yaml`, and NEVER copies or links `.env`, `auth.json`, `SOUL.md`, `skills`, or DBs.
 */
export async function prepareThrowawayCanaryHome(
  ctx: DoctorContext,
  route: ResolvedCanaryRoute,
  options: { tmpDir?: string } = {},
): Promise<ThrowawayCanaryHome> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  const tmpBase = path.resolve(options.tmpDir ?? os.tmpdir());
  const rootDir = await fs.mkdtemp(path.join(tmpBase, `cindy-doctor-canary-${stamp}-`));
  const hermesHome = path.join(rootDir, 'home');
  const cwd = path.join(rootDir, 'cwd');

  assertNotDailyHermes(hermesHome, ctx.paths.home);
  if (path.resolve(hermesHome).startsWith(path.resolve(ctx.paths.hermesHome))) {
    await fs.rm(rootDir, { recursive: true, force: true });
    throw new Error('throwaway canary home must not be inside real hermesHome');
  }

  await fs.mkdir(hermesHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(cwd, { recursive: true });

  const linked: string[] = [];
  for (const name of ['installs', 'venv']) {
    const src = path.join(ctx.paths.hermesHome, name);
    try {
      await fs.lstat(src);
    } catch {
      continue;
    }
    await fs.symlink(src, path.join(hermesHome, name));
    linked.push(name);
  }

  const minimalConfig = [
    'model:',
    `  default: ${JSON.stringify(route.model)}`,
    '  provider: custom',
    `  base_url: ${JSON.stringify(route.baseUrl)}`,
    'agent:',
    '  max_turns: 4',
    '',
  ].join('\n');
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), minimalConfig, {
    encoding: 'utf8',
    mode: 0o600,
  });

  return { rootDir, hermesHome, cwd, linked };
}

async function spawnHermesCanaryTurn(
  req: HermesCanarySpawnRequest,
): Promise<HermesCanarySpawnResult> {
  return new Promise<HermesCanarySpawnResult>((resolve) => {
    const child = spawn(req.binPath, req.args, {
      cwd: req.cwd,
      env: req.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (res: HermesCanarySpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 1_000).unref?.();
      finish({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr:
          Buffer.concat(stderrChunks).toString('utf8') +
          `\ncindy-doctor canary: timed out after ${req.timeoutMs} ms`,
      });
    }, Math.max(1, req.timeoutMs));
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.write(req.stdinText);
    child.stdin.end();

    child.on('error', (err) => {
      finish({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: err.message,
      });
    });

    child.on('close', (code) => {
      finish({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
}

async function loadNewestReferenceFixture(
  repoRoot: string,
): Promise<{ file: string; events: HermesStreamEvent[] }> {
  const fixtureDir = path.join(
    repoRoot,
    'packages',
    'maker-hermes-manager',
    'src',
    '__tests__',
    'fixtures',
  );
  const files = await fs.readdir(fixtureDir);
  const newest = selectNewestRealHermesFixture(files);
  if (!newest) {
    throw new Error(`no real-hermes-*.ndjson fixture found under ${fixtureDir}`);
  }
  const text = await fs.readFile(path.join(fixtureDir, newest), 'utf8');
  return { file: newest, events: parseNdjsonEvents(text) };
}

export async function runHermesCanary(
  ctx: DoctorContext,
  options: RunHermesCanaryOptions = {},
): Promise<RunHermesCanaryResult> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);

  const probe = await probeHermes(ctx);
  if (!probe.version || !probe.launcherPath) {
    return {
      ok: false,
      status: 'error',
      version: probe.version,
      launcherPath: probe.launcherPath ?? null,
      execBinPath: null,
      route: null,
      verdict: `do not bump: hermes-cindy unavailable (${probe.error ?? 'missing'})`,
      detail: probe.error,
      recordPath: null,
      record: null,
      contracts: [],
      notCovered: CANARY_NOT_COVERED_PROBES,
    };
  }

  const routeOutcome = await resolveHermesCanaryRoute(ctx, options);
  if (routeOutcome.kind !== 'ok') {
    return {
      ok: routeOutcome.kind === 'skip',
      status: routeOutcome.kind,
      version: probe.version,
      launcherPath: probe.launcherPath,
      execBinPath: null,
      route: null,
      verdict: routeOutcome.reason,
      detail: routeOutcome.reason,
      recordPath: null,
      record: null,
      contracts: [],
      notCovered: CANARY_NOT_COVERED_PROBES,
    };
  }

  const route = routeOutcome.route;
  const execBinPath = await resolveIsolatedHermesBinary(ctx, probe.launcherPath);
  const reference = await loadNewestReferenceFixture(ctx.paths.repoRoot);
  const throwaway = await prepareThrowawayCanaryHome(ctx, route, { tmpDir: options.tmpDir });

  try {
    const apiKey = route.keyEnv ? ctx.env?.[route.keyEnv] : undefined;
    const args = [
      'chat',
      '--format', 'stream-json',
      '--query-file', '-',
      '--in', throwaway.cwd,
      '-m', route.model,
      '--provider', 'custom',
      '--base-url', route.baseUrl,
      '--api-key', apiKey ?? 'cindy-canary-local',
      '--safe-mode',
      '-t', '',
    ];

    const runner = options.spawnTurn ?? spawnHermesCanaryTurn;
    const spawnEnv: Record<string, string | undefined> = {
      ...(ctx.env ?? process.env),
      HERMES_HOME: throwaway.hermesHome,
      HERMES_MGR_CHILD: '1',
    };
    const turnResult = await runner({
      binPath: execBinPath,
      args,
      cwd: throwaway.cwd,
      hermesHome: throwaway.hermesHome,
      env: spawnEnv,
      stdinText: `${HERMES_CANARY_PROMPT}\n`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    });

    const candidateEvents = parseNdjsonEvents(turnResult.stdout, {
      ignoreNonJsonLines: true,
    });
    let agentLogText = '';
    try {
      agentLogText = await fs.readFile(path.join(throwaway.hermesHome, 'logs', 'agent.log'), 'utf8');
    } catch {
      agentLogText = '';
    }

    const evaluated = evaluateHermesCanaryContracts({
      candidateEvents,
      referenceEvents: reference.events,
      referenceLabel: reference.file,
      agentLogText,
      launchRun: {
        exitCode: turnResult.exitCode,
        stderr: turnResult.stderr,
        events: candidateEvents,
      },
    });

    const record: HermesCanaryRecord = {
      version: probe.version,
      at: ctx.now().toISOString(),
      route,
      passed: evaluated.passed,
      verdict: evaluated.verdict,
      contracts: evaluated.contracts,
      notCovered: evaluated.notCovered,
    };

    const recordPath = resolveHermesCanaryRecordPath(ctx, probe.version);
    await atomicWriteJson(recordPath, record);

    return {
      ok: evaluated.passed,
      status: evaluated.passed ? 'passed' : 'failed',
      version: probe.version,
      launcherPath: probe.launcherPath,
      execBinPath,
      route,
      verdict: evaluated.verdict,
      recordPath,
      record,
      contracts: evaluated.contracts,
      notCovered: evaluated.notCovered,
    };
  } finally {
    await fs.rm(throwaway.rootDir, { recursive: true, force: true });
  }
}
