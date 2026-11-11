import { describe, expect, it } from 'vitest';

import type { ModelPricingCatalog } from '../../../shared/regionalMoney.js';
import { hermesTurnMoney } from '../sessionHermesTurnUsage.js';

/** A small, explicit catalog: Hermes turns are priced from Cindy's own table, never guessed. */
const CATALOG: ModelPricingCatalog = {
  deepseek: {
    'deepseek-flash': {
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      currency: 'USD',
      source: 'provider-reference',
      approximate: true,
      inputPerMtok: 1,
      outputPerMtok: 2,
      cacheReadPerMtok: 0.1,
      cacheCreatePerMtok: 1.25,
    },
  },
};

function details(overrides: Partial<Parameters<typeof hermesTurnMoney>[0]['details']> = {}) {
  return {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    model: 'deepseek-flash',
    provider: 'deepseek',
    ...overrides,
  };
}

describe('hermesTurnMoney', () => {
  it('prices a turn from the reference table as an estimate, not an invoice', () => {
    const money = hermesTurnMoney({ details: details(), pricing: CATALOG, currency: 'USD' });
    expect(money).not.toBeNull();
    expect(money!.amount).toBeCloseTo(2, 6);
    expect(money!.kind).toBe('value-estimate');
    expect(money!.approximate).toBe(true);
  });

  it('prices cached input at the cache-read rate', () => {
    const money = hermesTurnMoney({
      details: details({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
      pricing: CATALOG,
      currency: 'USD',
    });
    expect(money!.amount).toBeCloseTo(0.1, 6);
  });

  it('refuses to price without a provider — a local model must not take a cloud tariff', () => {
    expect(hermesTurnMoney({ details: details({ provider: undefined }), pricing: CATALOG, currency: 'USD' })).toBeNull();
  });

  it('returns nothing when the table has no quote for the model', () => {
    expect(hermesTurnMoney({ details: details({ model: 'some-local-7b' }), pricing: CATALOG, currency: 'USD' })).toBeNull();
    expect(hermesTurnMoney({ details: details(), pricing: null, currency: 'USD' })).toBeNull();
  });

  it('returns nothing for a turn that spent no tokens', () => {
    const money = hermesTurnMoney({
      details: details({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }),
      pricing: CATALOG,
      currency: 'USD',
    });
    expect(money === null || money.amount === 0).toBe(true);
  });
});
