/**
 * Recap trigger, prompt bounds and config (ROADMAP 13.3).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RECAP_AWAY_MINUTES,
  MAX_RECAP_AWAY_MINUTES,
  MIN_RECAP_AWAY_MINUTES,
  RECAP_MIN_TURNS,
  RECAP_PROMPT_CHAR_BUDGET,
  buildRecapPrompt,
  normalizeAwayMinutes,
  readRecapConfig,
  shouldRecap,
  writeRecapConfig,
  type RecapTriggerInput,
} from '../recap.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-recap-'));
  file = path.join(tmp, 'recap.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function trigger(over: Partial<RecapTriggerInput> = {}): RecapTriggerInput {
  return {
    enabled: true,
    lastFocusAt: NOW - 20 * MIN,
    now: NOW,
    awayMinutes: 15,
    turnCount: 6,
    lastRecapTurn: null,
    running: false,
    ...over,
  };
}

describe('normalizeAwayMinutes', () => {
  it('defaults for unusable input', () => {
    expect(normalizeAwayMinutes(undefined)).toBe(DEFAULT_RECAP_AWAY_MINUTES);
    expect(normalizeAwayMinutes('15')).toBe(DEFAULT_RECAP_AWAY_MINUTES);
    expect(normalizeAwayMinutes(Number.NaN)).toBe(DEFAULT_RECAP_AWAY_MINUTES);
  });
  it('clamps to the supported range and floors', () => {
    expect(normalizeAwayMinutes(0)).toBe(MIN_RECAP_AWAY_MINUTES);
    expect(normalizeAwayMinutes(-9)).toBe(MIN_RECAP_AWAY_MINUTES);
    expect(normalizeAwayMinutes(99_999)).toBe(MAX_RECAP_AWAY_MINUTES);
    expect(normalizeAwayMinutes(20.9)).toBe(20);
  });
});

describe('recap config file', () => {
  it('defaults to on with 15 minutes when the file is missing', () => {
    expect(readRecapConfig(file)).toEqual({ config: { enabled: true, awayMinutes: 15 } });
  });
  it('reports corrupt JSON and uses defaults instead of throwing', () => {
    fs.writeFileSync(file, '{not json');
    const { config, issue } = readRecapConfig(file);
    expect(config).toEqual({ enabled: true, awayMinutes: 15 });
    expect(issue).toMatch(/not readable JSON/);
  });
  it('reports a non-object file', () => {
    fs.writeFileSync(file, '[]');
    expect(readRecapConfig(file).issue).toMatch(/not an object/);
  });
  it('only an explicit false turns it off', () => {
    fs.writeFileSync(file, JSON.stringify({ awayMinutes: 30 }));
    expect(readRecapConfig(file).config.enabled).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ enabled: false }));
    expect(readRecapConfig(file).config.enabled).toBe(false);
  });
  it('lists an out-of-range awayMinutes and clamps it', () => {
    fs.writeFileSync(file, JSON.stringify({ awayMinutes: 0 }));
    const { config, issue } = readRecapConfig(file);
    expect(config.awayMinutes).toBe(MIN_RECAP_AWAY_MINUTES);
    expect(issue).toMatch(/clamped/);
  });
  it('round-trips through an atomic write with no temp leftovers', () => {
    expect(writeRecapConfig(file, { enabled: false, awayMinutes: 45 })).toEqual({ enabled: false, awayMinutes: 45 });
    expect(readRecapConfig(file).config).toEqual({ enabled: false, awayMinutes: 45 });
    expect(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('keeps the current value for a field the caller omits', () => {
    writeRecapConfig(file, { enabled: false, awayMinutes: 45 });
    expect(writeRecapConfig(file, { awayMinutes: 10 })).toEqual({ enabled: false, awayMinutes: 10 });
  });
});

describe('shouldRecap', () => {
  it('fires when the owner returns after the away window with new turns', () => {
    expect(shouldRecap(trigger())).toEqual({ recap: true, reason: 'ok' });
  });
  it('stays off when the setting is off', () => {
    expect(shouldRecap(trigger({ enabled: false })).reason).toBe('disabled');
  });
  it('never fires while a turn is running', () => {
    expect(shouldRecap(trigger({ running: true })).reason).toBe('running');
  });
  it('needs at least the minimum turn count', () => {
    expect(shouldRecap(trigger({ turnCount: RECAP_MIN_TURNS - 1 })).reason).toBe('too-few-turns');
    expect(shouldRecap(trigger({ turnCount: RECAP_MIN_TURNS })).recap).toBe(true);
  });
  it('fires at most once per away period', () => {
    expect(shouldRecap(trigger({ lastRecapTurn: 6 })).reason).toBe('no-new-turns');
    expect(shouldRecap(trigger({ lastRecapTurn: 5 })).recap).toBe(true);
  });
  it('does not fire before the session has ever been focused', () => {
    expect(shouldRecap(trigger({ lastFocusAt: null })).reason).toBe('never-focused');
  });
  it('does not fire inside the away window', () => {
    expect(shouldRecap(trigger({ lastFocusAt: NOW - 14 * MIN })).reason).toBe('not-away-long-enough');
    expect(shouldRecap(trigger({ lastFocusAt: NOW - 15 * MIN })).recap).toBe(true);
  });
  it('honours a shorter configured window', () => {
    expect(shouldRecap(trigger({ awayMinutes: 5, lastFocusAt: NOW - 6 * MIN })).recap).toBe(true);
    expect(shouldRecap(trigger({ awayMinutes: 5, lastFocusAt: NOW - 4 * MIN })).reason).toBe('not-away-long-enough');
  });
  it('reports the first rule that failed, in a fixed order', () => {
    expect(shouldRecap(trigger({ enabled: false, running: true, turnCount: 0 })).reason).toBe('disabled');
    expect(shouldRecap(trigger({ running: true, turnCount: 0 })).reason).toBe('running');
    expect(shouldRecap(trigger({ turnCount: 0, lastFocusAt: null })).reason).toBe('too-few-turns');
  });
});

describe('buildRecapPrompt', () => {
  const turns = [
    { role: 'user' as const, text: 'first question' },
    { role: 'assistant' as const, text: 'first answer' },
    { role: 'user' as const, text: 'last question' },
  ];

  it('labels the roles and keeps the order', () => {
    const prompt = buildRecapPrompt(turns);
    expect(prompt).toContain('Owner: first question');
    expect(prompt).toContain('Assistant: first answer');
    expect(prompt.indexOf('first question')).toBeLessThan(prompt.indexOf('last question'));
  });
  it('includes the open goal when there is one', () => {
    expect(buildRecapPrompt(turns, 'ship the storage prune')).toContain('Open goal: ship the storage prune');
    expect(buildRecapPrompt(turns, '   ')).not.toContain('Open goal:');
    expect(buildRecapPrompt(turns)).not.toContain('Open goal:');
  });
  it('stays inside the character budget', () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, text: `t${i} ${'x'.repeat(2000)}` }));
    expect(buildRecapPrompt(big).length).toBeLessThanOrEqual(RECAP_PROMPT_CHAR_BUDGET + 200);
  });
  it('drops the OLDEST turns when over budget, never the newest', () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, text: `t${i} ${'x'.repeat(2000)}` }));
    const prompt = buildRecapPrompt(big);
    expect(prompt).toContain('t39');
    expect(prompt).not.toContain('t0 ');
  });
  it('truncates a single oversized newest turn rather than dropping it', () => {
    const prompt = buildRecapPrompt([{ role: 'user', text: 'y'.repeat(RECAP_PROMPT_CHAR_BUDGET * 2) }]);
    expect(prompt).toContain('Owner: yyy');
    expect(prompt.length).toBeLessThanOrEqual(RECAP_PROMPT_CHAR_BUDGET + 200);
  });
  it('skips empty turns and survives an empty transcript', () => {
    expect(buildRecapPrompt([{ role: 'user', text: '   ' }])).toBe('Recent conversation:\n');
    expect(buildRecapPrompt([])).toBe('Recent conversation:\n');
  });
});