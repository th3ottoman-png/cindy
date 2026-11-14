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
import { loadProvidersFile, type ProviderFileEntry } from './providers-file.js';
import { loadRoutingFile, resolveTaskRoute } from './routing-file.js';

export type RoutedTaskClass = 'title' | 'predict' | 'summary' | 'vision';

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

/** Reasoning-only local models put their answer here and leave `content` empty. */
function extractReasoning(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return null;
  const rec = message as Record<string, unknown>;
  const text = rec.reasoning_content ?? rec.reasoning;
  return typeof text === 'string' ? text : null;
}

/**
 * One OpenAI-compatible chat-completions call. Shared by the routed task path and the explicit
 * target path so both keep the same key handling, redirect refusal and abort semantics.
 */
interface ChatCompletionCall {
  entry: ProviderFileEntry;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Accept `reasoning_content` when `content` is empty. Off by default: a title taken from a
   * model's thinking would be garbage. A caller that only needs to find JSON anywhere in the
   * reply can turn it on for reasoning-only local models.
   */
  acceptReasoningContent?: boolean;
}

type ChatCompletionOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string };

async function postChatCompletion(call: ChatCompletionCall): Promise<ChatCompletionOutcome> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (call.entry.keyEnv) {
    const key = call.env[call.entry.keyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const body = JSON.stringify({
    model: call.model,
    messages: call.messages,
    max_tokens: call.maxTokens,
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  const onCallerAbort = () => controller.abort();
  call.signal?.addEventListener('abort', onCallerAbort);
  // A signal aborted before the call never fires its event; mirror its state once.
  if (call.signal?.aborted) controller.abort();
  try {
    const res = await call.fetchImpl(chatCompletionsUrl(call.entry.baseUrl), {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, message: 'reply is not JSON' };
    }
    // `content` is often an empty string (not null) on a reasoning-only model, so treat blank
    // as absent before falling back.
    const direct = extractContent(parsed);
    const content = direct && direct.trim()
      ? direct
      : (call.acceptReasoningContent ? extractReasoning(parsed) : null);
    if (content === null || !content.trim()) {
      return { ok: false, message: 'reply has no message content' };
    }
    return { ok: true, text: content.trim() };
  } catch (error) {
    const message = call.signal?.aborted
      ? 'aborted'
      : controller.signal.aborted
        ? `no reply within ${call.timeoutMs} ms`
        : error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onCallerAbort);
  }
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

  const messages = [
    ...(args.systemPrompt ? [{ role: 'system', content: args.systemPrompt }] : []),
    { role: 'user', content: args.prompt },
  ];
  const outcome = await postChatCompletion({
    entry: entry!,
    env,
    fetchImpl,
    model: health.model,
    messages,
    maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return outcome.ok
    ? { kind: 'ok', text: outcome.text, routeName: health.routeName, provider: health.provider, model: health.model }
    : { kind: 'failed', message: outcome.message, routeName: health.routeName, provider: health.provider, model: health.model };
}

export interface RouteTargetTextRequest {
  /** providers.yaml id, exactly as the owner wrote it. */
  provider: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  signal?: AbortSignal;
  /** See ChatCompletionCall.acceptReasoningContent. */
  acceptReasoningContent?: boolean;
}

export type RouteTargetTextResult =
  | { kind: 'ok'; text: string; provider: string; model: string }
  | {
    kind: 'failed';
    reason: 'invalid-target' | 'unknown-provider' | 'offline' | 'call-failed';
    message: string;
    provider: string;
    model: string;
  };

/**
 * Generate text on one exact providers.yaml endpoint and model, bypassing routing.yaml.
 *
 * The council needs this: the owner picks reviewers explicitly, so resolving a task class would
 * ignore the pick. Same fail-closed discipline as the routed path: unknown provider and offline
 * endpoint are reported, never substituted, and the key goes only to that entry's own host.
 */
export async function requestRouteTargetText(
  args: RouteTargetTextRequest,
  deps: RoutedTaskTextDeps = {},
): Promise<RouteTargetTextResult> {
  const {
    harnessDir = path.join(os.homedir(), '.cindy-harness'),
    env = process.env,
    fetchImpl = fetch,
  } = deps;
  const provider = args.provider.trim();
  const model = args.model.trim();
  if (!provider || !model) {
    return {
      kind: 'failed',
      reason: 'invalid-target',
      message: 'a provider and a model are required',
      provider,
      model,
    };
  }

  const providersFile = loadProvidersFile(path.join(harnessDir, 'providers.yaml'));
  const entry = providersFile.providers.find((p) => p.id === provider);
  if (!entry) {
    return {
      kind: 'failed',
      reason: 'unknown-provider',
      message: `${provider} is not in providers.yaml`,
      provider,
      model,
    };
  }

  const probe = await probeEndpoint(entry, {
    timeoutMs: args.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    env,
    fetchImpl,
  });
  if (probe.status !== 'online') {
    return {
      kind: 'failed',
      reason: 'offline',
      message: probe.error ?? `${provider} answered a probe as ${probe.status}`,
      provider,
      model,
    };
  }

  const outcome = await postChatCompletion({
    entry,
    env,
    fetchImpl,
    model,
    messages: [
      ...(args.systemPrompt ? [{ role: 'system', content: args.systemPrompt }] : []),
      { role: 'user', content: args.prompt },
    ],
    maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(args.acceptReasoningContent ? { acceptReasoningContent: true } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return outcome.ok
    ? { kind: 'ok', text: outcome.text, provider, model }
    : { kind: 'failed', reason: 'call-failed', message: outcome.message, provider, model };
}
