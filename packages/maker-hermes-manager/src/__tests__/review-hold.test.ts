import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_REVIEW_HOLD_REASON,
  ReviewHold,
  reviewKey,
  type AutoReviewVerdict,
} from '../auto-review-gate.js';

// ROADMAP 1.13f: Hermes waits ~30 s at most for a hook, so a review that takes longer
// (owner answering a card, reviewer down) is held open and its late allow becomes a grant.

function deferred(): { promise: Promise<AutoReviewVerdict>; resolve: (v: AutoReviewVerdict) => void } {
  let resolve!: (v: AutoReviewVerdict) => void;
  const promise = new Promise<AutoReviewVerdict>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const HOLD_MS = 1_000;
const KEY = reviewKey('s1', { toolName: 'terminal', toolInput: { command: 'touch /tmp/x' } });

describe('ReviewHold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a fast verdict as is and keeps no grant', async () => {
    const hold = new ReviewHold({ holdMs: HOLD_MS });
    const start = vi.fn(async (): Promise<AutoReviewVerdict> => ({ decision: 'allow' }));
    await expect(hold.review(KEY, start)).resolves.toEqual({ decision: 'allow' });
    await expect(hold.review(KEY, start)).resolves.toEqual({ decision: 'allow' });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('blocks a slow review with the hold reason, then allows the retry once after the owner allows', async () => {
    const hold = new ReviewHold({ holdMs: HOLD_MS });
    const review = deferred();
    const start = vi.fn(() => review.promise);
    const first = hold.review(KEY, start);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await expect(first).resolves.toEqual({ decision: 'block', reason: AUTO_REVIEW_HOLD_REASON });

    review.resolve({ decision: 'allow' });
    await vi.advanceTimersByTimeAsync(0);
    const next = vi.fn(async (): Promise<AutoReviewVerdict> => ({ decision: 'block', reason: 'reviewed again' }));
    await expect(hold.review(KEY, next)).resolves.toEqual({ decision: 'allow' });
    expect(next).not.toHaveBeenCalled();
    // The grant is used up: the same call again is reviewed afresh.
    await expect(hold.review(KEY, next)).resolves.toEqual({ decision: 'block', reason: 'reviewed again' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lets a retry wait on the review still open instead of starting a second one', async () => {
    const hold = new ReviewHold({ holdMs: HOLD_MS });
    const review = deferred();
    const start = vi.fn(() => review.promise);
    const first = hold.review(KEY, start);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await first;
    const retry = hold.review(KEY, start);
    review.resolve({ decision: 'allow' });
    await expect(retry).resolves.toEqual({ decision: 'allow' });
    expect(start).toHaveBeenCalledTimes(1);
    // That retry received the allow itself, so no grant is left for a third call.
    const third = vi.fn(async (): Promise<AutoReviewVerdict> => ({ decision: 'block', reason: 'fresh' }));
    await expect(hold.review(KEY, third)).resolves.toEqual({ decision: 'block', reason: 'fresh' });
  });

  it('stores nothing when the late answer is a block', async () => {
    const hold = new ReviewHold({ holdMs: HOLD_MS });
    const review = deferred();
    const first = hold.review(KEY, () => review.promise);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await first;
    review.resolve({ decision: 'block', reason: 'You declined this action.' });
    await vi.advanceTimersByTimeAsync(0);
    const next = vi.fn(async (): Promise<AutoReviewVerdict> => ({ decision: 'block', reason: 'asked again' }));
    await expect(hold.review(KEY, next)).resolves.toEqual({ decision: 'block', reason: 'asked again' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores an expired grant', async () => {
    let now = 0;
    const hold = new ReviewHold({ holdMs: HOLD_MS, grantTtlMs: 5_000, now: () => now });
    const review = deferred();
    const first = hold.review(KEY, () => review.promise);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await first;
    review.resolve({ decision: 'allow' });
    await vi.advanceTimersByTimeAsync(0);
    now = 6_000;
    const next = vi.fn(async (): Promise<AutoReviewVerdict> => ({ decision: 'block', reason: 'expired' }));
    await expect(hold.review(KEY, next)).resolves.toEqual({ decision: 'block', reason: 'expired' });
  });

  it('turns a failed review into a block', async () => {
    const hold = new ReviewHold({ holdMs: HOLD_MS });
    await expect(hold.review(KEY, () => Promise.reject(new Error('boom')))).resolves.toEqual({
      decision: 'block',
      reason: 'Cindy auto-review failed.',
    });
  });
});

describe('reviewKey', () => {
  it('matches the same call regardless of tool_call_id and key order', () => {
    const a = reviewKey('s1', { toolName: 'terminal', toolInput: { command: 'ls', cwd: '/a' }, toolCallId: 'c1' });
    const b = reviewKey('s1', { toolName: 'terminal', toolInput: { cwd: '/a', command: 'ls' }, toolCallId: 'c2' });
    expect(a).toBe(b);
  });

  it('differs by session, tool and input', () => {
    const base = { toolName: 'terminal', toolInput: { command: 'ls' } };
    expect(reviewKey('s1', base)).not.toBe(reviewKey('s2', base));
    expect(reviewKey('s1', base)).not.toBe(reviewKey('s1', { ...base, toolName: 'write_file' }));
    expect(reviewKey('s1', base)).not.toBe(reviewKey('s1', { toolName: 'terminal', toolInput: { command: 'ls -a' } }));
  });
});
