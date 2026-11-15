/**
 * Endpoints doctor pack (`endpoint.*`, ROADMAP 14.4, blueprint §3 & §11).
 *
 * Probes local endpoints listed in `~/.cindy-harness/providers.yaml` always; remote/API
 * endpoints are ONLY probed when `--include-api` (`ctx.includeApi === true`) is set so default
 * doctor runs make zero outbound network calls. Also assesses every routing rule via
 * `@cindy/model-providers/route-health` (`assessRoute`) with local-first alternatives.
 */

import * as path from 'node:path';

import {
  assessRoute,
  type ProbeLike,
  type RouteHealth,
} from '@cindy/model-providers/route-health';

import {
  parseProvidersYaml,
  type ProviderFileEntry,
} from '../../providers/providers-file.js';
import type { EndpointProbe } from '../../providers/discovery.js';
import {
  parseRoutingYaml,
  resolveTaskRoute,
  type RoutingParseResult,
} from '../../providers/routing-file.js';
import { redactText } from '../redact.js';
import { getActiveRunToken } from '../runner.js';
import type {
  CheckRunOutput,
  DoctorCheck,
  DoctorContext,
  DoctorPack,
} from '../types.js';

const ENDPOINT_PROBE_TIMEOUT_MS = 1_500;

/**
 * Per-run memoization of endpoint probes within a single `runChecks` invocation so
 * `endpoint.<id>` and `endpoint.routes` do not hit the same local endpoint twice,
 * while later `runChecks` calls on a reused `DoctorContext` re-probe fresh state.
 */
const probeCacheByRun = new WeakMap<object, Map<string, Promise<EndpointProbe>>>();

