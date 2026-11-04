/**
 * Unified MCP server catalog (ROADMAP 4.3b). One Settings view over every MCP server Cindy
 * can hand an agent: the Hermes `config.yaml` `mcp_servers` block (start/stop = the `disabled`
 * flag, written through the hermes-manager helpers so comments survive) and the lizi builtin
 * in-process providers (start/stop = the plugin registry's user-default enable, which the
 * per-session provider gate reads — a toggle applies to NEW sessions).
 *
 * This module is Electron-free: every side effect is injected so the host runs under plain
 * vitest. The production wiring (hermes-manager-client, plugin registry) lives in
 * `mcpCatalogDesktop.ts`.
 *
 * Health policy (AGENTS §3: no unprompted outbound calls): `list` computes only static health
 * — stdio command resolvable on PATH (local fs), disabled/invalid, in-process enabled → ok,
 * http → 'unchecked'. An http row is probed (the injected `probe`, the only network call)
 * exclusively when the renderer asks via `check-health`; the result is cached per entry id so
 * a later `list` keeps it. Toggling an entry drops its cached probe.
 */

import os from 'node:os';
import path from 'node:path';

import { loadExpertToolsFile, writeExpertToolsFile } from '@cindy/maker-core/expert-tools';
import { loadExpert } from '@cindy/maker-core/experts';
import {
  buildMcpCatalog,
  checkMcpHealth,
  type McpCatalogEntry,
  type McpHealth,
  type McpHealthStatus,
  type McpServerConfig,
} from '@cindy/maker-core/mcp-catalog';

import { isValidExpertSlug } from './expertSessions.js';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface McpCatalogViewEntry extends McpCatalogEntry {
  health: McpHealthStatus;
  healthDetail?: string;
}

export interface McpCatalogView {
  entries: McpCatalogViewEntry[];
}

export interface McpCatalogHostDeps {
  /** Hermes `mcp_servers` (production: `listHermesMcpServers`). */
  listHermesServers(): Promise<Record<string, McpServerConfig>>;
  /** Persist one Hermes server (production: `setHermesMcpServer`, comment-preserving). */
  setHermesServer(name: string, server: McpServerConfig): Promise<unknown>;
  /** Lizi builtin providers as catalog configs, keyed by plugin id. */
  listLiziServers(): Promise<Record<string, McpServerConfig>>;
  /** Plugin-registry user-default toggle; false means the id cannot be toggled. */
  setLiziEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  /** Optional liveness probe for http servers; runs only on an explicit check-health call. */
  probe?: (url: string) => Promise<boolean>;
  /** Optional experts root dir (defaults to ~/.cindy-harness/experts). */
  expertsRootDir?: string;
}

export interface McpCatalogHost {
  list(): Promise<McpCatalogView>;
  /** Validates its input; throws on an unknown id or a non-boolean enabled. */
  setEnabled(id: unknown, enabled: unknown): Promise<McpCatalogView>;
  /** Static health for any entry; http entries are probed when a probe is injected. */
  checkHealth(id: unknown): Promise<McpHealth>;
  /** Adds an MCP server to an expert's tools.yaml policy under mcp_servers.allow. */
  addToExpert(id: unknown, slug: unknown): Promise<{ ok: true; slug: string; serverName: string }>;
}

const HERMES_PREFIX = 'hermes/';
const LIZI_PREFIX = 'lizi/';

