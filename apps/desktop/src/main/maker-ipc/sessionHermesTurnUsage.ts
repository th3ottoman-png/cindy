/**
 * Hermes per-turn usage recorder (ROADMAP 1.9b-1).
 *
 * The Hermes agent reports per-turn token/cache detail in its `done` event
 * (`data.usage`), but nothing persisted it: `sessionEventPipeline` wires a
 * recorder per agent kind (Claude Code, Codex, Pi) and Hermes had none. The
 * result was that every Hermes conversation in the database carried **zero**
 * usage rows, so a conversation cost panel had nothing to show for the agent
 * the owner actually drives.
 *
 * This recorder stores the usage *facts* only — tokens, the model the turn ran
 * on, and the provider the route used — in `messages.agent_meta.turnUsageDetails`,
 * exactly like `recordTurnUsageOnMessage` does for the other agents. It does
 * not price anything: the amount is resolved from the desktop pricing layer by
 * the conversation adapter (1.9b-2), which is the only place that knows which
 * quote applies. Money is therefore never invented here.
 *
 * The provider is a Hermes-home fact, not a Cindy session fact: Hermes picks
 * its own provider in `config.yaml` (`model.provider`), and the desktop session
 * provider store knows nothing about it. Reading the route here keeps the
 * stored turn self-contained — a turn remembers the provider it ran on, so a
 * later change to the home route cannot re-price past turns under a different
 * tariff.
 */

import type { AgentEvent, Session } from '@cindy/maker-core';

import { buildTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails.js';
import type { ModelPricingCatalog, RegionalMoney } from '../../shared/regionalMoney.js';
import { getModelPriceQuote } from '../usage/modelPricing.js';
import { computePriceQuoteTurnMoney } from '../usage/turnCostCalculator.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import { recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { recordTurnCostOnMessage, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';

/** The Hermes home route the turn ran on. */
export interface HermesTurnRoute {
  /** Home default model id; the fallback when the CLI did not report one. */
  model?: string;
  /** Provider id from the home route (`model.provider`), e.g. 'deepseek'. */
  provider?: string;
}

/**
 * Prices one Hermes turn from Cindy's own reference table.
 *
 * Hermes reports tokens, never money, so before this the card said "Cost unknown" for every turn.
 * The quote comes from the same catalog Codex/Pi use for BYOK routes (`getReferenceModelPricing`),
 * so the number is a **value estimate** (`kind: 'value-estimate'`, rendered with `~`), never an
 * invoice. Both the model and the provider must be known: without a provider there is no quote key,
 * and guessing one would price a local model at a cloud tariff.
 */
export function hermesTurnMoney(input: {
  details: Pick<TurnUsageDetails, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreateTokens' | 'model' | 'provider'>;
  pricing: ModelPricingCatalog | null | undefined;
  currency?: ReturnType<typeof currentLedgerCurrency>;
}): RegionalMoney | null {
  const model = input.details.model?.trim();
  const provider = input.details.provider?.trim();
  if (!model || !provider) return null;
  const quote = getModelPriceQuote(input.pricing, provider, model);
  if (!quote) return null;
  return computePriceQuoteTurnMoney(
    {
      inputTokens: input.details.inputTokens,
      outputTokens: input.details.outputTokens,
      cacheReadTokens: input.details.cacheReadTokens,
      cacheCreateTokens: input.details.cacheCreateTokens,
    },
    quote,
    input.currency ?? currentLedgerCurrency(),
  );
}

export interface RecordSessionHermesTurnUsageDeps {
  /**
   * Reads the Hermes home route. Optional: without it the turn still records
   * its tokens and the model the CLI reported, but it has no provider, so the
   * pricing layer cannot price it. Never throws.
   */
  readonly readHermesRoute?: () => Promise<HermesTurnRoute>;
  /** Reference pricing catalog; tests inject a synthetic one. Never throws. */
  readonly readPricing?: () => ModelPricingCatalog | null;
}

interface HermesUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
  /** Model id the CLI reported in its `system/init` event. */
  model?: string;
  /**
   * providers.yaml endpoint id when the turn ran on a per-session route (e.g.
   * "lmstudio-local"). Absent = the Hermes home route (ROADMAP 1.9b-3c).
   */
  provider?: string;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Records one Hermes turn's usage facts on the turn's assistant message.
 *
 * Fire-and-forget: a failed price/route lookup must never lose the token
 * facts, and a failed write must never break the turn.
 */
export function recordSessionHermesTurnUsage(
  deps: RecordSessionHermesTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  turnAssistantPersistId: string | undefined,
): void {
  if (event.type !== 'done' || event.source !== 'hermes') return;
  const rawUsage = (event.data as { usage?: unknown } | undefined)?.usage;
  if (!rawUsage || typeof rawUsage !== 'object') return;

  const usage = rawUsage as HermesUsagePayload;
  const inputTokens = asCount(usage.inputTokens);
  const outputTokens = asCount(usage.outputTokens);
  const cacheReadTokens = asCount(usage.cacheReadTokens);
  const cacheCreateTokens = asCount(usage.cacheCreationTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens;
  if (totalTokens <= 0) return;

  void recordSessionTurnTokens(session.id, totalTokens);

  void (async () => {
    // The route read is best effort: a missing or unreadable home config
    // costs the price, never the tokens.
    const route = deps.readHermesRoute
      ? await deps.readHermesRoute().catch(() => ({}) as HermesTurnRoute)
      : ({} as HermesTurnRoute);
    // The CLI's own report wins: it names the model this turn actually ran
    // on, even when the home default changed in between.
    const model = asText(usage.model) ?? asText(route.model);
    // A per-session route (LM Studio, Ollama, …) names its own endpoint; only a turn on
    // the home route takes the home provider. Otherwise a local model was labelled and
    // priced as the home provider's (owner report 2026-11-01: "deepseek/google/gemma-…").
    const provider = asText(usage.provider) ?? asText(route.provider);
    const turnUsageDetails = buildTurnUsageDetails({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      model,
      provider,
      durationMs: typeof usage.durationMs === 'number' ? usage.durationMs : undefined,
    });
    if (!turnUsageDetails || !turnAssistantPersistId) return;
    // Price first, store tokens regardless: a missing quote must never cost the token facts.
    let money: RegionalMoney | null = null;
    try {
      money = hermesTurnMoney({
        details: turnUsageDetails,
        pricing: deps.readPricing ? deps.readPricing() : getReferenceModelPricing(),
      });
    } catch {
      money = null;
    }
    if (money && money.amount > 0) {
      await recordTurnCostOnMessage({
        sessionId: session.id,
        clientId: turnAssistantPersistId,
        money,
        turnUsageDetails,
      });
      return;
    }
    await recordTurnUsageOnMessage({
      sessionId: session.id,
      clientId: turnAssistantPersistId,
      turnUsageDetails,
    });
  })();
}
