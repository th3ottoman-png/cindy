import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { chatCompletionsUrl, requestRoutedTaskText } from '../routed-auxiliary.js';

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function harness(providersYaml: string, routingYaml?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routed-aux-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'providers.yaml'), providersYaml);
  if (routingYaml !== undefined) fs.writeFileSync(path.join(dir, 'routing.yaml'), routingYaml);
  return dir;
}

interface ServedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One server answering both the discovery probe and the generation call. */
async function serveModel(
  models: string[],
  reply: (body: string) => { status?: number; json: unknown } | null,
): Promise<{ base: string; requests: ServedRequest[] }> {
  const requests: ServedRequest[] = [];
  const base = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      const answered = reply(body);
      if (answered === null) return; // hang: exercise the timeout
      if (answered.status) res.statusCode = answered.status;
      res.end(typeof answered.json === 'string' ? answered.json : JSON.stringify(answered.json));
    });
  });
  return { base, requests };
}

const providers = (base: string, extra = ''): string =>
  `providers:\n  - id: local-a\n    kind: openai-compatible\n    baseUrl: ${base}\n${extra}`;

const routing = (route: string, rule = 'title'): string =>
  `routes:\n  small: { provider: local-a, model: "${route}" }\nrules:\n  ${rule}: small\n`;

const content = (text: string): { json: unknown } => ({
  json: { choices: [{ message: { role: 'assistant', content: text } }] },
});

describe('chatCompletionsUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1/chat/completions'],
    ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234/v1/chat/completions'],
    ['https://api.x.com/v1', 'https://api.x.com/v1/chat/completions'],
  ])('%s', (base, expected) => {
    expect(chatCompletionsUrl(base)).toBe(expected);
  });
});

describe('requestRoutedTaskText routing decisions', () => {
  it('is not-routed when there is no routing.yaml, so callers keep their existing chain', async () => {
    const dir = harness(providers('http://127.0.0.1:1'));
    expect(await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} })).toEqual({ kind: 'not-routed' });
  });

  it('is not-routed when routing.yaml has no rule for this task', async () => {
    const dir = harness(providers('http://127.0.0.1:1'), routing('qwen3:8b', 'predict'));
    expect(await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} })).toEqual({ kind: 'not-routed' });
  });

  it('fails closed on a title rule that names an unknown route instead of falling through', async () => {
    const dir = harness(providers('http://127.0.0.1:1'), 'routes: {}\nrules:\n  title: small\n');
    const result = await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} });
    expect(result).toMatchObject({ kind: 'blocked', reason: 'invalid-rule' });
    expect(result.kind === 'blocked' && result.message).toContain('unknown route');
  });

  it('fails closed when the routed provider is offline and lists a healthy local alternative', async () => {
    const live = await serveModel(['m'], () => content('x'));
    const dir = harness(
      `providers:\n  - id: dead\n    kind: openai-compatible\n    baseUrl: http://127.0.0.1:1\n  - id: alive\n    kind: openai-compatible\n    baseUrl: ${live.base}\n`,
      `routes:\n  broken: { provider: dead, model: m }\n  good: { provider: alive, model: m }\nrules:\n  title: broken\n`,
    );
    const result = await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} });
    expect(result).toMatchObject({ kind: 'blocked', reason: 'provider-offline' });
    expect(result.kind === 'blocked' && result.alternatives).toEqual([
      { routeName: 'good', provider: 'alive', model: 'm', paid: false },
    ]);
    expect(live.requests.every((r) => r.url === '/v1/models')).toBe(true);
  });

  it('fails closed when the online endpoint does not list the routed model', async () => {
    const live = await serveModel(['other-model'], () => content('x'));
    const dir = harness(providers(live.base), routing('qwen3:8b'));
    const result = await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} });
    expect(result).toMatchObject({ kind: 'blocked', reason: 'model-missing' });
  });
});

