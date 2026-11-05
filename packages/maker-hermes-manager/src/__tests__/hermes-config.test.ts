import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseHermesDefaultRoute,
  readHermesDefaultRoute,
  writeHermesDefaultRoute,
  parseHermesMcpServers,
  readHermesMcpServers,
  writeHermesMcpServer,
  removeHermesMcpServer,
  filterDisabledMcpServers,
  parseHermesCustomProviders,
  writeHermesLocalContextWindows,
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

describe('parseHermesMcpServers', () => {
  it('parses stdio servers with multiline args and env', () => {
    const yaml = `
mcp_servers:
  weather:
    command: python3
    args:
      - "-m"
      - "weather_server"
    env:
      API_KEY: "secret-key"
      DEBUG: "1"
agent:
  max_turns: 150
`;
    const servers = parseHermesMcpServers(yaml);
    expect(servers).toEqual({
      weather: {
        command: 'python3',
        args: ['-m', 'weather_server'],
        env: {
          API_KEY: 'secret-key',
          DEBUG: '1',
        },
      },
    });
  });

  it('parses http/sse servers with headers and inline args', () => {
    const yaml = `
mcp_servers:
  cindy_bridge:
    url: "http://127.0.0.1:4567/mcp/cindy_memory"
    headers:
      Authorization: "Bearer test-token"
  cli_tool:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
    disabled: true
`;
    const servers = parseHermesMcpServers(yaml);
    expect(servers.cindy_bridge).toEqual({
      url: 'http://127.0.0.1:4567/mcp/cindy_memory',
      headers: {
        Authorization: 'Bearer test-token',
      },
    });
    expect(servers.cli_tool).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      disabled: true,
    });
  });

  it('returns empty object when mcp_servers block is absent', () => {
    expect(parseHermesMcpServers('model:\n  default: deepseek-flash\n')).toEqual({});
  });
});

