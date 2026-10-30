import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderFileEntry } from '@cindy/model-providers/providers-file';

import { discoverEndpoints, modelsUrl, probeEndpoint } from '../discovery.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const entry = (over: Partial<ProviderFileEntry>): ProviderFileEntry => ({
  id: 'e',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1',
  capabilities: { tools: false, vision: false },
  local: true,
  ...over,
});

describe('modelsUrl', () => {
  it.each([
    ['ollama', 'http://h:11434', 'http://h:11434/api/tags'],
    ['openai-compatible', 'https://api.x.com/v1', 'https://api.x.com/v1/models'],
    ['lmstudio', 'http://h:1234', 'http://h:1234/v1/models'],
    ['llamacpp', 'http://h:8080/', 'http://h:8080/v1/models'],
  ] as const)('%s %s', (kind, baseUrl, expected) => {
    expect(modelsUrl({ kind, baseUrl })).toBe(expected);
  });
});

describe('probeEndpoint', () => {
  it('reads Ollama /api/tags names, sorted and de-duplicated', async () => {
    const base = await serve((req, res) => {
      expect(req.url).toBe('/api/tags');
      res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }, { name: 'qwen3:8b' }] }));
    });
    const probe = await probeEndpoint(entry({ kind: 'ollama', baseUrl: base }));
    expect(probe).toMatchObject({ id: 'e', status: 'online', models: ['llama3.2:3b', 'qwen3:8b'] });
  });

  it('reads OpenAI-style /v1/models and sends the key from the named env var only', async () => {
    let auth: string | undefined;
    const base = await serve((req, res) => {
      auth = req.headers.authorization;
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
    });
    const probe = await probeEndpoint(entry({ baseUrl: base, keyEnv: 'MY_KEY' }), { env: { MY_KEY: 'secret-value', OTHER: 'nope' } });
    expect(probe.status).toBe('online');
    expect(probe.models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(auth).toBe('Bearer secret-value');
  });

  it('sends no Authorization header when the env var is unset', async () => {
    let auth: string | undefined = 'unset';
    const base = await serve((req, res) => {
      auth = req.headers.authorization;
      res.end('{"data":[]}');
    });
    await probeEndpoint(entry({ baseUrl: base, keyEnv: 'MISSING' }), { env: {} });
    expect(auth).toBeUndefined();
  });

  it('reports a closed port as offline', async () => {
    const base = await serve((_req, res) => res.end('{}'));
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
    const probe = await probeEndpoint(entry({ baseUrl: base }));
    expect(probe.status).toBe('offline');
    expect(probe.models).toEqual([]);
  });

  it('reports a hung endpoint as offline after the timeout', async () => {
    const base = await serve(() => undefined);
    const probe = await probeEndpoint(entry({ baseUrl: base }), { timeoutMs: 150 });
    expect(probe).toMatchObject({ status: 'offline', error: 'no reply within 150 ms' });
  });

  it.each([
    ['an HTTP error', (_q: http.IncomingMessage, r: http.ServerResponse) => { r.statusCode = 401; r.end('no'); }, 'HTTP 401'],
    ['non-JSON', (_q: http.IncomingMessage, r: http.ServerResponse) => r.end('<html>'), 'not JSON'],
    ['JSON without a model list', (_q: http.IncomingMessage, r: http.ServerResponse) => r.end('{"ok":true}'), 'no model list'],
  ])('reports %s as error, not offline', async (_label, handler, fragment) => {
    const base = await serve(handler);
    const probe = await probeEndpoint(entry({ baseUrl: base }));
    expect(probe.status).toBe('error');
    expect(probe.error).toContain(fragment);
  });

  it('refuses redirects so the key cannot be sent to another host', async () => {
    let hits = 0;
    const other = await serve((_q, r) => { hits++; r.end('{"data":[]}'); });
    const base = await serve((_q, r) => { r.statusCode = 302; r.setHeader('location', `${other}/v1/models`); r.end(); });
    const probe = await probeEndpoint(entry({ baseUrl: base, keyEnv: 'K' }), { env: { K: 'v' } });
    expect(probe.status).toBe('offline');
    expect(hits).toBe(0);
  });
});

describe('discoverEndpoints', () => {
  it('probes all entries and keeps their order, one dead endpoint not affecting the rest', async () => {
    const up = await serve((_q, r) => r.end('{"data":[{"id":"m"}]}'));
    const result = await discoverEndpoints([entry({ id: 'down', baseUrl: 'http://127.0.0.1:1' }), entry({ id: 'up', baseUrl: up })]);
    expect(result.map((p) => [p.id, p.status])).toEqual([['down', 'offline'], ['up', 'online']]);
  });
});
