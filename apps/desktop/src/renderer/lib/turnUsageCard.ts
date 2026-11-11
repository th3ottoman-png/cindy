/**
 * Per-turn usage & latency card (ROADMAP 10.4).
 *
 * One turn's numbers, built from what the transcript already stores
 * (`ChatMessage.turnUsageDetails` + `turnMoney`) — no new IPC, no new event. Pure: the caller
 * supplies the money, the flag for "this cost is an estimate", and a `t`, so the same model can be
 * asserted in a test without a DOM.
 *
 * Two honesty rules drive the shape:
 *   - a rate needs a duration the harness actually reported; without one the value is `—`, never a
 *     invented number;
 *   - first-token time is receipt-relative (the raw `maker:event` payload carries no timestamp, see
 *     the 5.3b notes), so the row says so in its label instead of implying Hermes's own TTFT.
 */

import type { TFunction } from 'i18next';

import type { RegionalMoney } from '../../shared/regionalMoney';
import type { TurnUsageDetails } from '../../shared/turnUsageDetails';
import {
  formatCompactTokens,
  formatTurnCostMoney,
} from '@/lib/usageFormat';
import {
  formatOutputTokenRate,
  formatTurnDuration,
} from '@/lib/turnUsageTooltip';

export type TurnUsageCostKind = 'reported' | 'estimated' | 'unknown';

export interface TurnUsageCardRow {
  key: string;
  label: string;
  value: string;
  /** Small grey note under the value, e.g. "no generation time reported". */
  hint?: string;
}

export interface TurnUsageCardModel {
  rows: TurnUsageCardRow[];
  cost: { kind: TurnUsageCostKind; text: string };
}

export interface TurnUsageCardInput {
  details: TurnUsageDetails;
  t: TFunction;
  money?: RegionalMoney;
  /** Legacy messages carry USD only. */
  costUsd?: number;
  isEstimate?: boolean;
  /** Receipt-relative first-token time; absent when the harness reported none. */
  firstTokenMs?: number | null;
}

function tokens(value: number): string {
  return formatCompactTokens(Math.max(0, Math.floor(value)));
}

/** Cache read as a share of everything the model was fed this turn. */
export function cacheReadShare(details: TurnUsageDetails): number | null {
  const read = Math.max(0, Math.floor(details.cacheReadTokens));
  const denominator = read + Math.max(0, Math.floor(details.inputTokens)) + Math.max(0, Math.floor(details.cacheCreateTokens));
  if (denominator <= 0) return null;
  return read / denominator;
}

function formatShare(share: number | null): string | null {
  if (share === null || !Number.isFinite(share)) return null;
  const pct = Math.min(100, Math.max(0, share * 100));
  const rounded = Math.abs(pct - Math.round(pct)) < 0.05 ? `${Math.round(pct)}` : pct.toFixed(1).replace(/\.0$/, '');
  return `${rounded}%`;
}

/**
 * A single turn often costs a fraction of a cent, where the row's two-decimal text reads "$0.01"
 * for anything from $0.005 to $0.014. The card is where the actual number matters, so it keeps
 * four decimals below one unit — the same rule the session usage tables use.
 */
function costText(money: RegionalMoney | undefined, isEstimate: boolean): string {
  if (!money || !Number.isFinite(money.amount) || money.amount <= 0) return '';
  const symbol = money.currency === 'USD' ? '$' : money.currency === 'CNY' ? '¥' : `${money.currency} `;
  const abs = Math.abs(money.amount);
  const decimals = abs < 1 ? 4 : 2;
  const fixed = money.amount.toFixed(decimals);
  const trimmed = decimals > 2 ? fixed.replace(/(\.\d{2,}?)0+$/, '$1') : fixed;
  const formatted = `${symbol}${trimmed}`;
  return isEstimate ? `~${formatted}` : formatted;
}

export function buildTurnUsageCard(input: TurnUsageCardInput): TurnUsageCardModel {
  const { details, t, money, isEstimate = false } = input;
  const rows: TurnUsageCardRow[] = [];

  rows.push({
    key: 'input',
    label: t('chat.turnUsage.input'),
    value: tokens(details.inputTokens),
  });

  const share = cacheReadShare(details);
  const shareText = formatShare(share);
  rows.push({
    key: 'cacheRead',
    label: t('chat.turnUsage.cacheRead'),
    value: tokens(details.cacheReadTokens),
    // A turn with no cache read renders the plain zero — never "0 (0%)" and never a divide-by-zero.
    ...(details.cacheReadTokens > 0 && shareText ? { hint: t('chat.turnUsage.ofInput', { share: shareText }) } : {}),
  });

  rows.push({
    key: 'cacheWrite',
    label: t('chat.turnUsage.cacheWrite'),
    value: tokens(details.cacheCreateTokens),
  });

  rows.push({
    key: 'output',
    label: t('chat.turnUsage.output'),
    value: tokens(details.outputTokens),
  });

  rows.push({
    key: 'total',
    label: t('chat.turnUsage.total'),
    value: tokens(details.totalTokens),
  });

  // First token: receipt-relative, and only when the caller had a measurement.
  const firstTokenMs = input.firstTokenMs ?? null;
  const firstTokenValue = firstTokenMs !== null && Number.isFinite(firstTokenMs) && firstTokenMs >= 0
    ? (formatTurnDuration(firstTokenMs, t) ?? '—')
    : '—';
  rows.push({
    key: 'firstToken',
    label: t('chat.turnUsage.firstTokenReceipt'),
    value: firstTokenValue,
    ...(firstTokenMs === null ? { hint: t('chat.turnUsage.notReported') } : {}),
  });

  // Total time: wall clock when the harness reported it, else the generation time we do have.
  const wallMs = details.turnDurationMs ?? details.durationMs;
  rows.push({
    key: 'totalTime',
    label: t('chat.turnUsage.totalTime'),
    value: typeof wallMs === 'number' ? (formatTurnDuration(wallMs, t) ?? '—') : '—',
    ...(typeof wallMs !== 'number' ? { hint: t('chat.turnUsage.notReported') } : {}),
  });

  // Speed: output tokens per second of *generation*, which is the only duration that is about the
  // model rather than tool calls and thinking about what to do next.
  const rate = formatOutputTokenRate(details);
  rows.push({
    key: 'speed',
    label: t('chat.turnUsage.speed'),
    value: rate ? t('chat.turnUsage.tokensPerSecond', { rate }) : '—',
    hint: rate ? t('chat.turnUsage.generationOnly') : t('chat.turnUsage.notReported'),
  });

  const cost = costText(money, isEstimate);
  return {
    rows,
    cost: cost
      ? { kind: isEstimate ? 'estimated' : 'reported', text: cost }
      : { kind: 'unknown', text: t('chat.turnUsage.costUnknown') },
  };
}