describe('writeHermesMcpServer and removeHermesMcpServer', () => {
  async function withHome(initial: string | null): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), 'hermes-mcp-'));
    if (initial !== null) await writeFile(path.join(home, 'config.yaml'), initial, 'utf8');
    return home;
  }

  it('adds an MCP server when mcp_servers block does not exist', async () => {
    const home = await withHome('model:\n  default: deepseek-flash\n');
    const result = await writeHermesMcpServer(home, 'my_bridge', {
      url: 'http://127.0.0.1:1234/mcp/cindy_memory',
      headers: { Authorization: 'Bearer token123' },
    });
    expect(result.my_bridge).toEqual({
      url: 'http://127.0.0.1:1234/mcp/cindy_memory',
      headers: { Authorization: 'Bearer token123' },
    });
    const content = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(content).toContain('mcp_servers:');
    expect(content).toContain('  my_bridge:');
    expect(content).toContain('    url: http://127.0.0.1:1234/mcp/cindy_memory');
    await rm(home, { recursive: true, force: true });
  });

  it('updates an existing server in place while preserving others', async () => {
    const initial = `
model:
  default: deepseek-flash

mcp_servers:
  first:
    command: node
    args:
      - "./server.js"
  second:
    url: "https://example.com/sse"
`;
    const home = await withHome(initial);
    await writeHermesMcpServer(home, 'first', {
      command: 'node',
      args: ['./updated.js'],
      env: { PORT: '3000' },
    });
    const parsed = await readHermesMcpServers(home);
    expect(parsed.first).toEqual({
      command: 'node',
      args: ['./updated.js'],
      env: { PORT: '3000' },
    });
    expect(parsed.second).toEqual({
      url: 'https://example.com/sse',
    });
    await rm(home, { recursive: true, force: true });
  });

  it('removes a server and keeps remaining servers and other blocks', async () => {
    const initial = `
model:
  default: deepseek-flash

mcp_servers:
  delete_me:
    command: /bin/false
  keep_me:
    url: "https://example.com/mcp"

agent:
  max_turns: 100
`;
    const home = await withHome(initial);
    const result = await removeHermesMcpServer(home, 'delete_me');
    expect(result.delete_me).toBeUndefined();
    expect(result.keep_me).toBeDefined();

    const content = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(content).not.toContain('delete_me');
    expect(content).toContain('keep_me:');
    expect(content).toContain('max_turns: 100');
    expect(content.endsWith('\n')).toBe(true);
    await rm(home, { recursive: true, force: true });
  });

  it('removes the last MCP server without leaving an empty mcp_servers: key and preserves trailing newline (0.8 debt)', async () => {
    const initial = [
      'model:',
      '  default: deepseek/deepseek-v4.1-flash-1017',
      '  provider: nous',
      '  base_url: https://inference-api.nousresearch.com/v1',
      '',
    ].join('\n');

    const home = await withHome(initial);
    // Add server
    await writeHermesMcpServer(home, 'mini_mcp', {
      command: 'node',
      args: ['/path/to/mini-mcp.mjs'],
    });

    const addedContent = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(addedContent).toContain('mcp_servers:');
    expect(addedContent).toContain('mini_mcp:');
    expect(addedContent.endsWith('\n')).toBe(true);

    // Remove the last/only server
    const result = await removeHermesMcpServer(home, 'mini_mcp');
    expect(result).toEqual({});

    const finalContent = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(finalContent).not.toContain('mcp_servers');
    expect(finalContent.endsWith('\n')).toBe(true);
    // Roundtrip equals initial clean config
    expect(finalContent).toBe(initial);

    await rm(home, { recursive: true, force: true });
  });

  it('removes the last MCP server when followed by other blocks, keeping clean separation', async () => {
    const initial = [
      'model:',
      '  default: deepseek-flash',
      '',
      'mcp_servers:',
      '  single:',
      '    command: node',
      '',
      'agent:',
      '  max_turns: 100',
      '',
    ].join('\n');

    const home = await withHome(initial);
    const result = await removeHermesMcpServer(home, 'single');
    expect(result).toEqual({});

    const content = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(content).not.toContain('mcp_servers');
    expect(content).toContain('model:\n  default: deepseek-flash\n\nagent:\n  max_turns: 100\n');
    expect(content.endsWith('\n')).toBe(true);

    await rm(home, { recursive: true, force: true });
  });

  it('removes block-level comments when removing the last MCP server', async () => {
    const initial = [
      'model:',
      '  default: deepseek-flash',
      '',
      '# Configured MCP tools',
      'mcp_servers:',
      '  tool1:',
      '    command: node',
      '',
    ].join('\n');

    const home = await withHome(initial);
    const result = await removeHermesMcpServer(home, 'tool1');
    expect(result).toEqual({});

    const content = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(content).not.toContain('mcp_servers');
    expect(content).not.toContain('Configured MCP tools');
    expect(content).toBe('model:\n  default: deepseek-flash\n');

    await rm(home, { recursive: true, force: true });
  });
});

