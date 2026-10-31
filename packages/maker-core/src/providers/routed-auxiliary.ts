/**
 * Run an auxiliary task (title / predict / summary) on the owner-routed endpoint (ROADMAP 2.3b).
 *
 * Reads `~/.cindy-harness/providers.yaml` (2.1a) and `routing.yaml` (2.3a), resolves the task
 * class with `resolveTaskRoute`, health-checks the route with the 2.4a assessment against a live
 * 2.2a probe, then makes one OpenAI-compatible chat-completions call to that endpoint and returns
 * the text.
 *
 * Fail-closed rules this file exists to enforce:
 * - No routing rule for the task → `not-routed`: the caller keeps its existing behaviour and
 *   nothing changes for an owner who never wrote a routing.yaml.
 * - A rule that exists but cannot be used (broken rule, offline endpoint, missing model, failed
 *   call) → `blocked` / `failed` with a reason and healthy alternatives. Nothing here ever
 *   substitutes another model, so an explicit routing decision can never turn into a silent call
 *   to a different (paid) provider (ROADMAP 2.4).
 *
 * The key comes only from the env var named by `keyEnv` and is sent only to that same host;
 * redirects are refused so a key cannot be bounced elsewhere. Never throws.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  assessRoute,
  type BlockReason,
  type RouteAlternative,
} from '@cindy/model-providers/route-health';

import { probeEndpoint } from './discovery.js';
import { loadProvidersFile } from './providers-file.js';
import { loadRoutingFile, resolveTaskRoute } from './routing-file.js';

export type RoutedTaskClass = 'title' | 'predict' | 'summary';

export interface RoutedTaskTextRequest {
  taskClass: RoutedTaskClass | (string & {});
  prompt: string;
  /** Optional system message placed before the user prompt. */
  systemPrompt?: string;
  /** Sent as `max_tokens`. */
  maxTokens?: number;
  /** Budget for the generation call. */
  timeoutMs?: number;
  /** Budget for the pre-flight `/models` probe. */
  probeTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface RoutedTaskTextDeps {
  /** Directory holding `providers.yaml` and `routing.yaml`. Default `~/.cindy-harness`. */
  harnessDir?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export type RoutedTaskTextResult =
  /** No routing rule for this task: the caller keeps its existing chain. */
  | { kind: 'not-routed' }
  /** The owner routed this task but the route cannot be used. Never auto-substituted. */
  | { kind: 'blocked'; reason: BlockReason | 'invalid-rule'; message: string; alternatives: RouteAlternative[] }
  /** The route was healthy but the generation call itself failed. */
  | { kind: 'failed'; message: string; routeName: string; provider: string; model: string }
  | { kind: 'ok'; text: string; routeName: string; provider: string; model: string };

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** URL of the OpenAI-compatible chat-completions endpoint for a base URL (Ollama serves it too). */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function extractContent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : null;
}

/**
 * Generate text for one auxiliary task on the routed endpoint. Never throws; every failure mode
 * is a `{ kind }` result the caller decides on (see the fail-closed rules in the header).
 */
export async function requestRoutedTaskText(
  args: RoutedTaskTextRequest,
  deps: RoutedTaskTextDeps = {},
): Promise<RoutedTaskTextResult> {
  const {
    harnessDir = path.join(os.homedir(), '.cindy-harness'),
    env = process.env,
    fetchImpl = fetch,
  } = deps;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = args.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const providersFile = loadProvidersFile(path.join(harnessDir, 'providers.yaml'));
  const routing = loadRoutingFile(
    path.join(harnessDir, 'routing.yaml'),
    providersFile.providers.map((p) => p.id),
  );

  const resolution = resolveTaskRoute(routing, args.taskClass);
  if (!resolution.ok) {
    // A rule the owner wrote for THIS task but that failed validation (unknown route, bad
    // value) is an explicit broken routing decision: fail closed, do not fall through.
    const ruleIssues = routing.issues.filter((i) => i.where === `rules.${args.taskClass}`);
    if (ruleIssues.length > 0) {
      return {
        kind: 'blocked',
        reason: 'invalid-rule',
        message: ruleIssues.map((i) => i.message).join('; '),
        alternatives: [],
      };
    }
    return { kind: 'not-routed' };
  }

  const entry = providersFile.providers.find((p) => p.id === resolution.target.provider);
  const probeOptions = { timeoutMs: probeTimeoutMs, env, fetchImpl };
  const probe = entry
    ? await probeEndpoint(entry, probeOptions)
    : { id: resolution.target.provider, status: 'error' as const, models: [], latencyMs: 0 };
  let health = assessRoute(resolution, routing, providersFile.providers, [probe]);
  if (!health.ok) {
    // Only the blocked path pays for probing the other routed providers, so the
    // "use X instead" suggestions are real (2.4a) without slowing the happy path.
    const otherIds = new Set(Object.values(routing.routes).map((t) => t.provider));
    otherIds.delete(probe.id);
    const otherProbes = await Promise.all(
      providersFile.providers.filter((p) => otherIds.has(p.id)).map((p) => probeEndpoint(p, probeOptions)),
    );
    health = assessRoute(resolution, routing, providersFile.providers, [probe, ...otherProbes]);
  }
  if (!health.ok) {
    return { kind: 'blocked', reason: health.reason, message: health.message, alternatives: health.alternatives };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (entry?.keyEnv) {
    const key = env[entry.keyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const messages = [
    ...(args.systemPrompt ? [{ role: 'system', content: args.systemPrompt }] : []),
    { role: 'user', content: args.prompt },
  ];
  const body = JSON.stringify({
    model: health.model,
    messages,
    max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  args.signal?.addEventListener('abort', onCallerAbort);
  // A signal aborted before the call never fires its event; mirror its state once.
  if (args.signal?.aborted) controller.abort();
  try {
    const res = await fetchImpl(chatCompletionsUrl(entry!.baseUrl), {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      return { kind: 'failed', message: `HTTP ${res.status}`, routeName: health.routeName, provider: health.provider, model: health.model };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { kind: 'failed', message: 'reply is not JSON', routeName: health.routeName, provider: health.provider, model: health.model };
    }
    const content = extractContent(parsed);
    if (content === null || !content.trim()) {
      return { kind: 'failed', message: 'reply has no message content', routeName: health.routeName, provider: health.provider, model: health.model };
    }
    return { kind: 'ok', text: content.trim(), routeName: health.routeName, provider: health.provider, model: health.model };
  } catch (error) {
    const message = args.signal?.aborted
      ? 'aborted'
      : controller.signal.aborted
        ? `no reply within ${timeoutMs} ms`
        : error instanceof Error ? error.message : String(error);
    return { kind: 'failed', message, routeName: health.routeName, provider: health.provider, model: health.model };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onCallerAbort);
  }
}
