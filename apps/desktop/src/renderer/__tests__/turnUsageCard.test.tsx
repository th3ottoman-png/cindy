// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { TurnUsageCard } from '@/components/chat/TurnUsageCard';
import { buildTurnUsageCard, cacheReadShare } from '@/lib/turnUsageCard';
import type { TurnUsageDetails } from '../../shared/turnUsageDetails';
import { legacyUsdMoney } from '../../shared/regionalMoney';

const t = i18n.t.bind(i18n) as unknown as Parameters<typeof buildTurnUsageCard>[0]['t'];

function details(overrides: Partial<TurnUsageDetails> = {}): TurnUsageDetails {
  const base: TurnUsageDetails = {
    inputTokens: 1200,
    outputTokens: 400,
    cacheReadTokens: 800,
    cacheCreateTokens: 200,
    totalTokens: 2600,
    durationMs: 4000,
    turnDurationMs: 12000,
    cacheHitRate: 800 / 2200,
    model: 'deepseek-flash',
    provider: 'deepseek',
  };
  return { ...base, ...overrides };
}

const row = (model: ReturnType<typeof buildTurnUsageCard>, key: string) =>
  model.rows.find((entry) => entry.key === key);

afterEach(() => {
  cleanup();
});

describe('buildTurnUsageCard', () => {
  it('reports every number the turn stored', () => {
    const model = buildTurnUsageCard({ details: details(), t, money: legacyUsdMoney(0.0112) });
    expect(row(model, 'input')?.value).toBe('1.2k');
    expect(row(model, 'cacheRead')?.value).toBe('800');
    expect(row(model, 'cacheRead')?.hint).toBe('36.4% of input');
    expect(row(model, 'cacheWrite')?.value).toBe('200');
    expect(row(model, 'output')?.value).toBe('400');
    expect(row(model, 'total')?.value).toBe('2.6k');
    expect(row(model, 'speed')?.value).toBe('100 tok/s');
    expect(model.cost).toEqual({ kind: 'reported', text: '$0.0112' });
  });

  it('never invents a cache share when nothing was read or fed', () => {
    const zero = buildTurnUsageCard({
      details: details({ cacheReadTokens: 0, inputTokens: 900, cacheCreateTokens: 0 }),
      t,
    });
    expect(row(zero, 'cacheRead')?.value).toBe('0');
    expect(row(zero, 'cacheRead')?.hint).toBeUndefined();

    const nothing = buildTurnUsageCard({
      details: details({ cacheReadTokens: 0, inputTokens: 0, cacheCreateTokens: 0 }),
      t,
    });
    expect(row(nothing, 'cacheRead')?.hint).toBeUndefined();
    expect(cacheReadShare(details({ cacheReadTokens: 0, inputTokens: 0, cacheCreateTokens: 0 }))).toBeNull();
  });

  it('keeps partial rows for a turn that spent tokens but reported no timings', () => {
    const cancelled = buildTurnUsageCard({
      details: details({ durationMs: undefined, turnDurationMs: undefined, outputTokens: 0 }),
      t,
    });
    expect(row(cancelled, 'speed')?.value).toBe('—');
    expect(row(cancelled, 'speed')?.hint).toBe('not reported by this harness');
    expect(row(cancelled, 'totalTime')?.value).toBe('—');
    // The spend it did report is still there.
    expect(row(cancelled, 'total')?.value).toBe('2.6k');
  });

  it('labels the first-token row as receipt-relative and says when it is missing', () => {
    const model = buildTurnUsageCard({ details: details(), t });
    expect(row(model, 'firstToken')?.label).toBe('First token (since receipt)');
    expect(row(model, 'firstToken')?.value).toBe('—');
    expect(row(model, 'firstToken')?.hint).toBe('not reported by this harness');
    const withValue = buildTurnUsageCard({ details: details(), t, firstTokenMs: 1500 });
    expect(row(withValue, 'firstToken')?.value).toBe('1.5s');
  });

  it('says "cost unknown" rather than $0.00 for an unpriced model', () => {
    expect(buildTurnUsageCard({ details: details(), t }).cost).toEqual({ kind: 'unknown', text: 'Cost unknown' });
    expect(buildTurnUsageCard({ details: details(), t, money: legacyUsdMoney(0) }).cost.kind).toBe('unknown');
  });

  it('marks an estimated cost instead of presenting it as billed', () => {
    const model = buildTurnUsageCard({ details: details(), t, money: legacyUsdMoney(0.02), isEstimate: true });
    expect(model.cost.kind).toBe('estimated');
    expect(model.cost.text.startsWith('~')).toBe(true);
  });
});

describe('TurnUsageCard', () => {
  it('opens on focus and closes on Escape — never hover-only', () => {
    render(<TurnUsageCard details={details()} money={legacyUsdMoney(0.0112)} label="$0.0112" />);
    const trigger = screen.getByTestId('turn-usage-trigger');
    expect(screen.queryByTestId('turn-usage-card')).toBeNull();
    fireEvent.focus(trigger);
    expect(screen.getByTestId('turn-usage-card')).toBeTruthy();
    expect(screen.getByTestId('turn-usage-input').textContent).toBe('1.2k');
    expect(screen.getByTestId('turn-usage-cost').textContent).toBe('$0.0112');
    fireEvent.keyDown(screen.getByTestId('turn-usage-card'), { key: 'Escape' });
    expect(screen.queryByTestId('turn-usage-card')).toBeNull();
  });

  it('renders the unknown-cost state as text, not a blank', () => {
    render(<TurnUsageCard details={details()} label="2.6k tok" />);
    fireEvent.focus(screen.getByTestId('turn-usage-trigger'));
    const cost = screen.getByTestId('turn-usage-cost');
    expect(cost.getAttribute('data-cost-kind')).toBe('unknown');
    expect(cost.textContent).toBe('Cost unknown');
  });
});