describe('filterDisabledMcpServers', () => {
  it('returns YAML unchanged when mcp_servers block is absent', () => {
    const yaml = 'model:\n  default: deepseek-flash\n';
    expect(filterDisabledMcpServers(yaml)).toBe(yaml);
  });

  it('returns YAML unchanged when no servers are disabled', () => {
    const yaml = [
      'model:',
      '  default: deepseek-flash',
      '',
      'mcp_servers:',
      '  active:',
      '    command: node',
      '    disabled: false',
      '  another:',
      '    url: "https://example.com"',
      '',
      'agent:',
      '  max_turns: 100',
      '',
    ].join('\n');
    expect(filterDisabledMcpServers(yaml)).toBe(yaml);
  });

  it('strips a disabled server while preserving enabled servers and other blocks', () => {
    const yaml = [
      '# Top comment',
      'model:',
      '  default: deepseek-flash',
      '',
      'mcp_servers:',
      '  cindy_docs:',
      '    command: node',
      '    args:',
      '      - /path/to/shim.mjs',
      '      - --server',
      '      - cindy_docs',
      '    env:',
      '      CINDY_BRIDGE_SESSION: ${CINDY_BRIDGE_SESSION}',
      '    disabled: true',
      '  keep_me:',
      '    command: python',
      '    args:',
      '      - -m',
      '      - my_server',
      '',
      'agent:',
      '  max_turns: 100',
    ].join('\n');

    const result = filterDisabledMcpServers(yaml);
    expect(result).not.toContain('cindy_docs');
    expect(result).not.toContain('disabled: true');
    expect(result).toContain('keep_me:');
    expect(result).toContain('command: python');
    expect(result).toContain('model:\n  default: deepseek-flash');
    expect(result).toContain('agent:\n  max_turns: 100');
    expect(result).toContain('# Top comment');

    const parsed = parseHermesMcpServers(result);
    expect(parsed.cindy_docs).toBeUndefined();
    expect(parsed.keep_me).toBeDefined();
    expect(parsed.keep_me.command).toBe('python');
  });

  it('strips multiple disabled servers (first and last) leaving middle enabled', () => {
    const yaml = [
      'mcp_servers:',
      '  first_disabled:',
      '    command: node',
      '    disabled: true',
      '  middle_active:',
      '    command: python',
      '  last_disabled:',
      '    url: https://example.com',
      '    disabled: true',
      '',
      'custom_providers:',
      '  - name: local',
    ].join('\n');

    const result = filterDisabledMcpServers(yaml);
    expect(result).not.toContain('first_disabled');
    expect(result).not.toContain('last_disabled');
    expect(result).toContain('middle_active:');
    expect(result).toContain('custom_providers:');

    const parsed = parseHermesMcpServers(result);
    expect(Object.keys(parsed)).toEqual(['middle_active']);
  });

  it('replaces mcp_servers: with mcp_servers: {} when all servers are disabled', () => {
    const yaml = [
      'model:',
      '  default: deepseek-flash',
      '',
      'mcp_servers:',
      '  disabled_a:',
      '    command: node',
      '    disabled: true',
      '  disabled_b:',
      '    command: python',
      '    disabled: true',
      '',
      'agent:',
      '  max_turns: 100',
    ].join('\n');

    const result = filterDisabledMcpServers(yaml);
    expect(result).not.toContain('disabled_a');
    expect(result).not.toContain('disabled_b');
    expect(result).toContain('mcp_servers: {}');
    expect(result).toContain('model:\n  default: deepseek-flash');
    expect(result).toContain('agent:\n  max_turns: 100');

    const parsed = parseHermesMcpServers(result);
    expect(Object.keys(parsed)).toEqual([]);
  });

  it('removes server-preceding comments belonging to the disabled server while preserving comments for enabled servers', () => {
    const yaml = [
      'mcp_servers:',
      '  # Cindy Docs Server',
      '  cindy_docs:',
      '    command: node',
      '    disabled: true',
      '',
      '  # Active Server',
      '  active_server:',
      '    command: python',
    ].join('\n');

    const result = filterDisabledMcpServers(yaml);
    expect(result).not.toContain('cindy_docs');
    expect(result).not.toContain('# Cindy Docs Server');
    expect(result).toContain('# Active Server');
    expect(result).toContain('active_server:');
  });

  it('preserves CRLF line endings', () => {
    const yaml = [
      'model:',
      '  default: deepseek-flash',
      '',
      'mcp_servers:',
      '  disabled_one:',
      '    command: node',
      '    disabled: true',
      '  active_one:',
      '    command: python',
      '',
    ].join('\r\n');

    const result = filterDisabledMcpServers(yaml);
    expect(result).toContain('\r\n');
    expect(result).not.toContain('disabled_one');
    expect(result).toContain('active_one:');
  });
});

