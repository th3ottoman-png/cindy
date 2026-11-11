import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_GUARD_CONFIG } from '../injection-guard.js';
import {
  GUARD_POLICIES,
  normalizeGuardConfig,
  readGuardConfig,
  writeGuardConfig,
} from '../guard-config.js';

function tempFile(name = 'security.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'cindy-guard-')), name);
}

describe('normalizeGuardConfig', () => {
  it('returns the defaults for an absent document', () => {
    expect(normalizeGuardConfig(undefined)).toEqual({ config: { ...DEFAULT_GUARD_CONFIG } });
  });

  it('accepts a valid pair', () => {
    expect(normalizeGuardConfig({ threshold: 0.6, policy: 'block' })).toEqual({
      config: { threshold: 0.6, policy: 'block' },
    });
  });

  it('clamps an out-of-range threshold instead of throwing, and says so', () => {
    const high = normalizeGuardConfig({ threshold: 4, policy: 'hold' });
    expect(high.config.threshold).toBe(1);
    expect(high.issue).toMatch(/clamped/);

    const low = normalizeGuardConfig({ threshold: 0, policy: 'hold' });
    expect(low.config.threshold).toBe(0.01);
  });

  it('rejects an unknown policy but keeps the rest usable', () => {
    const res = normalizeGuardConfig({ threshold: 0.9, policy: 'nuke' });
    expect(res.config).toEqual({ threshold: 0.9, policy: DEFAULT_GUARD_CONFIG.policy });
    expect(res.issue).toMatch(/policy/);
    expect(GUARD_POLICIES).toContain(res.config.policy);
  });

  it('rejects a non-object document', () => {
    expect(normalizeGuardConfig([1, 2]).issue).toMatch(/object/);
  });
});

describe('readGuardConfig / writeGuardConfig', () => {
  it('missing file means defaults, no issue', () => {
    expect(readGuardConfig(tempFile('absent.json'))).toEqual({ config: { ...DEFAULT_GUARD_CONFIG } });
  });

  it('corrupt JSON means defaults plus an issue, never a throw', () => {
    const file = tempFile();
    writeFileSync(file, '{ not json', 'utf8');
    const res = readGuardConfig(file);
    expect(res.config).toEqual({ ...DEFAULT_GUARD_CONFIG });
    expect(res.issue).toMatch(/not valid JSON/);
  });

  it('round-trips through the atomic writer', () => {
    const file = tempFile();
    const written = writeGuardConfig(file, { threshold: 0.65, policy: 'block' });
    expect(written).toEqual({ threshold: 0.65, policy: 'block' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ threshold: 0.65, policy: 'block' });
    expect(readGuardConfig(file).config).toEqual({ threshold: 0.65, policy: 'block' });
  });

  it('normalizes on write too, so a bad value can never reach the file', () => {
    const file = tempFile();
    writeGuardConfig(file, { threshold: 9, policy: 'hold' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ threshold: 1, policy: 'hold' });
  });
});
