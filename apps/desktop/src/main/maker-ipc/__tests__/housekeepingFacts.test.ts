/**
 * Conversation facts for storage housekeeping (ROADMAP 13.2c).
 * Pure row → facts mapping; the database read itself is a thin wrapper.
 */

import { describe, expect, it } from 'vitest';

import { factsFromRows, isTurnInFlight } from '../housekeepingFacts.js';

function row(over: Record<string, unknown> = {}) {
  return {
    sdkSessionId: 'sdk-1',
    status: 'active',
    pinnedAt: null,
    activeTurnStartedAt: null,
    lastTurnEndedAt: null,
    scheduled: 0,
    ...over,
  };
}

describe('isTurnInFlight', () => {
  it('is false when no turn ever started', () => {
    expect(isTurnInFlight({ activeTurnStartedAt: null, lastTurnEndedAt: null })).toBe(false);
  });
  it('is true while a turn is running', () => {
    expect(isTurnInFlight({ activeTurnStartedAt: 200, lastTurnEndedAt: 100 })).toBe(true);
  });
  it('is true for an interrupted turn that never ended', () => {
    expect(isTurnInFlight({ activeTurnStartedAt: 200, lastTurnEndedAt: null })).toBe(true);
  });
  it('is false once the turn ended after it started', () => {
    expect(isTurnInFlight({ activeTurnStartedAt: 100, lastTurnEndedAt: 200 })).toBe(false);
  });
});

describe('factsFromRows', () => {
  it('protects a pinned conversation', () => {
    const facts = factsFromRows([row({ pinnedAt: 1 })]);
    expect(facts.bySdkSessionId['sdk-1']).toEqual({ status: 'active', protected: true });
  });
  it('protects a conversation an active schedule targets', () => {
    expect(factsFromRows([row({ scheduled: 2 })]).bySdkSessionId['sdk-1']?.protected).toBe(true);
  });
  it('does not protect a paused schedule', () => {
    expect(factsFromRows([row({ scheduled: 0 })]).bySdkSessionId['sdk-1']?.protected).toBe(false);
  });
  it('protects a conversation with a turn in flight', () => {
    const facts = factsFromRows([row({ activeTurnStartedAt: 9, lastTurnEndedAt: 1 })]);
    expect(facts.bySdkSessionId['sdk-1']?.protected).toBe(true);
  });
  it('carries the soft-deleted status so Tier 2 can keep the transcript', () => {
    const facts = factsFromRows([row({ status: 'deleted' })]);
    expect(facts.bySdkSessionId['sdk-1']).toEqual({ status: 'deleted', protected: false });
  });
  it('treats an unknown status as active, the safe answer', () => {
    expect(factsFromRows([row({ status: 'weird' })]).bySdkSessionId['sdk-1']?.status).toBe('active');
    expect(factsFromRows([row({ status: null })]).bySdkSessionId['sdk-1']?.status).toBe('active');
  });
  it('skips rows without an sdk session id', () => {
    expect(factsFromRows([row({ sdkSessionId: '' }), row({ sdkSessionId: null })]).bySdkSessionId).toEqual({});
  });
  it('returns an empty fact set for no rows', () => {
    expect(factsFromRows([])).toEqual({ bySdkSessionId: {} });
  });
});