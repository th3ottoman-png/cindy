/**
 * Context-window guard (ROADMAP 2.5a). Pure logic: how full is the conversation relative to the
 * active model's context length, and, when it is getting full, can the routed `summary` model
 * do "summarise and continue" right now. The summariser comes from `routing.yaml` through the
 * same no-silent-fallback check as every other route (2.4a): if it is blocked, the answer says
 * so and lists alternatives; it never swaps in another model.
 */

import { assessRoute, type ProbeLike, type RouteHealth } from './routeHealth.js';
import type { ProviderFileEntry } from './providersFile.js';
import { resolveTaskRoute, type RoutingFile } from './routingFile.js';

export type ContextLevel = 'unknown' | 'ok' | 'warn' | 'critical';

export interface ContextThresholds {
  /** Fraction of the window at which to warn. Default 0.8. */
  warnAt?: number;
  /** Fraction at which the warning becomes critical. Default 0.95. */
  criticalAt?: number;
}

export interface ContextAssessment {
  level: ContextLevel;
  usedTokens: number;
  contextLength?: number;
  /** used / contextLength, when both are known. */
  fraction?: number;
  remainingTokens?: number;
  message: string;
}

export function assessContext(
  usedTokens: number,
  contextLength: number | undefined,
  thresholds: ContextThresholds = {},
): ContextAssessment {
  const { warnAt = 0.8, criticalAt = 0.95 } = thresholds;
  if (!(warnAt > 0 && warnAt < criticalAt && criticalAt <= 1)) {
    throw new RangeError('thresholds must satisfy 0 < warnAt < criticalAt <= 1');
  }
  if (!Number.isFinite(usedTokens) || usedTokens < 0) {
    return { level: 'unknown', usedTokens: 0, contextLength, message: 'token usage is not known yet' };
  }
  if (contextLength === undefined || !Number.isFinite(contextLength) || contextLength <= 0) {
    return { level: 'unknown', usedTokens, message: 'this model\'s context length is not set (add capabilities.contextLength in providers.yaml), so no warning can be given' };
  }
  const fraction = usedTokens / contextLength;
  const remainingTokens = Math.max(0, contextLength - usedTokens);
  const pct = Math.round(fraction * 100);
  const base = { usedTokens, contextLength, fraction, remainingTokens };
  if (fraction >= criticalAt) return { ...base, level: 'critical', message: `Context is ${pct}% full (${remainingTokens} tokens left); the next turns may be cut off or fail` };
  if (fraction >= warnAt) return { ...base, level: 'warn', message: `Context is ${pct}% full (${remainingTokens} tokens left)` };
  return { ...base, level: 'ok', message: `Context is ${pct}% full` };
}

export interface ContextGuardInput extends ContextThresholds {
  usedTokens: number;
  /** Context length of the model the session is using (providers.yaml capabilities.contextLength). */
  contextLength?: number;
  routing: RoutingFile;
  providers: ProviderFileEntry[];
  probes: ProbeLike[];
}

export interface ContextGuardResult {
  context: ContextAssessment;
  /**
   * Present only at `warn` or `critical`: whether "summarise and continue" can run on the routed
   * summariser. `ok: false` carries the reason and alternatives; nothing is substituted.
   */
  summarise?: RouteHealth;
}

export function guardContext(input: ContextGuardInput): ContextGuardResult {
  const context = assessContext(input.usedTokens, input.contextLength, { warnAt: input.warnAt, criticalAt: input.criticalAt });
  if (context.level !== 'warn' && context.level !== 'critical') return { context };
  return { context, summarise: assessRoute(resolveTaskRoute(input.routing, 'summary'), input.routing, input.providers, input.probes) };
}
