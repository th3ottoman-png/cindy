import { describe, expect, it } from 'vitest';

import {
  UNAVAILABLE_SHELL_LIMITS,
  readShellLimitsView,
  toShellLimitsView,
} from '../shellLimits.js';

function load(overrides: Record<string, unknown>) {
  return {
    config: { timeoutSeconds: 300 },
    errors: [],
    file: '/tmp/shell-limits.yaml',
    exists: true,
    ...overrides,
  };
}

describe('toShellLimitsView', () => {
  it('reads a normal load result', () => {
    expect(toShellLimitsView(load({}))).toEqual({
      timeoutSeconds: 300,
      errors: [],
      file: '/tmp/shell-limits.yaml',
      exists: true,
    });
  });

  it('keeps 0 as the Hermes default', () => {
    expect(toShellLimitsView(load({ config: { timeoutSeconds: 0 } })).timeoutSeconds).toBe(0);
  });

  it('keeps the file errors so the strip can show them', () => {
    expect(toShellLimitsView(load({ errors: ['timeout_seconds: "soon" is not a whole number'] })).errors).toHaveLength(1);
  });

  it('reads malformed input as unavailable', () => {
    expect(toShellLimitsView(null)).toBe(UNAVAILABLE_SHELL_LIMITS);
    expect(toShellLimitsView({})).toBe(UNAVAILABLE_SHELL_LIMITS);
    expect(toShellLimitsView({ config: {} })).toBe(UNAVAILABLE_SHELL_LIMITS);
    expect(toShellLimitsView({ config: { timeoutSeconds: -1 } })).toBe(UNAVAILABLE_SHELL_LIMITS);
    expect(toShellLimitsView('nope')).toBe(UNAVAILABLE_SHELL_LIMITS);
  });
});

describe('readShellLimitsView', () => {
  it('never throws: a failing load reads as unavailable', async () => {
    await expect(readShellLimitsView(async () => {
      throw new Error('boom');
    })).resolves.toBe(UNAVAILABLE_SHELL_LIMITS);
  });

  it('passes a good load through', async () => {
    await expect(readShellLimitsView(async () => load({}))).resolves.toMatchObject({ timeoutSeconds: 300 });
  });
});
