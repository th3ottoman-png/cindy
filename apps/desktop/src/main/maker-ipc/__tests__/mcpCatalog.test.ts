import { describe, expect, it, vi } from 'vitest';

import type { McpServerConfig } from '@cindy/maker-core/mcp-catalog';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { createMcpCatalogHost, registerMcpCatalogHandlers, type McpCatalogHostDeps, type McpCatalogView } from '../mcpCatalog';
import { IpcHarness } from './helpers/ipcHarness';

const HERMES_SERVERS: Record<string, McpServerConfig> = {
  // `node` is guaranteed on PATH under vitest: the stdio health check is deterministic.
  shim: { command: 'node', args: ['shim.mjs', '--server', 'shim'], env: { TOKEN: 'sekret-value' } },
  gone: { command: 'definitely-not-a-real-binary-4d3b' },
  remote: { url: 'https://user:pw@mcp.example.com/v1/sse?key=abc', headers: { Authorization: 'Bearer sekret-value' } },
  off: { command: 'node', disabled: true },
};

const LIZI_SERVERS: Record<string, McpServerConfig> = {
  docs: { inProcess: true, description: 'Document Toolkit' },
  slack: { inProcess: true, disabled: true, description: 'Slack tools' },
};

function deps(overrides: Partial<McpCatalogHostDeps> = {}): McpCatalogHostDeps {
  // Stateful stores: a write is visible to the next list, like the real config.yaml / registry.
  const hermesStore = structuredClone(HERMES_SERVERS);
  const liziStore = structuredClone(LIZI_SERVERS);
  return {
    listHermesServers: vi.fn(async () => structuredClone(hermesStore)),
    setHermesServer: vi.fn(async (name: string, server: McpServerConfig) => {
      hermesStore[name] = structuredClone(server);
      return {};
    }),
    listLiziServers: vi.fn(async () => structuredClone(liziStore)),
    setLiziEnabled: vi.fn(async (pluginId: string, enabled: boolean) => {
      liziStore[pluginId] = { ...liziStore[pluginId], disabled: !enabled };
      return true;
    }),
    ...overrides,
  };
}

const byId = (view: McpCatalogView, id: string) => {
  const entry = view.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`missing entry ${id}`);
  return entry;
};

describe('mcp catalog host (ROADMAP 4.3b)', () => {
  it('lists both sources sorted, display-safe, with static health and no probe call', async () => {
    const probe = vi.fn(async () => true);
    const view = await createMcpCatalogHost(deps({ probe })).list();

    expect(view.entries.map((e) => e.id)).toEqual([
      'hermes/gone',
      'hermes/off',
      'hermes/remote',
      'hermes/shim',
      'lizi/docs',
      'lizi/slack',
    ]);
    // Health is static only: stdio checks the local fs, http stays unchecked, and the
    // injected probe is never called from list (no unprompted network).
    expect(byId(view, 'hermes/shim')).toMatchObject({ transport: 'stdio', health: 'ok', enabled: true });
    expect(byId(view, 'hermes/gone')).toMatchObject({ transport: 'stdio', health: 'missing-command' });
    expect(byId(view, 'hermes/remote')).toMatchObject({ transport: 'http', health: 'unchecked', target: 'https://mcp.example.com/v1/sse' });
    expect(byId(view, 'hermes/off')).toMatchObject({ health: 'disabled', enabled: false });
    expect(byId(view, 'lizi/docs')).toMatchObject({ transport: 'in-process', health: 'ok', description: 'Document Toolkit' });
    expect(byId(view, 'lizi/slack')).toMatchObject({ transport: 'in-process', health: 'disabled', enabled: false });
    expect(probe).not.toHaveBeenCalled();
    // env / header values and URL credentials never leave the host.
    const json = JSON.stringify(view);
    expect(json).not.toContain('sekret-value');
    expect(json).not.toContain('pw@');
    expect(json).not.toContain('key=abc');
    expect(byId(view, 'hermes/shim').envKeys).toEqual(['TOKEN']);
    expect(byId(view, 'hermes/remote').headerKeys).toEqual(['Authorization']);
  });

  it('toggle a hermes entry: flips only the disabled flag and returns the fresh view', async () => {
    const d = deps();
    const host = createMcpCatalogHost(d);

    const fresh = await host.setEnabled('hermes/shim', false);

    expect(d.setHermesServer).toHaveBeenCalledWith('shim', { ...HERMES_SERVERS.shim, disabled: true });
    expect(byId(fresh, 'hermes/shim')).toMatchObject({ enabled: false, health: 'disabled' });

    const back = await host.setEnabled('hermes/shim', true);
    expect(d.setHermesServer).toHaveBeenLastCalledWith('shim', { ...HERMES_SERVERS.shim, disabled: false });
    expect(byId(back, 'hermes/shim')).toMatchObject({ enabled: true });
  });

  it('toggle a lizi entry: delegates to the plugin toggle; a refused toggle is an error', async () => {
    const d = deps();
    const host = createMcpCatalogHost(d);

    const fresh = await host.setEnabled('lizi/docs', false);
    expect(d.setLiziEnabled).toHaveBeenCalledWith('docs', false);
    expect(fresh.entries).toHaveLength(6);

    d.setLiziEnabled = vi.fn(async () => false);
    await expect(host.setEnabled('lizi/docs', false)).rejects.toThrow('cannot be toggled');
  });

  it('setEnabled validates id and enabled and touches nothing on a bad call', async () => {
    const d = deps();
    const host = createMcpCatalogHost(d);

    await expect(host.setEnabled('', false)).rejects.toThrow('non-empty');
    await expect(host.setEnabled('hermes/', false)).rejects.toThrow('unknown MCP server id');
    await expect(host.setEnabled('hermes/nope', false)).rejects.toThrow('unknown MCP server id');
    await expect(host.setEnabled('lizi/nope', true)).rejects.toThrow('unknown MCP server id');
    await expect(host.setEnabled('other/x', true)).rejects.toThrow('unknown MCP server id');
    await expect(host.setEnabled('hermes/shim', 'yes')).rejects.toThrow('enabled (boolean)');
    expect(d.setHermesServer).not.toHaveBeenCalled();
    expect(d.setLiziEnabled).not.toHaveBeenCalled();
  });

  it('check-health probes an http entry on demand and caches it for later lists', async () => {
    const probe = vi.fn(async () => true);
    const d = deps({ probe });
    const host = createMcpCatalogHost(d);

    expect(await host.checkHealth('hermes/remote')).toEqual({ id: 'hermes/remote', status: 'ok' });
    expect(probe).toHaveBeenCalledWith('https://user:pw@mcp.example.com/v1/sse?key=abc');

    const view = await host.list();
    expect(byId(view, 'hermes/remote').health).toBe('ok');
    expect(probe).toHaveBeenCalledTimes(1);

    // Toggling the entry drops the cached probe result.
    await host.setEnabled('hermes/remote', false);
    expect((await host.list()).entries.find((e) => e.id === 'hermes/remote')?.health).toBe('disabled');
  });

  it('check-health: a failing probe is unreachable, never an exception; stdio stays static', async () => {
    const probe = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const host = createMcpCatalogHost(deps({ probe }));

    expect(await host.checkHealth('hermes/remote')).toEqual({ id: 'hermes/remote', status: 'unreachable', detail: 'ECONNREFUSED' });
    expect(await host.checkHealth('hermes/shim')).toMatchObject({ status: 'ok' });
    expect(await host.checkHealth('lizi/docs')).toEqual({ id: 'lizi/docs', status: 'ok' });
    await expect(host.checkHealth('nope/x')).rejects.toThrow('unknown MCP server id');
  });
});

