import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';

import type { Logger } from '@cindy/maker-core';
import {
  startCodexHttpBridge,
  type CodexHttpBridge,
  withMcpRouteIdentity,
} from '../codexHttpBridge.js';
import {
  readHermesBridgeRuntimeFile,
  upsertHermesBridgeSession,
} from '../hermesBridgeRuntimeFile.js';
import { HERMES_BRIDGE_SESSION_ENV, registerHermesBridgeSession } from '../hermesBridgeSession.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createTestServer(): McpServer {
  const server = new McpServer({ name: 'cindy_test', version: '1.0.0' });
  server.tool('current_session', 'Return the bridge-resolved session id.', {}, async () => ({
    content: [
      { type: 'text' as const, text: getLiziMcpSessionContext()?.sessionId ?? 'no-session' },
    ],
  }));
  return server;
}

/** Streamable-HTTP replies are JSON or a single SSE `data:` frame. */
async function readRpc(res: Response): Promise<{ result?: { content?: Array<{ text: string }> } }> {
  const text = await res.text();
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5) : text);
}

describe('hermes bridge session identity', () => {
  let dir: string;
  let runtimeFile: string;
  let bridge: CodexHttpBridge;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hermes-bridge-'));
    runtimeFile = path.join(dir, 'hermes-bridge.json');
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
  });

  afterEach(async () => {
    await bridge.shutdown();
    // dispose() queues its file removal; retry covers a write still in flight.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** Acts as the stdio shim: reads port+token from the file, then initialize + tools/call. */
  async function callAsShim(
    sessionId: string,
    tokenOverride?: string,
  ): Promise<Response | 'no-credentials'> {
    const file = await readHermesBridgeRuntimeFile(runtimeFile);
    const token = tokenOverride ?? file?.sessions[sessionId];
    if (!file || !token) return 'no-credentials';
    const url = withMcpRouteIdentity(`http://127.0.0.1:${file.port}/mcp/cindy_test`, { sessionId });
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const init = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'shim', version: '1' },
        },
      }),
    });
    if (init.status !== 200) return init;
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
    await init.text();
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'current_session', arguments: {} },
      }),
    });
  }

  const statusOf = (res: Response | 'no-credentials'): number | string =>
    typeof res === 'string' ? res : res.status;

  it('resolves the Cindy session id at tool-call time and exposes only a non-secret env', async () => {
    const session = await registerHermesBridgeSession({
      bridge,
      runtimeFile,
      info: { sessionId: 'sess-A', workingDir: '/work/a' },
    });
    expect(session.env).toEqual({ [HERMES_BRIDGE_SESSION_ENV]: 'sess-A' });

    const file = await readHermesBridgeRuntimeFile(runtimeFile);
    expect(file).toMatchObject({ version: 1, port: bridge.port, instanceId: bridge.instanceId });
    expect(JSON.stringify(session.env)).not.toContain(file!.sessions['sess-A']);
    if (process.platform !== 'win32') {
      expect((await stat(runtimeFile)).mode & 0o777).toBe(0o600);
    }

    const res = (await callAsShim('sess-A')) as Response;
    expect((await readRpc(res)).result?.content?.[0]?.text).toBe('sess-A');
    session.dispose();
  });

  it("keeps concurrent sessions isolated and refuses another session's token", async () => {
    const a = await registerHermesBridgeSession({
      bridge,
      runtimeFile,
      info: { sessionId: 'sess-A', workingDir: '/work/a' },
    });
    const b = await registerHermesBridgeSession({
      bridge,
      runtimeFile,
      info: { sessionId: 'sess-B', workingDir: '/work/b' },
    });
    const file = await readHermesBridgeRuntimeFile(runtimeFile);
    expect(Object.keys(file!.sessions).sort()).toEqual(['sess-A', 'sess-B']);

    const asB = (await callAsShim('sess-B')) as Response;
    expect((await readRpc(asB)).result?.content?.[0]?.text).toBe('sess-B');

    // Session A's id with session B's token must not authenticate.
    expect(statusOf(await callAsShim('sess-A', file!.sessions['sess-B']))).toBe(401);
    a.dispose();
    b.dispose();
  });

  it('dispose unregisters the bridge identity and removes the file entry, idempotently', async () => {
    const session = await registerHermesBridgeSession({
      bridge,
      runtimeFile,
      info: { sessionId: 'sess-A', workingDir: '/work/a' },
    });
    const token = (await readHermesBridgeRuntimeFile(runtimeFile))!.sessions['sess-A'];
    session.dispose();
    session.dispose();
    // Writes are queued per file, so this upsert lands after the removal.
    await upsertHermesBridgeSession(
      runtimeFile,
      { port: bridge.port, instanceId: bridge.instanceId },
      'probe',
      'x',
    );
    const after = await readHermesBridgeRuntimeFile(runtimeFile);
    expect(Object.keys(after!.sessions)).toEqual(['probe']);

    expect(statusOf(await callAsShim('sess-A', token))).toBe(401);
  });

  it('drops tokens written for a previous bridge instance', async () => {
    await upsertHermesBridgeSession(
      runtimeFile,
      { port: 1, instanceId: 'old-instance' },
      'stale',
      'old-token',
    );
    const session = await registerHermesBridgeSession({
      bridge,
      runtimeFile,
      info: { sessionId: 'sess-A', workingDir: '/work/a' },
    });
    const file = await readHermesBridgeRuntimeFile(runtimeFile);
    expect(file!.instanceId).toBe(bridge.instanceId);
    expect(Object.keys(file!.sessions)).toEqual(['sess-A']);
    session.dispose();
  });

  it('treats a truncated runtime file as absent so the shim fails closed', async () => {
    await writeFile(runtimeFile, '{"version":1,"port":');
    expect(await readHermesBridgeRuntimeFile(runtimeFile)).toBeNull();
  });
});
