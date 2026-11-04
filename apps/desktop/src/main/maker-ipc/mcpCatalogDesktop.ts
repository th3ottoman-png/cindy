/**
 * Production wiring for the 4.3b MCP catalog host (Electron-dependent; kept out of
 * `mcpCatalog.ts` so the host itself tests under plain vitest).
 *
 * Sources:
 *   - hermes: the `mcp_servers` block of the Cindy Hermes home's config.yaml, read and
 *     written through the hermes-manager client (comment-preserving; never hand-edited).
 *   - lizi: every non-essential builtin plugin that backs an MCP provider, enabled state
 *     from the plugin registry (user-default scope, no workingDir — the same value the
 *     Settings → Tools toggles show). A toggle writes the registry user default and is
 *     picked up by the per-session provider gate on the NEXT session.
 */

import type { McpServerConfig } from '@cindy/maker-core/mcp-catalog';

import { listHermesMcpServers, setHermesMcpServer } from '../maker-host/hermes-manager-client.js';
import { getPluginRegistry } from '../maker-host/index.js';
import { createBuiltinPlugins, mcpIdForBuiltinPluginId } from '../maker-host/plugins/builtin-plugins.js';
import { createMcpCatalogHost, type McpCatalogHost } from './mcpCatalog.js';

/** Reachable = the endpoint answers HTTP at all (a 401/405 still proves the server is up). */
async function probeHttp(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

export function createDesktopMcpCatalogHost(opts?: { expertsRootDir?: string }): McpCatalogHost {
  return createMcpCatalogHost({
    listHermesServers: () => listHermesMcpServers(),
    setHermesServer: (name, server) => setHermesMcpServer(name, server),
    listLiziServers: async () => {
      const registry = getPluginRegistry();
      const servers: Record<string, McpServerConfig> = {};
      for (const plugin of createBuiltinPlugins()) {
        if (plugin.essential) continue;
        if (!mcpIdForBuiltinPluginId(plugin.id)) continue;
        servers[plugin.id] = {
          inProcess: true,
          disabled: !registry.isEnabled(plugin.id),
          description: plugin.description,
        };
      }
      return servers;
    },
    setLiziEnabled: (pluginId, enabled) => getPluginRegistry().setEnabled(pluginId, enabled),
    probe: probeHttp,
    expertsRootDir: opts?.expertsRootDir,
  });
}