describe('mcp catalog IPC (ROADMAP 4.3b)', () => {
  const freshView: McpCatalogView = { entries: [] };

  function hostStub() {
    return {
      list: vi.fn(async () => freshView),
      setEnabled: vi.fn(async () => freshView),
      checkHealth: vi.fn(async () => ({ id: 'hermes/remote', status: 'ok' as const })),
    };
  }

  it('all three channels require a trusted sender; an untrusted call never reaches the host', async () => {
    const host = hostStub();
    const harness = new IpcHarness();
    registerMcpCatalogHandlers(harness, {
      host,
      assertTrusted: () => {
        throw new Error('untrusted sender');
      },
      broadcast: vi.fn(),
    });

    await expect(harness.invoke(MAKER_INVOKE.MCP_CATALOG_LIST)).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.MCP_CATALOG_SET_ENABLED, { id: 'a', enabled: false })).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.MCP_CATALOG_CHECK_HEALTH, { id: 'a' })).rejects.toThrow('untrusted sender');
    expect(host.list).not.toHaveBeenCalled();
    expect(host.setEnabled).not.toHaveBeenCalled();
    expect(host.checkHealth).not.toHaveBeenCalled();
  });

  it('set-enabled forwards the payload, returns the fresh view and broadcasts changed', async () => {
    const host = hostStub();
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    registerMcpCatalogHandlers(harness, { host, assertTrusted, broadcast });

    const result = await harness.invoke(MAKER_INVOKE.MCP_CATALOG_SET_ENABLED, { id: 'hermes/shim', enabled: false });

    expect(assertTrusted).toHaveBeenCalledOnce();
    expect(host.setEnabled).toHaveBeenCalledWith('hermes/shim', false);
    expect(result).toEqual(freshView);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.MCP_CATALOG_CHANGED);
  });

  it('check-health returns the health and broadcasts changed', async () => {
    const host = hostStub();
    const broadcast = vi.fn();
    const harness = new IpcHarness();
    registerMcpCatalogHandlers(harness, { host, assertTrusted: vi.fn(), broadcast });

    const result = await harness.invoke(MAKER_INVOKE.MCP_CATALOG_CHECK_HEALTH, { id: 'hermes/remote' });

    expect(host.checkHealth).toHaveBeenCalledWith('hermes/remote');
    expect(result).toEqual({ id: 'hermes/remote', status: 'ok' });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.MCP_CATALOG_CHANGED);
  });
});
