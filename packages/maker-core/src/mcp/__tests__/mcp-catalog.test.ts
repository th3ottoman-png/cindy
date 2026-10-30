import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMcpCatalog, checkMcpHealth, type McpCatalogEntry, type McpServerConfig } from '../mcp-catalog';

let bin: string;
beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bin-'));
});
afterEach(() => {
  fs.rmSync(bin, { recursive: true, force: true });
});

function exe(name: string, mode = 0o755): string {
  const p = path.join(bin, name);
  fs.writeFileSync(p, '#!/bin/sh\n', { mode });
  fs.chmodSync(p, mode);
  return p;
}

const SERVERS: Record<string, McpServerConfig> = {
  files: { command: 'npx', args: ['-y', 'mcp-files', '/tmp'], env: { TOKEN: 'sekret-value', A: '1' } },
  remote: { url: 'https://user:pw@mcp.example.com/v1/sse?key=abc', headers: { Authorization: 'Bearer sekret-value' }, auth: 'oauth' },
  off: { command: 'x', disabled: true },
  both: { command: 'x', url: 'https://a.example' },
  none: {},
  badurl: { url: 'ftp://nope' },
};

describe('buildMcpCatalog', () => {
  const catalog = buildMcpCatalog([
    { source: 'hermes', servers: SERVERS },
    { source: 'cindy', servers: { bridge: { command: 'node', args: ['shim.mjs'] } } },
  ]);
  const byId = (id: string): McpCatalogEntry => catalog.find((e) => e.id === id) as McpCatalogEntry;

  it('flattens sources into id-unique entries sorted by source then name', () => {
    expect(catalog.map((e) => e.id)).toEqual([
      'cindy/bridge',
      'hermes/badurl',
      'hermes/both',
      'hermes/files',
      'hermes/none',
      'hermes/off',
      'hermes/remote',
    ]);
  });

  it('keeps env and header values out of every entry, key names only', () => {
    expect(JSON.stringify(catalog)).not.toContain('sekret-value');
    expect(byId('hermes/files')).toMatchObject({ transport: 'stdio', target: 'npx -y mcp-files /tmp', envKeys: ['A', 'TOKEN'] });
    expect(byId('hermes/remote')).toMatchObject({ headerKeys: ['Authorization'], hasAuth: true });
  });

  it('strips credentials and query from an http target', () => {
    expect(byId('hermes/remote')).toMatchObject({ transport: 'http', target: 'https://mcp.example.com/v1/sse' });
    expect(JSON.stringify(catalog)).not.toContain('pw@');
    expect(JSON.stringify(catalog)).not.toContain('key=abc');
  });

  it('marks malformed entries invalid with a reason instead of throwing', () => {
    expect(byId('hermes/both')).toMatchObject({ transport: 'invalid', problem: expect.stringContaining('both') });
    expect(byId('hermes/none')).toMatchObject({ transport: 'invalid', problem: expect.stringContaining('needs') });
    expect(byId('hermes/badurl')).toMatchObject({ transport: 'invalid' });
  });

  it('reports disabled from the config flag', () => {
    expect(byId('hermes/off').enabled).toBe(false);
    expect(byId('hermes/files').enabled).toBe(true);
  });
});

describe('checkMcpHealth', () => {
  const entryFor = (name: string, cfg: McpServerConfig): { entry: McpCatalogEntry; configs: Record<string, McpServerConfig> } => ({
    entry: buildMcpCatalog([{ source: 's', servers: { [name]: cfg } }])[0],
    configs: { [`s/${name}`]: cfg },
  });

  it('stdio: ok when the command is an executable on the given PATH, with a real file', async () => {
    exe('good-mcp');
    const { entry, configs } = entryFor('a', { command: 'good-mcp' });
    expect(await checkMcpHealth(entry, { configs, searchPath: bin })).toEqual({ id: 's/a', status: 'ok' });
  });

  it('stdio: missing when absent from PATH, or present but not executable', async () => {
    exe('plain-file', 0o644);
    for (const command of ['nope-mcp', 'plain-file']) {
      const { entry, configs } = entryFor('a', { command });
      expect(await checkMcpHealth(entry, { configs, searchPath: bin })).toMatchObject({ status: 'missing-command' });
    }
  });

  it('stdio: an absolute path is checked directly', async () => {
    const abs = exe('abs-mcp');
    const { entry, configs } = entryFor('a', { command: abs });
    expect(await checkMcpHealth(entry, { configs, searchPath: '' })).toMatchObject({ status: 'ok' });
  });

  it('disabled and invalid entries are reported as such without checking anything', async () => {
    const off = entryFor('a', { command: 'x', disabled: true });
    expect(await checkMcpHealth(off.entry, { configs: off.configs })).toEqual({ id: 's/a', status: 'disabled' });
    const bad = entryFor('b', {});
    expect(await checkMcpHealth(bad.entry, { configs: bad.configs })).toMatchObject({ status: 'invalid' });
  });

  it('http: unchecked without a probe, never touching the network', async () => {
    const { entry, configs } = entryFor('r', { url: 'https://mcp.example.com/x' });
    expect(await checkMcpHealth(entry, { configs })).toMatchObject({ status: 'unchecked' });
  });

  it('http: uses the injected probe, with the full configured URL, and survives a throwing probe', async () => {
    const { entry, configs } = entryFor('r', { url: 'https://mcp.example.com/x?k=1' });
    const seen: string[] = [];
    expect(await checkMcpHealth(entry, { configs, probe: async (u) => (seen.push(u), true) })).toMatchObject({ status: 'ok' });
    expect(seen).toEqual(['https://mcp.example.com/x?k=1']);
    expect(await checkMcpHealth(entry, { configs, probe: async () => false })).toMatchObject({ status: 'unreachable' });
    expect(
      await checkMcpHealth(entry, {
        configs,
        probe: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).toEqual({ id: 's/r', status: 'unreachable', detail: 'ECONNREFUSED' });
  });
});
