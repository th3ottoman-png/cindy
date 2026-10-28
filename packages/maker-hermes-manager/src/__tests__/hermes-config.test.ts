import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseHermesDefaultRoute,
  readHermesDefaultRoute,
  writeHermesDefaultRoute,
} from '../hermes-config.js';

describe('parseHermesDefaultRoute', () => {
  it('reads the top-level model block', () => {
    expect(
      parseHermesDefaultRoute('model:\n  default: deepseek/deepseek-v4.1-flash-1017\n  provider: nous\n_config_version: 51\n'),
    ).toEqual({ model: 'deepseek/deepseek-v4.1-flash-1017', provider: 'nous' });
  });

  it('unquotes values and tolerates CRLF plus comments', () => {
    const yaml = 'model:\r\n  # route\r\n  default: "openai/gpt-5.6"\r\n  provider: \'openai\'\r\n';
    expect(parseHermesDefaultRoute(yaml)).toEqual({ model: 'openai/gpt-5.6', provider: 'openai' });
  });

  it('returns an empty route when the block is missing or has no default', () => {
    expect(parseHermesDefaultRoute('agent:\n  model: something\n')).toEqual({});
    expect(parseHermesDefaultRoute('model:\n  provider: nous\n')).toEqual({ provider: 'nous' });
  });

  it('stops at a dedented line so later sections cannot leak in', () => {
    const yaml = 'model:\n  default: a/b\nagent:\n  provider: not-this-one\n  model: other\n';
    expect(parseHermesDefaultRoute(yaml)).toEqual({ model: 'a/b' });
  });
});

describe('writeHermesDefaultRoute', () => {
  async function withHome(initial: string | null): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), 'hermes-config-'));
    if (initial !== null) await writeFile(path.join(home, 'config.yaml'), initial, 'utf8');
    return home;
  }

  it('rewrites default/provider in place and preserves the rest byte-for-byte', async () => {
    const initial =
      '# heading comment\nmodel:\n  default: deepseek/deepseek-v4.1-flash-1017\n  provider: nous\n  base_url: https://inference-api.nousresearch.com/v1\n_config_version: 51\n';
    const home = await withHome(initial);
    const route = await writeHermesDefaultRoute(home, { model: 'deepseek-v4-flash', provider: 'deepseek' });
    expect(route).toEqual({
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      baseUrl: 'https://inference-api.nousresearch.com/v1',
    });
    const written = await readFile(path.join(home, 'config.yaml'), 'utf8');
    // base_url line untouched (baseUrl omitted), heading comment and trailer intact.
    expect(written).toContain('  base_url: https://inference-api.nousresearch.com/v1\n');
    expect(written.startsWith('# heading comment\nmodel:\n')).toBe(true);
    expect(written.endsWith('_config_version: 51\n')).toBe(true);
    expect(written).toContain('  default: deepseek-v4-flash\n');
    expect(written).toContain('  provider: deepseek\n');
    await rm(home, { recursive: true, force: true });
  });

  it('inserts missing keys under model: and appends the block when absent', async () => {
    const home = await withHome('agent:\n  max_turns: 150\n');
    const route = await writeHermesDefaultRoute(home, {
      model: 'deepseek-chat',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(route).toEqual({
      model: 'deepseek-chat',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const written = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(written).toContain('agent:\n  max_turns: 150\n');
    expect(written).toContain('model:\n  default: deepseek-chat\n  provider: deepseek\n  base_url: https://api.deepseek.com/v1\n');
    await rm(home, { recursive: true, force: true });
  });

  it('creates the config on an empty home and quotes unusual values', async () => {
    const home = await withHome(null);
    const route = await writeHermesDefaultRoute(home, {
      model: 'weird model: #1',
      provider: 'custom-endpoint',
    });
    expect(route).toEqual({ model: 'weird model: #1', provider: 'custom-endpoint' });
    const written = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(written).toContain('default: "weird model: #1"\n');
    await rm(home, { recursive: true, force: true });
  });

  it('round-trips through the reader after every write', async () => {
    const home = await withHome('model:\n  provider: nous\n');
    await writeHermesDefaultRoute(home, { model: 'glm-5.3', provider: 'zai' });
    expect(await readHermesDefaultRoute(home)).toEqual({ model: 'glm-5.3', provider: 'zai' });
    await rm(home, { recursive: true, force: true });
  });
});
