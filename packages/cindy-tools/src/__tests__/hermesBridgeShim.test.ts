/**
 * Hermes bridge shim against a stub streamable-HTTP MCP server that enforces the
 * same auth contract as the desktop bridge (Bearer token + `?session=` query).
 * The last tests run the esbuild bundle over real stdio, exactly as Hermes does.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// @ts-expect-error plain .mjs build helper without types
import { buildShim } from '../../build-shim.mjs';
import { BridgeShimError, createBridgeShim, readBridgeCredentials } from '../hermes-bridge-shim/shim.js';

const TOKEN = 'tok-A';
const SESSION = 'sess-A';

interface Stub {
  port: number;
  seen: Array<{ session: string | null; auth: string | undefined }>;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const seen: Stub['seen'] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const session = url.searchParams.get('session');
    if (req.headers.authorization !== `Bearer ${TOKEN}` || session !== SESSION || url.pathname !== '/mcp/cindy_stub') {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    seen.push({ session, auth: req.headers.authorization });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const mcp = new McpServer({ name: 'cindy_stub', version: '1.0.0' });
    mcp.tool('echo', 'Echo text', { text: z.string() }, async ({ text }) => ({
      content: [{ type: 'text' as const, text: `echo:${text}` }],
    }));
    mcp.tool('boom', 'Always fails', {}, async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'nope' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe('hermes bridge shim', () => {
  let dir: string;
  let runtimeFile: string;
  let stub: Stub;

  const writeRuntime = (sessions: Record<string, string>, port = stub.port) =>
    writeFile(runtimeFile, JSON.stringify({ version: 1, port, instanceId: 'inst-1', sessions }));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hermes-shim-'));
    runtimeFile = path.join(dir, 'hermes-bridge.json');
    stub = await startStub();
    await writeRuntime({ [SESSION]: TOKEN });
  });

  afterEach(async () => {
    await stub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('proxies tools/list and tools/call, including isError results, with token and session', async () => {
    const shim = await createBridgeShim({ runtimeFile, sessionId: SESSION, serverName: 'cindy_stub' });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await shim.server.connect(serverSide);
    const client = new Client({ name: 'hermes', version: '1' });
    await client.connect(clientSide);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['boom', 'echo']);
    const ok = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(ok.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    const bad = await client.callTool({ name: 'boom', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(stub.seen.length).toBeGreaterThan(0);
    expect(stub.seen.every((s) => s.session === SESSION && s.auth === `Bearer ${TOKEN}`)).toBe(true);

    await client.close();
    await shim.close();
  });

  it('fails closed without credentials', async () => {
    await expect(readBridgeCredentials(path.join(dir, 'absent.json'), SESSION)).rejects.toBeInstanceOf(BridgeShimError);
    await expect(readBridgeCredentials(runtimeFile, 'other-session')).rejects.toThrow(/no bridge credentials/);
    await writeFile(runtimeFile, '{"version":1,"port":');
    await expect(readBridgeCredentials(runtimeFile, SESSION)).rejects.toThrow(/missing or unreadable/);
    await writeFile(runtimeFile, JSON.stringify({ version: 2, port: 1, instanceId: 'x', sessions: {} }));
    await expect(readBridgeCredentials(runtimeFile, SESSION)).rejects.toThrow(/invalid/);
  });

  it('fails closed when the bridge rejects the token (stale file)', async () => {
    await writeRuntime({ [SESSION]: 'stale-token' });
    await expect(
      createBridgeShim({ runtimeFile, sessionId: SESSION, serverName: 'cindy_stub' }),
    ).rejects.toThrow(/bridge connection failed/);
  });

  it('fails closed when the bridge instance is gone', async () => {
    await writeRuntime({ [SESSION]: TOKEN }, 1);
    await expect(
      createBridgeShim({ runtimeFile, sessionId: SESSION, serverName: 'cindy_stub' }),
    ).rejects.toThrow(/bridge connection failed/);
  });

  it('works as the esbuild bundle over real stdio, reading the session from env', async () => {
    const bundle = await buildShim(path.join(dir, 'hermes-bridge-shim.mjs'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, '--server', 'cindy_stub', '--runtime-file', runtimeFile],
      env: { PATH: process.env.PATH ?? '', CINDY_BRIDGE_SESSION: SESSION },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'hermes', version: '1' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'stdio' } });
    expect(result.content).toEqual([{ type: 'text', text: 'echo:stdio' }]);
    await client.close();
  }, 30_000);

  it('the bundle exits non-zero when the session env is missing or un-interpolated', async () => {
    const bundle = await buildShim(path.join(dir, 'hermes-bridge-shim.mjs'));
    for (const value of [undefined, '${CINDY_BRIDGE_SESSION}']) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [bundle, '--server', 'cindy_stub', '--runtime-file', runtimeFile],
        env: { PATH: process.env.PATH ?? '', ...(value ? { CINDY_BRIDGE_SESSION: value } : {}) },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'hermes', version: '1' });
      await expect(client.connect(transport)).rejects.toThrow();
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});
