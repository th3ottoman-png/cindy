// @vitest-environment jsdom

/**
 * Hermes draft slot: one model, no effort, and only a permission mode the
 * HermesAgent actually implements (its capabilities reject 'auto').
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { __resetForTest, getDraft, switchVendor } from '@/state/newMakerDraft';

beforeEach(() => {
  __resetForTest();
});

describe('newMakerDraft hermes defaults', () => {
  it('seeds the single hermes model without inventing effort or routing', () => {
    expect(getDraft().lastByVendor.hermes).toMatchObject({
      model: 'hermes-default',
      effort: '',
      permissionMode: 'default',
      planMode: false,
      providerId: null,
    });
  });

  it('accepts hermes as the active vendor', () => {
    switchVendor('hermes');
    expect(getDraft().vendor).toBe('hermes');
  });
});
