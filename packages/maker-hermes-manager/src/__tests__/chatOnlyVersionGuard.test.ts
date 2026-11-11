import { describe, expect, it } from 'vitest';

import { supportsChatOnlyToolsets } from '../hermes-version.js';

/**
 * `-t ''` is measured behaviour, not a documented contract: an unknown or newer CLI must be
 * refused rather than trusted, because the failure it prevents is a "no tools" session that has
 * tools.
 */
describe('supportsChatOnlyToolsets', () => {
  it('accepts the measured line', () => {
    expect(supportsChatOnlyToolsets('0.22.7')).toBe(true);
    expect(supportsChatOnlyToolsets('v0.22.7')).toBe(true);
    expect(supportsChatOnlyToolsets('0.22.9')).toBe(true);
    expect(supportsChatOnlyToolsets('0.22.7-rc.1')).toBe(true);
    // 0.23.0 is the CLI actually installed here; `-t ''` was measured on it too.
    expect(supportsChatOnlyToolsets('0.23.0')).toBe(true);
    expect(supportsChatOnlyToolsets('0.23.4')).toBe(true);
  });

  it('refuses anything outside it', () => {
    expect(supportsChatOnlyToolsets('0.22.6')).toBe(false);
    expect(supportsChatOnlyToolsets('0.21.9')).toBe(false);
    expect(supportsChatOnlyToolsets('0.24.0')).toBe(false);
    expect(supportsChatOnlyToolsets('0.24.1')).toBe(false);
    expect(supportsChatOnlyToolsets('1.0.0')).toBe(false);
  });

  it('fails closed on an unknown version', () => {
    for (const value of [null, undefined, '', 'unknown', 'dev', '0.22']) {
      expect(supportsChatOnlyToolsets(value)).toBe(false);
    }
  });
});
