/**
 * hermes-bridge-shim — stdio MCP server that proxies one Cindy bridge server.
 *
 * Hermes spawns this from a static config.yaml entry. It reads the loopback
 * bridge port and its per-session token from the 0600 runtime file written by
 * the desktop main process (apps/desktop .../hermesBridgeRuntimeFile.ts — same
 * shape; this package cannot import desktop code), then forwards tools/list and
 * tools/call to `http://127.0.0.1:<port>/mcp/<server>?session=<id>`.
 *
 * Fails closed: a missing/invalid file, an unknown session, or a bridge that
 * rejects the token ends in an error, never in a fallback.
 */

import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Matches REMOTE_MCP_REQUEST_TIMEOUT_MS in the desktop bridge: browser/ssh tools can run long. */
const TOOL_CALL_TIMEOUT_MS = 600_000;

export interface BridgeCredentials {
  port: number;
  instanceId: string;
  token: string;
}

export class BridgeShimError extends Error {}

export async function readBridgeCredentials(
  runtimeFile: string,
  sessionId: string,
): Promise<BridgeCredentials> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runtimeFile, 'utf8'));
  } catch {
    throw new BridgeShimError(`bridge runtime file missing or unreadable: ${runtimeFile}`);
  }
  const file = parsed as {
    version?: unknown;
    port?: unknown;
    instanceId?: unknown;
    sessions?: unknown;
  };
  if (
    file.version !== 1 ||
    typeof file.port !== 'number' ||
    typeof file.instanceId !== 'string' ||
    !file.sessions ||
    typeof file.sessions !== 'object' ||
    Array.isArray(file.sessions)
  ) {
    throw new BridgeShimError('bridge runtime file is invalid');
  }
  const token = (file.sessions as Record<string, unknown>)[sessionId];
  if (typeof token !== 'string' || token.length === 0) {
    throw new BridgeShimError('no bridge credentials for this session (is Cindy running?)');
  }
  return { port: file.port, instanceId: file.instanceId, token };
}

export interface BridgeShimOptions {
  runtimeFile: string;
  sessionId: string;
  /** Bridge server name, e.g. `cindy_docs`. */
  serverName: string;
}

export interface BridgeShim {
  /** Connect this to the stdio (or test) transport. */
  server: Server;
  close(): Promise<void>;
}

export async function createBridgeShim(opts: BridgeShimOptions): Promise<BridgeShim> {
  const creds = await readBridgeCredentials(opts.runtimeFile, opts.sessionId);
  const url = new URL(
    `http://127.0.0.1:${creds.port}/mcp/${encodeURIComponent(opts.serverName)}`,
  );
  url.searchParams.set('session', opts.sessionId);

  const client = new Client({ name: 'cindy-hermes-bridge-shim', version: '0.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${creds.token}` } },
      }),
    );
  } catch (error) {
    throw new BridgeShimError(
      `bridge connection failed (stale token or Cindy not running): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const server = new Server(
    { name: `cindy-bridge-${opts.serverName}`, version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    client.listTools(request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    client.callTool(request.params, undefined, { timeout: TOOL_CALL_TIMEOUT_MS }),
  );

  return {
    server,
    close: async () => {
      await server.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}
