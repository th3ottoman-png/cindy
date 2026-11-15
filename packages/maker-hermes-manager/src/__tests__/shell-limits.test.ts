import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SHELL_TIMEOUT_SECONDS,
  MAX_SHELL_TIMEOUT_SECONDS,
  defaultShellLimitsFile,
  injectTerminalTimeout,
  loadShellLimitsConfig,
  parseShellLimitsYaml,
} from '../shell-limits.js';

const tmpDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-shell-limits-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('parseShellLimitsYaml', () => {
  it('gives the default timeout for an empty file', () => {
    const { config, errors } = parseShellLimitsYaml('');
    expect(config.timeoutSeconds).toBe(DEFAULT_SHELL_TIMEOUT_SECONDS);
    expect(DEFAULT_SHELL_TIMEOUT_SECONDS).toBe(300);
    expect(errors).toEqual([]);
  });

  it('reads a whole number', () => {
    expect(parseShellLimitsYaml('timeout_seconds: 5\n').config.timeoutSeconds).toBe(5);
  });

  it('reads 0 as "leave the Hermes default alone"', () => {
    expect(parseShellLimitsYaml('timeout_seconds: 0\n').config.timeoutSeconds).toBe(0);
  });

  it('accepts quotes, comments and the maximum', () => {
    const { config, errors } = parseShellLimitsYaml(
      `# shell limits\ntimeout_seconds: "${MAX_SHELL_TIMEOUT_SECONDS}"  # the Hermes foreground cap\n`,
    );
    expect(config.timeoutSeconds).toBe(MAX_SHELL_TIMEOUT_SECONDS);
    expect(MAX_SHELL_TIMEOUT_SECONDS).toBe(600);
    expect(errors).toEqual([]);
  });

  it('lists a non-numeric value and keeps the default', () => {
    const { config, errors } = parseShellLimitsYaml('timeout_seconds: soon\n');
    expect(config.timeoutSeconds).toBe(DEFAULT_SHELL_TIMEOUT_SECONDS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('timeout_seconds');
    expect(errors[0]).toContain('300');
  });

  it('lists an out-of-range value and keeps the default', () => {
    const { config, errors } = parseShellLimitsYaml('timeout_seconds: 601\n');
    expect(config.timeoutSeconds).toBe(DEFAULT_SHELL_TIMEOUT_SECONDS);
    expect(errors[0]).toContain('600');
  });

  it('lists a negative value and keeps the default', () => {
    const { config, errors } = parseShellLimitsYaml('timeout_seconds: -5\n');
    expect(config.timeoutSeconds).toBe(DEFAULT_SHELL_TIMEOUT_SECONDS);
    expect(errors).toHaveLength(1);
  });

  it('says plainly that max_output_chars does nothing on Hermes 0.23', () => {
    const { config, errors } = parseShellLimitsYaml('max_output_chars: 20000\n');
    expect(config.timeoutSeconds).toBe(DEFAULT_SHELL_TIMEOUT_SECONDS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('max_output_chars');
    expect(errors[0]).toContain('no output cap');
  });

  it('lists an unknown key', () => {
    const { errors } = parseShellLimitsYaml('timeout: 5\n');
    expect(errors[0]).toContain('unknown key');
  });

  it('lists an indented line instead of guessing', () => {
    const { errors } = parseShellLimitsYaml('  timeout_seconds: 5\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('indented');
  });
});

describe('loadShellLimitsConfig', () => {
  it('gives the defaults when the file does not exist', async () => {
    const dir = await tmpDir();
    const load = await loadShellLimitsConfig(path.join(dir, 'missing.yaml'));
    expect(load.exists).toBe(false);
    expect(load.errors).toEqual([]);
    expect(load.config.timeoutSeconds).toBe(DEFAULT_SHELL_TIMEOUT_SECONDS);
  });

  it('reads the owner file', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'shell-limits.yaml');
    await fs.writeFile(file, 'timeout_seconds: 45\n');
    const load = await loadShellLimitsConfig(file);
    expect(load.exists).toBe(true);
    expect(load.config.timeoutSeconds).toBe(45);
    expect(load.file).toBe(file);
  });

  it('points at ~/.cindy-harness/shell-limits.yaml by default', () => {
    expect(defaultShellLimitsFile()).toBe(path.join(os.homedir(), '.cindy-harness', 'shell-limits.yaml'));
  });
});

describe('injectTerminalTimeout', () => {
  it('adds a terminal block to an empty config', () => {
    expect(injectTerminalTimeout('', 300)).toBe('terminal:\n  timeout: 300\n');
  });

  it('adds a terminal block after the existing keys', () => {
    const out = injectTerminalTimeout('model:\n  default: m\n', 300);
    expect(out).toBe('model:\n  default: m\nterminal:\n  timeout: 300\n');
  });

  it('replaces an existing timeout and keeps every other byte', () => {
    const base = [
      'model:',
      '  default: m',
      'terminal:',
      '  # the owner raised this by hand',
      '  timeout: 180',
      '  persistent_shell: false',
      'web:',
      '  search_backend: native',
      '',
    ].join('\n');
    const out = injectTerminalTimeout(base, 5);
    expect(out).toContain('  timeout: 5\n');
    expect(out).not.toContain('timeout: 180');
    expect(out).toContain('  # the owner raised this by hand\n');
    expect(out).toContain('  persistent_shell: false\n');
    expect(out).toContain('web:\n  search_backend: native\n');
  });

  it('adds timeout to a terminal block that has no timeout key', () => {
    const out = injectTerminalTimeout('terminal:\n  persistent_shell: false\n', 300);
    expect(out).toBe('terminal:\n  timeout: 300\n  persistent_shell: false\n');
  });

  it('is idempotent', () => {
    const once = injectTerminalTimeout('terminal:\n  timeout: 5\n', 300);
    expect(injectTerminalTimeout(once, 300)).toBe(once);
  });

  it('never touches a timeout key under another top-level block', () => {
    const base = 'web:\n  timeout: 9\nterminal:\n  timeout: 180\n';
    const out = injectTerminalTimeout(base, 300);
    expect(out).toContain('web:\n  timeout: 9\n');
    expect(out).toContain('terminal:\n  timeout: 300\n');
  });

  it('refuses an inline terminal value rather than corrupting it', () => {
    expect(() => injectTerminalTimeout('terminal: {timeout: 180}\n', 300)).toThrow(/inline terminal value/);
  });

  it('keeps CRLF line endings', () => {
    const out = injectTerminalTimeout('model:\r\n  default: m\r\n', 300);
    expect(out).toBe('model:\r\n  default: m\r\nterminal:\r\n  timeout: 300\r\n');
  });

  it('ends a config that had no trailing newline with exactly one', () => {
    const out = injectTerminalTimeout('terminal:\n  timeout: 180', 300);
    expect(out).toBe('terminal:\n  timeout: 300\n');
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('leaves a nested timeout under a terminal sub-block alone', () => {
    const base = 'terminal:\n  docker_env:\n    timeout: keep\n  timeout: 180\n';
    const out = injectTerminalTimeout(base, 300);
    expect(out).toContain('    timeout: keep\n');
    expect(out).toContain('  timeout: 300\n');
  });
});
