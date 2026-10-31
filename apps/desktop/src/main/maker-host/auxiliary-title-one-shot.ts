/**
 * Session-title routing through the shared auxiliary-model chain.
 *
 * Owner routing wins first (ROADMAP 2.3b): when `~/.cindy-harness/routing.yaml` routes the
 * `title` task class, the title is generated on that endpoint and a blocked or failed route
 * fails closed — it never falls through to the auxiliary chain or a paid provider (ROADMAP 2.4).
 * With no routing rule, behaviour is unchanged: automatic and custom chains both go through
 * `requestUtilityText`. Automatic routing may fall back to the owning session agent when the
 * auxiliary chain is unavailable; an explicit custom/env chain remains fail-closed.
 */

import type { AgentKind } from '@cindy/maker-core';
import {
  requestRoutedTaskText,
  type RoutedTaskTextRequest,
  type RoutedTaskTextResult,
} from '@cindy/maker-core/routed-auxiliary';
import { AUTO_TITLE_MAX_CHARS } from '@cindy/maker-shared/session-title';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';
import { readAuxiliaryModelSettings } from '../utility-model/auxiliary-model-settings-store.js';
import {
  agentSupportsOneShot,
  requestUtilityText,
} from '../utility-model/oneShotCandidates.js';
import {
  getEffectiveAuxiliaryModelChain,
  getEffectiveAuxiliaryModelChainSnapshot,
} from '../utility-model/resolveAuxiliaryModelChain.js';
import { getMaker } from './index.js';
import type { TitleOneShotDeps, TitleOneShotResult } from './title-one-shot.js';
import { validateTitleOutput } from './title-output-validation.js';

const log = createLogger('maker-host/auxiliary-title-one-shot');

const AUXILIARY_TITLE_TIMEOUT_MS = 12_000;
// Allow multi-byte Chinese / emoji titles within the shared character limit.
const AUXILIARY_TITLE_MAX_TOKENS = AUTO_TITLE_MAX_CHARS * 4;
const AUXILIARY_TITLE_OUTPUT_MAX_CHARS = 256;
// Routed (owner-picked) endpoints bill the owner per their own provider, and a routed
// reasoning model spends part of the budget thinking before it answers. 160 tokens can
// come back with empty content (seen live on LM Studio qwen3-8b), so the routed call gets
// a headroom budget and a longer wall-clock cap; the chain constants above stay untouched.
const ROUTED_TITLE_MAX_TOKENS = 1_024;
const ROUTED_TITLE_TIMEOUT_MS = 45_000;
const AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS =
  'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.';

interface AuxiliaryTitleRuntimeDeps {
  readModels: () => string[] | Promise<string[]>;
  readOwnerScope: () => string | Promise<string>;
  requestText: (
    prompt: string,
    opts: Parameters<typeof requestUtilityText>[2],
  ) => ReturnType<typeof requestUtilityText>;
  /** Owner `routing.yaml` lookup for the `title` task class (ROADMAP 2.3b). */
  requestRouted: (args: RoutedTaskTextRequest) => Promise<RoutedTaskTextResult>;
}

const DEFAULT_DEPS: AuxiliaryTitleRuntimeDeps = {
  readModels: () => readAuxiliaryModelSettings().models,
  readOwnerScope: () => activeOwnerScopeKey(),
  requestText: (prompt, opts) => requestUtilityText(getMaker(), prompt, opts),
  requestRouted: (args) => requestRoutedTaskText(args),
};

type TitleRequest = {
  sessionId: string;
  agentKind: AgentKind;
  prompt: string;
  signal?: AbortSignal;
};

export interface AuxiliaryTextRequest {
  agentKind: AgentKind;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  responseInstructions: string;
  signal?: AbortSignal;
  /**
   * Automatic chains fall back to the owning session agent by default. A caller that is
   * latency-bound (the Market opening, with a user waiting) sets `false`: an agent one-shot
   * starts a whole agent process and cannot beat the auxiliary chain, it only spends the budget.
   */
  sessionAgentFallback?: boolean;
}
export type AuxiliaryTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * One short, tool-less text generation shared by every host-written line (session titles, Market
 * openings): the auxiliary chain first, then — only in automatic mode and unless the caller opts
 * out with `sessionAgentFallback: false` — the owning session agent, so a signed-out user still gets
 * a result. Custom/env chains stay fail-closed.
 */
