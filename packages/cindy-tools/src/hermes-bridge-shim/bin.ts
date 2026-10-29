/**
 * Entry point Hermes spawns (bundled to dist/hermes-bridge-shim.mjs).
 *
 *   node hermes-bridge-shim.mjs --server cindy_docs [--runtime-file <path>]
 *
 * The Cindy session id comes from CINDY_BRIDGE_SESSION, which config.yaml fills
 * via `${CINDY_BRIDGE_SESSION}` (Hermes does not forward its own env).
 */

import os from 'node:os';
import path from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { BridgeShimError, createBridgeShim } from './shim.js';

const SESSION_ENV = 'CINDY_BRIDGE_SESSION';

function parseArgs(argv: string[]): { serverName: string; runtimeFile: string } {
  let serverName = '';
  let runtimeFile = path.join(os.homedir(), '.cindy-harness', 'hermes-bridge.json');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--server') serverName = argv[++i] ?? '';
    else if (arg === '--runtime-file') runtimeFile = argv[++i] ?? '';
    else throw new BridgeShimError(`unknown argument: ${arg}`);
  }
  if (!serverName) throw new BridgeShimError('--server <name> is required');
  if (!runtimeFile) throw new BridgeShimError('--runtime-file needs a value');
  return { serverName, runtimeFile };
}

async function main(): Promise<void> {
  const { serverName, runtimeFile } = parseArgs(process.argv.slice(2));
  const sessionId = process.env[SESSION_ENV];
  // An unset var or an un-interpolated "${...}" literal both mean no identity.
  if (!sessionId || sessionId.startsWith('${')) {
    throw new BridgeShimError(`${SESSION_ENV} is not set`);
  }
  const shim = await createBridgeShim({ runtimeFile, sessionId, serverName });
  await shim.server.connect(new StdioServerTransport());
  process.stdin.on('close', () => {
    void shim.close().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  // stdout is the MCP channel; diagnostics go to stderr only.
  process.stderr.write(`cindy-hermes-bridge-shim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
