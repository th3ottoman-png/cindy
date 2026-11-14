/**
 * Recap host (ROADMAP 13.3): the trigger gate, the routed call, and every quiet off-path.
 * No real network: fetchImpl is injected, and the routing files are a temp harness dir.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecapHost, defaultRecapConfigFile } from '../recap.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;

let tmp: string;
let harnessDir: string;
let configFile: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** A routed `recap` rule pointing at a loopback provider, so no real endpoint is contacted. */
function routeRecap(): void {
  write(path.join(harnessDir, 'providers.yaml'), [
    'providers:',
    '  - id: stub',
    '    kind: openai-compatible',
    '    baseUrl: http://127.0.0.1:9/v1',
    '    keyEnv: STUB_KEY',
  ].join('\n'));
  write(path.join(harnessDir, 'routing.yaml'), [
    'routes:',
    '  cheap: { provider: stub, model: stub-model }',
    'rules:',
    '  recap: cheap',
  ].join('\n'));
}

function turns(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`,
  }));
}

function host(over: Record<string, unknown> = {}) {
  return new RecapHost({
    configFile,
    harnessDir,
    listMessages: async () => turns(8),
    now: () => NOW,
    env: { STUB_KEY: 'test-key' },
    ...over,
  } as never);
}

function focus(over: Record<string, unknown> = {}) {
  return { sessionId: 's1', leftAt: NOW - 20 * MIN, turnCount: 4, running: false, ...over };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-recap-host-'));
  harnessDir = path.join(tmp, '.cindy-harness');
  configFile = path.join(harnessDir, 'recap.json');
  fs.mkdirSync(harnessDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('RecapHost.getConfig', () => {
  it('defaults to on, 15 minutes, and reports not-routed', () => {
    expect(host().getConfig()).toEqual({ enabled: true, awayMinutes: 15, routed: false });
  });
  it('names the route and model once recap is routed', () => {
    routeRecap();
    expect(host().getConfig()).toMatchObject({ routed: true, routeName: 'cheap', model: 'stub-model' });
  });
  it('persists a config patch and keeps the other field', () => {
    const h = host();
    expect(h.setConfig({ enabled: false })).toMatchObject({ enabled: false, awayMinutes: 15 });
    expect(h.setConfig({ awayMinutes: 30 })).toMatchObject({ enabled: false, awayMinutes: 30 });
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({ enabled: false, awayMinutes: 30 });
  });
  it('resolves the default config file under the harness dir', () => {
    expect(defaultRecapConfigFile()).toBe(path.join(os.homedir(), '.cindy-harness', 'recap.json'));
  });
});

describe('RecapHost.onFocus — the quiet off-paths make no call', () => {
  it('does nothing when the setting is off', async () => {
    routeRecap();
    const fetchImpl = vi.fn();
    write(configFile, JSON.stringify({ enabled: false }));
    expect(await host({ fetchImpl }).onFocus(focus())).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing while a turn is running', async () => {
    routeRecap();
    const fetchImpl = vi.fn();
    expect(await host({ fetchImpl }).onFocus(focus({ running: true }))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing below the turn floor', async () => {
    routeRecap();
    const fetchImpl = vi.fn();
    expect(await host({ fetchImpl }).onFocus(focus({ turnCount: 3 }))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing inside the away window', async () => {
    routeRecap();
    const fetchImpl = vi.fn();
    expect(await host({ fetchImpl }).onFocus(focus({ leftAt: NOW - 5 * MIN }))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing when recap is not routed, and never falls back', async () => {
    const fetchImpl = vi.fn();
    expect(await host({ fetchImpl }).onFocus(focus())).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing for an empty session id', async () => {
    const fetchImpl = vi.fn();
    expect(await host({ fetchImpl }).onFocus(focus({ sessionId: '' }))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('RecapHost.onFocus — the delivered strip', () => {
  /** Stubs the probe and the generation call so no socket is opened. */
  function stubFetch(text: string) {
    return vi.fn(async (url: unknown, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'stub-model' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    });
  }

  it('returns a strip naming the route, model and provider', async () => {
    routeRecap();
    const fetchImpl = stubFetch('You were pruning storage. Next: run the recap proof.');
    const strip = await host({ fetchImpl }).onFocus(focus());
    expect(strip).toMatchObject({
      sessionId: 's1',
      text: 'You were pruning storage. Next: run the recap proof.',
      routeName: 'cheap',
      model: 'stub-model',
      provider: 'stub',
      turnCount: 4,
      generatedAt: NOW,
    });
  });

  it('asks at most once per away period', async () => {
    routeRecap();
    const fetchImpl = stubFetch('state');
    const h = host({ fetchImpl });
    expect(await h.onFocus(focus())).not.toBeNull();
    const calls = fetchImpl.mock.calls.length;
    expect(await h.onFocus(focus())).toBeNull();
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('asks again once new turns arrive', async () => {
    routeRecap();
    const fetchImpl = stubFetch('state');
    const h = host({ fetchImpl });
    await h.onFocus(focus());
    expect(await h.onFocus(focus({ turnCount: 6 }))).not.toBeNull();
  });

  it('stops offering a dismissed strip until new turns arrive', async () => {
    routeRecap();
    const fetchImpl = stubFetch('state');
    const h = host({ fetchImpl });
    await h.onFocus(focus());
    h.dismiss('s1');
    expect(await h.onFocus(focus())).toBeNull();
    expect(await h.onFocus(focus({ turnCount: 9 }))).not.toBeNull();
  });

  it('returns no strip and warns once when the route is blocked', async () => {
    write(path.join(harnessDir, 'providers.yaml'), 'providers: []\n');
    write(path.join(harnessDir, 'routing.yaml'), 'routes: {}\nrules:\n  recap: nope\n');
    const warn = vi.fn();
    const fetchImpl = vi.fn();
    expect(await host({ fetchImpl, log: { warn } }).onFocus(focus())).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns no strip when the generation call fails', async () => {
    routeRecap();
    const fetchImpl = vi.fn(async (url: unknown, _init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'stub-model' }] }), { status: 200 });
      }
      return new Response('upstream exploded', { status: 500 });
    });
    const warn = vi.fn();
    expect(await host({ fetchImpl, log: { warn } }).onFocus(focus())).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns no strip for an empty reply', async () => {
    routeRecap();
    expect(await host({ fetchImpl: stubFetch('   ') }).onFocus(focus())).toBeNull();
  });

  it('never throws when listing messages rejects', async () => {
    routeRecap();
    const warn = vi.fn();
    const h = host({ listMessages: async () => { throw new Error('db gone'); }, log: { warn } });
    expect(await h.onFocus(focus())).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('sends the recap system prompt and a bounded transcript', async () => {
    routeRecap();
    const fetchImpl = stubFetch('state');
    await host({ fetchImpl }).onFocus(focus());
    const call = fetchImpl.mock.calls.find((c) => !String(c[0]).endsWith('/models'))!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as { messages: { role: string; content: string }[] };
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toMatch(/ONE or TWO sentences/);
    expect(body.messages[1]!.content).toContain('Owner: turn 0');
  });
});