describe('parseHermesCustomProviders', () => {
  it('parses a list block with name, base_url and context_length', () => {
    const yaml = [
      'model:',
      '  default: deepseek-flash',
      '',
      'custom_providers:',
      '  - name: lmstudio-local',
      '    base_url: http://127.0.0.1:1234/v1',
      '    context_length: 65536',
      '  - name: ollama-local',
      '    base_url: "http://127.0.0.1:11434/v1"',
      '    context_length: 32768',
      '_config_version: 51',
      '',
    ].join('\n');
    expect(parseHermesCustomProviders(yaml)).toEqual([
      { name: 'lmstudio-local', baseUrl: 'http://127.0.0.1:1234/v1', contextLength: 65536 },
      { name: 'ollama-local', baseUrl: 'http://127.0.0.1:11434/v1', contextLength: 32768 },
    ]);
  });

  it('returns an empty list when the block is absent', () => {
    expect(parseHermesCustomProviders('model:\n  default: deepseek-flash\n')).toEqual([]);
  });

  it('tolerates extra keys and nested blocks inside an entry', () => {
    const yaml = [
      'custom_providers:',
      '  - name: local',
      '    base_url: http://127.0.0.1:1234/v1',
      '    context_length: 65536',
      '    models:',
      '      qwen3-8b:',
      '        context_length: 40960',
      'agent:',
      '  max_turns: 100',
      '',
    ].join('\n');
    expect(parseHermesCustomProviders(yaml)).toEqual([
      { name: 'local', baseUrl: 'http://127.0.0.1:1234/v1', contextLength: 65536 },
    ]);
  });

  it('skips incomplete entries instead of guessing', () => {
    const yaml = [
      'custom_providers:',
      '  - name: no-url',
      '    context_length: 65536',
      '  - name: no-length',
      '    base_url: http://127.0.0.1:1234/v1',
      '',
    ].join('\n');
    expect(parseHermesCustomProviders(yaml)).toEqual([]);
  });
});

