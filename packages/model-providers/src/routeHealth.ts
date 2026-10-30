/**
 * Route health and "no silent fallback" (ROADMAP 2.4a). Pure logic: given the resolved route
 * for a task, the providers from `providers.yaml` and the latest discovery probes, decide
 * whether the route can be used, and if not, say why and list OTHER routes the owner may pick.
 *
 * The rule this file exists to enforce: it never substitutes. A blocked route stays blocked;
 * `alternatives` are suggestions for a one-click "use X instead" that the owner must click, each
 * marked `paid` when its endpoint is not on this machine. Nothing here chooses one for them.
 */

import type { ProviderFileEntry } from './providersFile.js';
import type { RouteResolution, RoutingFile } from './routingFile.js';

/** The fields of a discovery probe this logic needs (structural, so this package stays dependency-free). */
export interface ProbeLike {
  id: string;
  status: 'online' | 'offline' | 'error';
  models: string[];
  error?: string;
}

export type BlockReason = 'no-route' | 'unknown-provider' | 'provider-offline' | 'provider-error' | 'not-probed' | 'model-missing';

export interface RouteAlternative {
  routeName: string;
  provider: string;
  model: string;
  /** True when the endpoint is not on this machine (a metered/remote provider). */
  paid: boolean;
}

export type RouteHealth =
  | { ok: true; routeName: string; provider: string; model: string }
  | {
      ok: false;
      reason: BlockReason;
      message: string;
      /** Healthy routes the owner could choose instead, local ones first. Never applied automatically. */
      alternatives: RouteAlternative[];
    };

/** Ollama lists "llama3:latest" for a model you may configure as "llama3". */
function hasModel(models: string[], wanted: string): boolean {
  return models.includes(wanted) || (!wanted.includes(':') && models.includes(`${wanted}:latest`));
}

export function assessRoute(
  resolution: RouteResolution,
  config: RoutingFile,
  providers: ProviderFileEntry[],
  probes: ProbeLike[],
): RouteHealth {
  const byProvider = new Map(providers.map((p) => [p.id, p]));
  const probeById = new Map(probes.map((p) => [p.id, p]));

  const problem = (provider: string, model: string): { reason: BlockReason; message: string } | undefined => {
    if (!byProvider.has(provider)) return { reason: 'unknown-provider', message: `provider "${provider}" is not in providers.yaml` };
    const probe = probeById.get(provider);
    if (!probe) return { reason: 'not-probed', message: `"${provider}" has not been checked yet` };
    if (probe.status === 'offline') return { reason: 'provider-offline', message: `"${provider}" is offline${probe.error ? ` (${probe.error})` : ''}` };
    if (probe.status === 'error') return { reason: 'provider-error', message: `"${provider}" answered with an error${probe.error ? ` (${probe.error})` : ''}` };
    if (!hasModel(probe.models, model)) return { reason: 'model-missing', message: `"${provider}" is online but does not list model "${model}"` };
    return undefined;
  };

  const alternativesExcluding = (skipRoute: string | undefined): RouteAlternative[] =>
    Object.entries(config.routes)
      .filter(([name, t]) => name !== skipRoute && problem(t.provider, t.model) === undefined)
      .map(([routeName, t]) => ({ routeName, provider: t.provider, model: t.model, paid: !byProvider.get(t.provider)!.local }))
      .sort((a, b) => Number(a.paid) - Number(b.paid) || a.routeName.localeCompare(b.routeName));

  if (!resolution.ok) {
    return { ok: false, reason: 'no-route', message: resolution.error, alternatives: alternativesExcluding(undefined) };
  }
  const { routeName, target } = resolution;
  const found = problem(target.provider, target.model);
  if (found) {
    return { ok: false, reason: found.reason, message: `Route "${routeName}": ${found.message}`, alternatives: alternativesExcluding(routeName) };
  }
  return { ok: true, routeName, provider: target.provider, model: target.model };
}
