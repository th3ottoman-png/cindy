import { describe, expect, it } from 'vitest';
import {
  homeMarketQuery,
  isHomeMarketResponseCurrent,
  visibleHomeCatalogTabs,
} from '../homeMarketFilter';

describe('Skill home market filters', () => {
  it('maps public and organization to generic catalog scopes', () => {
    expect(homeMarketQuery('public')).toEqual({
      scope: 'market',
      visibility: 'all',
      sort: 'trending',
    });
    expect(homeMarketQuery('organization')).toEqual({
      scope: 'team',
      visibility: 'all',
      sort: 'trending',
    });
  });

  it('returns local-only tabs by default, or places local skills after public when remote is enabled', () => {
    expect(visibleHomeCatalogTabs(false)).toEqual(['local']);
    expect(visibleHomeCatalogTabs(true)).toEqual(['local']);
    expect(visibleHomeCatalogTabs(false, true)).toEqual(['public', 'local']);
    expect(visibleHomeCatalogTabs(true, true)).toEqual(['public', 'organization', 'local']);
  });

  it('does not present a response from the previous tab as current', () => {
    expect(isHomeMarketResponseCurrent(homeMarketQuery('public'), {
      scope: 'market',
      mine: true,
    })).toBe(false);
    expect(isHomeMarketResponseCurrent(homeMarketQuery('public'), {
      scope: 'market',
      mine: false,
    })).toBe(true);
  });
});