export function createMcpCatalogHost(deps: McpCatalogHostDeps): McpCatalogHost {
  /** Probe results for http entries, keyed by entry id; dropped when the entry is toggled. */
  const probedHealth = new Map<string, McpHealth>();

  async function collect(): Promise<{ entries: McpCatalogEntry[]; configs: Record<string, McpServerConfig> }> {
    const [hermes, lizi] = await Promise.all([deps.listHermesServers(), deps.listLiziServers()]);
    const configs: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(hermes)) configs[`${HERMES_PREFIX}${name}`] = cfg;
    for (const [name, cfg] of Object.entries(lizi)) configs[`${LIZI_PREFIX}${name}`] = cfg;
    const entries = buildMcpCatalog([
      { source: 'hermes', servers: hermes },
      { source: 'lizi', servers: lizi },
    ]);
    return { entries, configs };
  }

  async function view(): Promise<McpCatalogView> {
    const { entries, configs } = await collect();
    const out: McpCatalogViewEntry[] = [];
    for (const entry of entries) {
      // A probed http row keeps its measured health; everything else is the static check.
      const cached = entry.transport === 'http' ? probedHealth.get(entry.id) : undefined;
      const health = cached ?? (await checkMcpHealth(entry, { configs }));
      out.push({ ...entry, health: health.status, ...(health.detail ? { healthDetail: health.detail } : {}) });
    }
    return { entries: out };
  }

  function parseId(id: unknown): string {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('id must be a non-empty string');
    }
    return id;
  }

  return {
    list: view,

    async setEnabled(id: unknown, enabled: unknown) {
      const entryId = parseId(id);
      if (typeof enabled !== 'boolean') {
        throw new Error('enabled (boolean) required');
      }

      if (entryId.startsWith(HERMES_PREFIX)) {
        const name = entryId.slice(HERMES_PREFIX.length);
        if (name === '' || name.includes('/')) throw new Error(`unknown MCP server id: ${entryId}`);
        const servers = await deps.listHermesServers();
        const server = servers[name];
        if (!server) throw new Error(`unknown MCP server id: ${entryId}`);
        await deps.setHermesServer(name, { ...server, disabled: !enabled });
      } else if (entryId.startsWith(LIZI_PREFIX)) {
        const pluginId = entryId.slice(LIZI_PREFIX.length);
        if (pluginId === '' || pluginId.includes('/')) throw new Error(`unknown MCP server id: ${entryId}`);
        const servers = await deps.listLiziServers();
        if (!servers[pluginId]) throw new Error(`unknown MCP server id: ${entryId}`);
        const applied = await deps.setLiziEnabled(pluginId, enabled);
        if (!applied) throw new Error(`MCP server ${entryId} cannot be toggled`);
      } else {
        throw new Error(`unknown MCP server id: ${entryId}`);
      }

      probedHealth.delete(entryId);
      return view();
    },

    async checkHealth(id: unknown) {
      const entryId = parseId(id);
      const { entries, configs } = await collect();
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) throw new Error(`unknown MCP server id: ${entryId}`);
      // The probe is the only network call and runs only here, on explicit request.
      const health = await checkMcpHealth(entry, { configs, probe: deps.probe });
      if (entry.transport === 'http' && deps.probe) probedHealth.set(entryId, health);
      return health;
    },

    async addToExpert(id: unknown, slug: unknown): Promise<{ ok: true; slug: string; serverName: string }> {
      const entryId = parseId(id);
      if (typeof slug !== 'string' || !isValidExpertSlug(slug)) {
        throw new Error('invalid expert slug');
      }

      let serverName: string;
      if (entryId.startsWith(HERMES_PREFIX)) {
        serverName = entryId.slice(HERMES_PREFIX.length);
        if (serverName === '' || serverName.includes('/')) throw new Error(`unknown MCP server id: ${entryId}`);
        const servers = await deps.listHermesServers();
        if (!servers[serverName]) throw new Error(`unknown MCP server id: ${entryId}`);
      } else if (entryId.startsWith(LIZI_PREFIX)) {
        serverName = entryId.slice(LIZI_PREFIX.length);
        if (serverName === '' || serverName.includes('/')) throw new Error(`unknown MCP server id: ${entryId}`);
        const servers = await deps.listLiziServers();
        if (!servers[serverName]) throw new Error(`unknown MCP server id: ${entryId}`);
      } else {
        throw new Error(`unknown MCP server id: ${entryId}`);
      }

      const rootDir = deps.expertsRootDir ?? path.join(os.homedir(), '.cindy-harness', 'experts');
      const expertDir = path.join(rootDir, slug);
      const loadedExpert = loadExpert(expertDir);
      if (loadedExpert.error) {
        throw new Error(`cannot update expert "${slug}": ${loadedExpert.error}`);
      }
      if (!loadedExpert.expert || loadedExpert.expert.agent !== 'hermes') {
        throw new Error(`expert "${slug}" not found or not a hermes agent`);
      }

      const toolsPath = path.join(expertDir, 'tools.yaml');
      const loadedTools = loadExpertToolsFile(toolsPath);
      if (loadedTools.issues.length > 0) {
        throw new Error(`cannot update expert "${slug}" with invalid tools.yaml: ${loadedTools.issues[0].message}`);
      }

      const policy = { ...loadedTools.policy };
      const mcpServers = { ...(policy.mcpServers ?? {}) };
      const currentAllow = mcpServers.allow ? [...mcpServers.allow] : [];
      if (!currentAllow.includes(serverName)) {
        currentAllow.push(serverName);
      }
      mcpServers.allow = currentAllow;
      if (mcpServers.deny) {
        mcpServers.deny = mcpServers.deny.filter((s) => s !== serverName);
        if (mcpServers.deny.length === 0) {
          delete mcpServers.deny;
        }
      }
      policy.mcpServers = mcpServers;
      writeExpertToolsFile(toolsPath, policy);

      return { ok: true, slug, serverName };
    },
  };
}

export interface McpCatalogHandlerDeps {
  host: McpCatalogHost;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production: send to every BrowserWindow. */
  broadcast(channel: string, payload?: unknown): void;
}

/** maker:mcp-catalog:* IPC: the Settings section lists, toggles and probes catalog entries. */
export function registerMcpCatalogHandlers(
  registry: IpcHandlerRegistry,
  deps: McpCatalogHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.MCP_CATALOG_LIST, async (event) => {
    deps.assertTrusted(event);
    return deps.host.list();
  });
  registry.handle(MAKER_INVOKE.MCP_CATALOG_SET_ENABLED, async (event, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const fresh = await deps.host.setEnabled(r.id, r.enabled);
    deps.broadcast(MAKER_PUSH.MCP_CATALOG_CHANGED);
    return fresh;
  });
  registry.handle(MAKER_INVOKE.MCP_CATALOG_CHECK_HEALTH, async (event, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const health = await deps.host.checkHealth(r.id);
    deps.broadcast(MAKER_PUSH.MCP_CATALOG_CHANGED);
    return health;
  });
  registry.handle(MAKER_INVOKE.MCP_CATALOG_ADD_TO_EXPERT, async (event, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const res = await deps.host.addToExpert(r.id, r.slug);
    deps.broadcast(MAKER_PUSH.EXPERTS_CHANGED);
    deps.broadcast(MAKER_PUSH.MCP_CATALOG_CHANGED);
    return res;
  });
}
