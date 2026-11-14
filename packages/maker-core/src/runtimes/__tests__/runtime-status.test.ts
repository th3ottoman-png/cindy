import { describe, expect, it } from 'vitest';

import {
  buildRuntimeStatus,
  parseRuntimeVersion,
  RUNTIME_IDS,
  runtimeVersionMatchesPin,
} from '../runtime-status.js';

describe('parseRuntimeVersion (real --version shapes)', () => {
  it('parses a bare leading version (pi)', () => {
    expect(parseRuntimeVersion('0.84.4\n', '')).toBe('0.84.4');
  });
  it('parses a leading version with a product suffix (claude-code)', () => {
    expect(parseRuntimeVersion('2.1.258 (Claude Code)\n', '')).toBe('2.1.258');
  });
  it('parses a named prefix (codex)', () => {
    expect(parseRuntimeVersion('codex-cli 0.145.0\n', '')).toBe('0.145.0');
  });
  it('parses a named prefix (hermes)', () => {
    expect(parseRuntimeVersion('hermes 0.23.0\n', '')).toBe('0.23.0');
  });
  it('strips a leading v', () => {
    expect(parseRuntimeVersion('v1.2.3\n', '')).toBe('1.2.3');
  });
  it('keeps a pre-release suffix', () => {
    expect(parseRuntimeVersion('1.2.3-beta.1\n', '')).toBe('1.2.3-beta.1');
  });
  it('reads stderr when stdout is empty', () => {
    expect(parseRuntimeVersion('', 'codex-cli 0.145.0\n')).toBe('0.145.0');
  });
  it('only reads the first line', () => {
    expect(parseRuntimeVersion('0.84.4\nextra 9.9.9\n', '')).toBe('0.84.4');
  });
  it('returns null for unrecognized output rather than scanning', () => {
    expect(parseRuntimeVersion('not a version at all', '')).toBeNull();
    expect(parseRuntimeVersion('', '')).toBeNull();
    expect(parseRuntimeVersion('unknown-cli 1.2.3', '')).toBeNull();
  });
});

describe('runtimeVersionMatchesPin', () => {
  it('matches on major.minor.patch', () => {
    expect(runtimeVersionMatchesPin('0.22.7', '0.22.7')).toBe(true);
    expect(runtimeVersionMatchesPin('0.23.0', '0.22.7')).toBe(false);
  });
  it('ignores a pre-release suffix for the pin match', () => {
    expect(runtimeVersionMatchesPin('0.22.7-rc.1', '0.22.7')).toBe(true);
  });
  it('is false for unparseable versions', () => {
    expect(runtimeVersionMatchesPin('garbage', '0.22.7')).toBe(false);
  });
});

describe('buildRuntimeStatus', () => {
  it('ok with a version and a matching pin', () => {
    const s = buildRuntimeStatus({ id: 'hermes', path: '/usr/local/bin/hermes', version: '0.22.7', pinned: '0.22.7' });
    expect(s.health).toBe('ok');
    expect(s.matchesPin).toBe(true);
    expect(s.version).toBe('0.22.7');
    expect(s.path).toBe('/usr/local/bin/hermes');
  });
  it('ok with a version that does not match the pin', () => {
    const s = buildRuntimeStatus({ id: 'hermes', path: '/x/hermes', version: '0.23.0', pinned: '0.22.7' });
    expect(s.health).toBe('ok');
    expect(s.matchesPin).toBe(false);
  });
  it('matchesPin is null without a pin', () => {
    const s = buildRuntimeStatus({ id: 'codex', path: '/x/codex', version: '0.145.0' });
    expect(s.health).toBe('ok');
    expect(s.matchesPin).toBeNull();
    expect(s.pinned).toBeUndefined();
  });
  it('missing when there is no path', () => {
    const s = buildRuntimeStatus({ id: 'pi', path: null });
    expect(s.health).toBe('missing');
    expect(s.matchesPin).toBeNull();
    expect(s.detail).toBeTruthy();
  });
  it('error when the probe failed', () => {
    const s = buildRuntimeStatus({ id: 'claude-code', path: '/x/claude', probeError: 'spawn ENOENT' });
    expect(s.health).toBe('error');
    expect(s.detail).toBe('spawn ENOENT');
    expect(s.matchesPin).toBeNull();
  });
  it('error when the version is unparseable', () => {
    const s = buildRuntimeStatus({ id: 'pi', path: '/x/pi', version: null });
    expect(s.health).toBe('error');
    expect(s.detail).toMatch(/--version/);
  });
  it('covers every runtime id', () => {
    for (const id of RUNTIME_IDS) {
      expect(buildRuntimeStatus({ id, path: null }).id).toBe(id);
    }
  });
});