describe('requestRoutedTaskText generation', () => {
  it('returns the trimmed model text and posts the routed model, prompt and token cap', async () => {
    const live = await serveModel(['qwen3:8b'], () => content('  My Title  '));
    const dir = harness(providers(live.base), routing('qwen3:8b'));
    const result = await requestRoutedTaskText(
      { taskClass: 'title', prompt: 'Name this chat', maxTokens: 64 },
      { harnessDir: dir, env: {} },
    );
    expect(result).toMatchObject({ kind: 'ok', text: 'My Title', routeName: 'small', provider: 'local-a', model: 'qwen3:8b' });
    const call = live.requests.find((r) => r.url === '/v1/chat/completions')!;
    expect(JSON.parse(call.body)).toEqual({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'Name this chat' }],
      max_tokens: 64,
      stream: false,
    });
  });

  it('places the system prompt before the user prompt', async () => {
    const live = await serveModel(['m'], () => content('t'));
    const dir = harness(providers(live.base), routing('m'));
    await requestRoutedTaskText({ taskClass: 'title', prompt: 'p', systemPrompt: 'Be brief' }, { harnessDir: dir, env: {} });
    const call = live.requests.find((r) => r.url === '/v1/chat/completions')!;
    expect(JSON.parse(call.body).messages).toEqual([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'p' },
    ]);
  });

  it('sends the key from the named env var only, and nothing when the var is unset', async () => {
    const live = await serveModel(['m'], () => content('t'));
    const dir = harness(providers(live.base, '    keyEnv: MY_KEY\n'), routing('m'));
    await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: { MY_KEY: 'sekret', OTHER: 'nope' } });
    const withKey = live.requests.find((r) => r.url === '/v1/chat/completions')!;
    expect(withKey.headers.authorization).toBe('Bearer sekret');
    await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} });
    const calls = live.requests.filter((r) => r.url === '/v1/chat/completions');
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('accepts a model listed as name:latest when the route names the bare model', async () => {
    const live = await serveModel(['qwen3:latest'], () => content('t'));
    const dir = harness(providers(live.base), routing('qwen3'));
    const result = await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} });
    expect(result).toMatchObject({ kind: 'ok', text: 't' });
  });

  it.each([
    ['an HTTP error', () => ({ status: 500, json: { error: 'boom' } }), 'HTTP 500'],
    ['non-JSON', () => ({ json: '<html>' as unknown }), 'reply is not JSON'],
    ['JSON without content', () => ({ json: { choices: [] } }), 'reply has no message content'],
    ['blank content', () => content('   '), 'reply has no message content'],
  ] as const)('reports %s as failed, never as ok', async (_label, reply, fragment) => {
    const live = await serveModel(['m'], reply);
    const dir = harness(providers(live.base), routing('m'));
    const result = await requestRoutedTaskText({ taskClass: 'title', prompt: 'p' }, { harnessDir: dir, env: {} });
    expect(result).toMatchObject({ kind: 'failed', routeName: 'small', provider: 'local-a', model: 'm' });
    expect(result.kind === 'failed' && result.message).toContain(fragment);
  });

  it('reports a hung generation as failed after the timeout', async () => {
    const live = await serveModel(['m'], () => null);
    const dir = harness(providers(live.base), routing('m'));
    const result = await requestRoutedTaskText({ taskClass: 'title', prompt: 'p', timeoutMs: 150 }, { harnessDir: dir, env: {} });
    expect(result).toMatchObject({ kind: 'failed', message: 'no reply within 150 ms' });
  });

  it('refuses redirects so the key cannot be bounced to another host', async () => {
    let otherHits = 0;
    const other = await serve((_q, r) => { otherHits++; r.end(JSON.stringify({ choices: [{ message: { content: 'stolen' } }] })); });
    const redirecting = await serve((req, res) => {
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'm' }] })); return; }
      res.statusCode = 302;
      res.setHeader('location', `${other}/v1/chat/completions`);
      res.end();
    });
    const dir = harness(providers(redirecting, '    keyEnv: MY_KEY\n'), routing('m'));
    const result = await requestRoutedTaskText(
      { taskClass: 'title', prompt: 'p' },
      { harnessDir: dir, env: { MY_KEY: 'sekret' } },
    );
    expect(result.kind).toBe('failed');
    expect(otherHits).toBe(0);
  });

  it('reports an aborted caller signal as failed, not as a timeout', async () => {
    const live = await serveModel(['m'], () => null);
    const dir = harness(providers(live.base), routing('m'));
    const controller = new AbortController();
    controller.abort();
    const result = await requestRoutedTaskText(
      { taskClass: 'title', prompt: 'p', timeoutMs: 5000, signal: controller.signal },
      { harnessDir: dir, env: {} },
    );
    expect(result).toMatchObject({ kind: 'failed', message: 'aborted' });
  });
});