export async function requestAuxiliaryText(
  args: AuxiliaryTextRequest,
  deps: AuxiliaryTitleRuntimeDeps = DEFAULT_DEPS,
): Promise<AuxiliaryTextResult> {
  const ownerScope = await deps.readOwnerScope();
  const models = [...await deps.readModels()];
  const snapshot = JSON.stringify(models);
  const auxiliaryChain = getEffectiveAuxiliaryModelChain();
  const auxiliaryChainSnapshot = getEffectiveAuxiliaryModelChainSnapshot();
  const beforeDispatch = async () => {
    if (isAppSessionBoundaryPending()) return false;
    if ((await deps.readOwnerScope()) !== ownerScope) return false;
    if (getEffectiveAuxiliaryModelChainSnapshot() !== auxiliaryChainSnapshot) return false;
    const currentModels = JSON.stringify(await deps.readModels());
    return !isAppSessionBoundaryPending()
      && (await deps.readOwnerScope()) === ownerScope
      && getEffectiveAuxiliaryModelChainSnapshot() === auxiliaryChainSnapshot
      && currentModels === snapshot;
  };
  const beforeSessionAgentDispatch = async () =>
    !(await isAgentOneShotRouteDisabled(args.agentKind)) && await beforeDispatch();
  const result = await deps.requestText(args.prompt, {
    maxTokens: args.maxTokens,
    timeoutMs: args.timeoutMs,
    // Short budgets cannot afford provider-default thinking. Messages /
    // chat routes receive their native disable flag; Responses routes use the
    // lowest supported effort because that protocol has no off value.
    disableReasoning: true,
    reasoningEffort: 'minimal',
    responseInstructions: args.responseInstructions,
    signal: args.signal,
    // Settings may change while OAuth refresh/credential discovery awaits.
    beforeDispatch,
  });
  if (result.ok) return { ok: true, text: result.text };
  // A signed-out user still has the current session agent available. Only
  // the automatic chain may use that same-agent fallback; custom and env
  // chains are explicit routing decisions and must remain fail-closed.
  const canFallbackToSessionAgent = args.sessionAgentFallback !== false
    && auxiliaryChain.source === 'auto'
    && agentSupportsOneShot(args.agentKind)
    && await beforeSessionAgentDispatch();
  if (canFallbackToSessionAgent) {
    try {
      const fallbackText = await getMaker().oneShot(args.agentKind, args.prompt, {
        maxTokens: args.maxTokens,
        timeoutMs: args.timeoutMs,
        signal: args.signal,
        responseInstructions: args.responseInstructions,
        beforeDispatch: beforeSessionAgentDispatch,
      });
      if (fallbackText.trim()) return { ok: true, text: fallbackText };
    } catch (error) {
      log.warn('auxiliary text session agent fallback failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        reason: (error as { reason?: unknown } | null)?.reason,
      });
    }
  }
  return { ok: false, reason: result.reason };
}

async function generateAuxiliaryTitle(
  args: TitleRequest,
  deps: AuxiliaryTitleRuntimeDeps,
): Promise<TitleOneShotResult> {
  // The owner's routing.yaml decides first. `not-routed` keeps the historical chain below;
  // an explicit route that cannot run fails closed instead of silently spending a paid call.
  const routed = await deps.requestRouted({
    taskClass: 'title',
    prompt: args.prompt,
    systemPrompt: AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS,
    maxTokens: ROUTED_TITLE_MAX_TOKENS,
    timeoutMs: ROUTED_TITLE_TIMEOUT_MS,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (routed.kind === 'ok') {
    log.debug('title generated on routed endpoint', {
      routeName: routed.routeName,
      provider: routed.provider,
      model: routed.model,
    });
    const routedTitle = normalizeAuxiliaryTitle(routed.text);
    return routedTitle ? { status: 'ok', title: routedTitle } : { status: 'failed' };
  }
  if (routed.kind !== 'not-routed') {
    log.warn('routed title generation unavailable — failing closed', {
      kind: routed.kind,
      ...(routed.kind === 'blocked'
        ? { reason: routed.reason, message: routed.message, alternatives: routed.alternatives.map((a) => a.routeName) }
        : { message: routed.message, routeName: routed.routeName, provider: routed.provider, model: routed.model }),
    });
    return { status: 'failed' };
  }
  const result = await requestAuxiliaryText({
    agentKind: args.agentKind,
    prompt: args.prompt,
    maxTokens: AUXILIARY_TITLE_MAX_TOKENS,
    timeoutMs: AUXILIARY_TITLE_TIMEOUT_MS,
    responseInstructions: AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS,
    signal: args.signal,
  }, deps);
  if (!result.ok) {
    log.warn('auxiliary title model failed', { reason: result.reason });
    return { status: 'failed' };
  }
  const title = normalizeAuxiliaryTitle(result.text);
  return title ? { status: 'ok', title } : { status: 'failed' };
}

function normalizeAuxiliaryTitle(text: string): string | null {
  // Validate the complete response before the historical 40-character visual
  // truncation, matching title-one-shot's persisted-content boundary.
  const normalized = validateTitleOutput(text, AUXILIARY_TITLE_OUTPUT_MAX_CHARS);
  return normalized
    ? Array.from(normalized).slice(0, AUTO_TITLE_MAX_CHARS).join('')
    : null;
}

export async function generateTitleWithAuxiliaryModel(
  args: TitleRequest,
  _legacyDeps: TitleOneShotDeps = {},
  runtimeDeps: Partial<AuxiliaryTitleRuntimeDeps> = {},
): Promise<string | null> {
  const deps = { ...DEFAULT_DEPS, ...runtimeDeps };
  const result = await generateAuxiliaryTitle(args, deps);
  return result.status === 'ok' ? result.title : null;
}

export async function generateTitleWithAuxiliaryModelResult(
  args: TitleRequest,
  _legacyDeps: TitleOneShotDeps = {},
  runtimeDeps: Partial<AuxiliaryTitleRuntimeDeps> = {},
): Promise<TitleOneShotResult> {
  const deps = { ...DEFAULT_DEPS, ...runtimeDeps };
  return generateAuxiliaryTitle(args, deps);
}
