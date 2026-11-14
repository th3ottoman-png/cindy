import { describe, expect, it } from 'vitest';

import { shouldAskRetitle } from '../useRetitleAfterTurn';

describe('shouldAskRetitle (ROADMAP 13.9)', () => {
  it('asks on a running-to-idle edge in the same session', () => {
    expect(shouldAskRetitle({ id: 's1', running: true }, { id: 's1', running: false })).toBe(true);
  });
  it('does not ask while still running, or when idle twice', () => {
    expect(shouldAskRetitle({ id: 's1', running: true }, { id: 's1', running: true })).toBe(false);
    expect(shouldAskRetitle({ id: 's1', running: false }, { id: 's1', running: false })).toBe(false);
  });
  it('does not ask when the session changed', () => {
    expect(shouldAskRetitle({ id: 's1', running: true }, { id: 's2', running: false })).toBe(false);
  });
  it('does not ask without a session id', () => {
    expect(shouldAskRetitle({ id: undefined, running: true }, { id: undefined, running: false })).toBe(false);
  });
});