async function readOptionalUtf8(
  ctx: DoctorContext,
  filePath: string,
): Promise<{ exists: true; text: string } | { exists: false } | { exists: true; error: string }> {
  try {
    const text = await ctx.fs.readFile(filePath, 'utf8');
    return { exists: true, text };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { exists: false };
    return { exists: true, error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadProvidersAndRouting(ctx: DoctorContext): Promise<{
  providers: ProviderFileEntry[];
  providersError?: string;
  routing?: RoutingParseResult;
}> {
  const providersPath = path.join(ctx.paths.harnessDir, 'providers.yaml');
  const providersRead = await readOptionalUtf8(ctx, providersPath);
  if (!providersRead.exists) {
    return { providers: [] };
  }
  if ('error' in providersRead) {
    return { providers: [], providersError: providersRead.error };
  }

  const parsedProviders = parseProvidersYaml(providersRead.text);
  const providers = parsedProviders.providers;

  const routingPath = path.join(ctx.paths.harnessDir, 'routing.yaml');
  const routingRead = await readOptionalUtf8(ctx, routingPath);
  if (!routingRead.exists || 'error' in routingRead) {
    return { providers };
  }

  const routing = parseRoutingYaml(
    routingRead.text,
    providers.map((p) => p.id),
  );
  return { providers, routing };
}

function getRulesUsingProvider(
  providerId: string,
  routing: RoutingParseResult | undefined,
): string[] {
  if (!routing) return [];
  const tasks: string[] = [];
  for (const [task, routeName] of Object.entries(routing.rules)) {
    const target = routing.routes[routeName];
    if (target?.provider === providerId) {
      tasks.push(task);
    }
  }
  return tasks.sort();
}

function probeProviderCached(ctx: DoctorContext, entry: ProviderFileEntry): Promise<EndpointProbe> {
  const runKey = getActiveRunToken(ctx);
  let cache = probeCacheByRun.get(runKey);
  if (!cache) {
    cache = new Map();
    probeCacheByRun.set(runKey, cache);
  }
  const cacheKey = `${entry.id}\0${entry.kind}\0${entry.baseUrl}\0${Boolean(ctx.includeApi)}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const pending = ctx.probe(entry, {
    timeoutMs: ENDPOINT_PROBE_TIMEOUT_MS,
    env: ctx.env,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  cache.set(cacheKey, pending);
  return pending;
}

async function runSingleEndpointCheck(
  ctx: DoctorContext,
  entry: ProviderFileEntry,
): Promise<CheckRunOutput> {
  if (!entry.local && ctx.includeApi !== true) {
    return {
      severity: 'skip',
      summary: 'API endpoint skipped (pass --include-api to probe)',
      action: 'Re-run with --include-api if you want to check remote API reachability.',
      evidence: { providerId: entry.id, local: false, skippedOutbound: true },
    };
  }

  const probe = await probeProviderCached(ctx, entry);
  const redOpts = { homeDir: ctx.paths.home };
  const safeUrl = redactText(entry.baseUrl, redOpts);

  if (probe.status === 'online') {
    return {
      severity: 'ok',
      summary: `${entry.id} online (${probe.models.length} model(s), ${probe.latencyMs} ms)`,
      detail: `Endpoint: ${safeUrl}`,
      evidence: {
        providerId: entry.id,
        local: entry.local,
        status: probe.status,
        modelCount: probe.models.length,
        latencyMs: probe.latencyMs,
      },
    };
  }

  const { routing } = await loadProvidersAndRouting(ctx);
  const usedBy = getRulesUsingProvider(entry.id, routing);
  const isUsed = usedBy.length > 0;
  const safeErr = probe.error ? redactText(probe.error, redOpts) : probe.status;
  const usedLabel = isUsed ? `used by ${usedBy.join(', ')}` : 'not used by active routing rules';

  return {
    severity: isUsed ? 'fail' : 'warn',
    summary: `${entry.id} ${probe.status}: ${safeErr} (${usedLabel})`,
    detail: `Endpoint: ${safeUrl}\nStatus: ${probe.status}\nRouting: ${usedLabel}`,
    action: entry.local
      ? `Start ${entry.kind} at ${safeUrl} or switch affected rules in ~/.cindy-harness/routing.yaml.`
      : `Verify ${entry.keyEnv ?? 'API credentials'} and network connectivity for ${entry.id}.`,
    evidence: {
      providerId: entry.id,
      local: entry.local,
      status: probe.status,
      usedByRules: usedBy.length,
      latencyMs: probe.latencyMs,
    },
  };
}

function buildEndpointCheck(entry: ProviderFileEntry): DoctorCheck {
  return {
    id: `endpoint.${entry.id}`,
    layer: 'endpoints',
    title: `Endpoint (${entry.id})`,
    cost: 'fast',
    run: (ctx) => runSingleEndpointCheck(ctx, entry),
  };
}

function formatAlternatives(health: Extract<RouteHealth, { ok: false }>): string {
  if (health.alternatives.length === 0) return 'alternatives: none online';
  const items = health.alternatives.map(
    (alt) => `${alt.routeName} (${alt.provider}/${alt.model}${alt.paid ? ' [paid]' : ''})`,
  );
  return `alternatives: ${items.join(', ')}`;
}

async function runEndpointRoutes(ctx: DoctorContext): Promise<CheckRunOutput> {
  const { providers, providersError, routing } = await loadProvidersAndRouting(ctx);
  if (providersError) {
    return {
      severity: 'fail',
      summary: `Could not read providers.yaml: ${providersError}`,
      action: 'Check permissions on ~/.cindy-harness/providers.yaml.',
    };
  }
  if (!routing) {
    return { severity: 'ok', summary: 'No routing.yaml configured (optional)' };
  }

  const ruleTasks = Object.keys(routing.rules).sort((a, b) => {
    if (a === 'chat.default') return -1;
    if (b === 'chat.default') return 1;
    return a.localeCompare(b);
  });
  if (ruleTasks.length === 0) {
    return { severity: 'ok', summary: 'No routing rules defined in routing.yaml' };
  }

  const byProvider = new Map(providers.map((p) => [p.id, p]));
  const toProbe = providers.filter((p) => p.local || ctx.includeApi === true);
  const probeResults = await Promise.all(toProbe.map((entry) => probeProviderCached(ctx, entry)));
  const probes: ProbeLike[] = probeResults.map((p) => ({
    id: p.id,
    status: p.status,
    models: p.models,
    ...(p.error ? { error: p.error } : {}),
  }));

  const routingConfig = { routes: routing.routes, rules: routing.rules };
  const redOpts = { homeDir: ctx.paths.home };
  const blockedDetails: string[] = [];
  const blockedTasks: string[] = [];
  let checkedCount = 0;
  let skippedRemoteCount = 0;

  for (const task of ruleTasks) {
    const routeName = routing.rules[task]!;
    const routeTarget = routing.routes[routeName];
    const providerEntry = routeTarget ? byProvider.get(routeTarget.provider) : undefined;

    if (providerEntry && !providerEntry.local && ctx.includeApi !== true) {
      skippedRemoteCount += 1;
      continue;
    }

    checkedCount += 1;
    const resolution = resolveTaskRoute(routingConfig, task);
    const health = assessRoute(resolution, routingConfig, providers, probes);
    if (!health.ok) {
      blockedTasks.push(task);
      blockedDetails.push(
        `${task}: ${redactText(health.message, redOpts)} | ${formatAlternatives(health)}`,
      );
    }
  }

  if (blockedTasks.length > 0) {
    const skippedSuffix =
      skippedRemoteCount > 0 ? ` (${skippedRemoteCount} remote rule(s) not probed)` : '';
    return {
      severity: 'fail',
      summary: `${blockedTasks.length} routing rule(s) blocked (${blockedTasks.join(', ')})${skippedSuffix}`,
      detail: blockedDetails.join('\n'),
      action:
        'Start the offline local provider/model or update ~/.cindy-harness/routing.yaml to one of the listed alternatives.',
      evidence: {
        checkedRules: checkedCount,
        blockedRules: blockedTasks.length,
        skippedRemoteRules: skippedRemoteCount,
      },
    };
  }

  const skippedSuffix =
    skippedRemoteCount > 0
      ? ` (${skippedRemoteCount} remote rule(s) skipped; pass --include-api)`
      : '';
  return {
    severity: 'ok',
    summary: `All ${checkedCount} checked routing rule(s) healthy${skippedSuffix}`,
    evidence: {
      checkedRules: checkedCount,
      blockedRules: 0,
      skippedRemoteRules: skippedRemoteCount,
    },
  };
}

export const endpointsPack: DoctorPack = {
  name: 'endpoints',
  checks: [
    {
      id: 'endpoint.routes',
      layer: 'endpoints',
      title: 'Routing table health',
      cost: 'fast',
      run: runEndpointRoutes,
    },
  ],
  async discoverChecks(ctx: DoctorContext): Promise<readonly DoctorCheck[]> {
    const { providers } = await loadProvidersAndRouting(ctx);
    return providers.map(buildEndpointCheck);
  },
};