describe('writeHermesLocalContextWindows', () => {
  async function withHome(initial: string | null): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), 'hermes-ctxwin-'));
    if (initial !== null) await writeFile(path.join(home, 'config.yaml'), initial, 'utf8');
    return home;
  }

  const entries = [
    { name: 'lmstudio-local', baseUrl: 'http://127.0.0.1:1234/v1', contextLength: 65536 },
    { name: 'ollama-local', baseUrl: 'http://127.0.0.1:11434/v1', contextLength: 65536 },
  ];

  it('removes ollama_num_ctx from the model block and appends a custom_providers list', async () => {
    const initial = [
      '# Cindy Hermes home config',
      'model:',
      '  default: deepseek-flash',
      '  provider: deepseek',
      '  base_url: https://api.deepseek.com/v1',
      '  # Added 2026-11-01 so small local models pass the 64k floor (2.2b-2).',
      '  ollama_num_ctx: 65536',
      '_config_version: 51',
      '',
    ].join('\n');
    const home = await withHome(initial);
    const result = await writeHermesLocalContextWindows(home, entries);
    expect(result.removedOllamaNumCtx).toBe(true);
    expect(result.providers).toEqual(entries);

    const written = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(written).not.toContain('ollama_num_ctx');
    // Everything else stays byte-for-byte: comment, route keys, version trailer.
    expect(written.startsWith('# Cindy Hermes home config\nmodel:\n')).toBe(true);
    expect(written).toContain('  default: deepseek-flash\n');
    expect(written).toContain('  provider: deepseek\n');
    expect(written).toContain('  base_url: https://api.deepseek.com/v1\n');
    expect(written).toContain('  # Added 2026-11-01 so small local models pass the 64k floor (2.2b-2).\n');
    expect(written).toContain('_config_version: 51\n');
    expect(written).toContain(
      'custom_providers:\n' +
        '  - name: lmstudio-local\n' +
        '    base_url: http://127.0.0.1:1234/v1\n' +
        '    context_length: 65536\n' +
        '  - name: ollama-local\n' +
        '    base_url: http://127.0.0.1:11434/v1\n' +
        '    context_length: 65536\n',
    );
    // No temp-file debris from the atomic write.
    expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await rm(home, { recursive: true, force: true });
  });

  it('normalizes the base URL the same way the route resolver does', async () => {
    const home = await withHome('model:\n  default: deepseek-flash\n');
    const result = await writeHermesLocalContextWindows(home, [
      { name: 'lmstudio-local', baseUrl: 'http://127.0.0.1:1234/', contextLength: 65536 },
    ]);
    expect(result.providers).toEqual([
      { name: 'lmstudio-local', baseUrl: 'http://127.0.0.1:1234/v1', contextLength: 65536 },
    ]);
    await rm(home, { recursive: true, force: true });
  });

  it('updates the matching entry in place and keeps unrelated entries and keys', async () => {
    const initial = [
      'custom_providers:',
      '  - name: lmstudio-local',
      '    base_url: http://127.0.0.1:1234/v1',
      '    context_length: 32768',
      '    timeout_seconds: 900',
      '  - name: someone-else',
      '    base_url: https://example.com/v1',
      '    context_length: 128000',
      'agent:',
      '  max_turns: 100',
      '',
    ].join('\n');
    const home = await withHome(initial);
    const result = await writeHermesLocalContextWindows(home, [
      { name: 'lmstudio-local', baseUrl: 'http://127.0.0.1:1234', contextLength: 65536 },
    ]);
    expect(result.removedOllamaNumCtx).toBe(false);
    expect(result.providers).toEqual([
      { name: 'lmstudio-local', baseUrl: 'http://127.0.0.1:1234/v1', contextLength: 65536 },
      { name: 'someone-else', baseUrl: 'https://example.com/v1', contextLength: 128000 },
    ]);
    const written = await readFile(path.join(home, 'config.yaml'), 'utf8');
    // The entry's own extra key and the sibling entry survive untouched.
    expect(written).toContain('    timeout_seconds: 900\n');
    expect(written).toContain('  - name: someone-else\n');
    expect(written).toContain('agent:\n  max_turns: 100\n');
    await rm(home, { recursive: true, force: true });
  });

  it('is idempotent: a second run changes nothing and reports no removal', async () => {
    const home = await withHome('model:\n  default: deepseek-flash\n  ollama_num_ctx: 65536\n');
    await writeHermesLocalContextWindows(home, entries);
    const first = await readFile(path.join(home, 'config.yaml'), 'utf8');
    const second = await writeHermesLocalContextWindows(home, entries);
    expect(second.removedOllamaNumCtx).toBe(false);
    expect(await readFile(path.join(home, 'config.yaml'), 'utf8')).toBe(first);
    await rm(home, { recursive: true, force: true });
  });

  it('refuses to edit a custom_providers block that is not a list', async () => {
    const home = await withHome('custom_providers:\n  broken: true\n');
    await expect(writeHermesLocalContextWindows(home, entries)).rejects.toThrow(/not a list/i);
    // The file is left exactly as it was.
    expect(await readFile(path.join(home, 'config.yaml'), 'utf8')).toBe('custom_providers:\n  broken: true\n');
    await rm(home, { recursive: true, force: true });
  });

  it('still writes the block when the model block or key is absent', async () => {
    const home = await withHome('agent:\n  max_turns: 150\n');
    const result = await writeHermesLocalContextWindows(home, entries);
    expect(result.removedOllamaNumCtx).toBe(false);
    const written = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(written).toContain('agent:\n  max_turns: 150\n');
    expect(written).toContain('custom_providers:\n');
    expect(parseHermesCustomProviders(written)).toEqual(entries);
    await rm(home, { recursive: true, force: true });
  });
});
