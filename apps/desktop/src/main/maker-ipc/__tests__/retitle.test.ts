/**
 * Re-title host (ROADMAP 13.9): the trigger gate, the routed decision, ownership and undo.
 * No real network: fetchImpl is injected and the routing files are a temp harness dir.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetitleHost } from '../retitle.js';

let tmp: string;
let harnessDir: string;
let configFile: string;
let stateFile: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function routeTitle(): void {
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
    '  title: cheap',
  ].join('\n'));
}

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

interface Overrides {
  fetchImpl?: unknown;
  title?: string | null;
  userTurns?: number;
  persist?: (id: string, title: string, expected: string) => Promise<boolean>;
  writes?: Array<{ id: string; title: string; expected: string }>;
}

function host(over: Overrides = {}) {
  const writes = over.writes ?? [];
  return new RetitleHost({
    configFile,
    stateFile,
    harnessDir,
    readSessionTitle: async () => (over.title === undefined ? "Old topic" : over.title),
    countUserTurns: async () => over.userTurns ?? 8,
    listMessages: async () => [
      { role: 'user', content: 'lets talk about auth' },
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'now the deploy pipeline' },
    ],
    persistTitle: over.persist ?? (async (id, title, expected) => {
      writes.push({ id, title, expected });
      return true;
    }),
    env: { STUB_KEY: "test-key" },
    ...(over.fetchImpl ? { fetchImpl: over.fetchImpl as typeof fetch } : {}),
  });
}

const changedReply = JSON.stringify({ changed: true, title: "Deploy pipeline" });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-retitle-host-'));
  harnessDir = path.join(tmp, '.cindy-harness');
  configFile = path.join(harnessDir, 'retitle.json');
  stateFile = path.join(harnessDir, 'retitle-state.json');
  fs.mkdirSync(harnessDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('RetitleHost.getConfig', () => {
  it('defaults to on and reports not-routed', () => {
    expect(host().getConfig()).toEqual({ enabled: true, routed: false });
  });
  it('names the route and model once title is routed', () => {
    routeTitle();
    expect(host().getConfig()).toMatchObject({ routed: true, routeName: 'cheap', model: 'stub-model' });
  });
  it('persists the toggle', () => {
    expect(host().setConfig({ enabled: false })).toMatchObject({ enabled: false });
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({ enabled: false });
  });
});
describe('RetitleHost.maybeRetitle — every quiet off-path makes no call', () => {
  const quiet = async (over: Overrides, seed: boolean, expected: string) => {
    routeTitle();
    const fetchImpl = vi.fn();
    const h = host({ ...over, fetchImpl });
    if (seed) h.noteAutoTitle("s1", 0);
    const result = await h.maybeRetitle({ sessionId: "s1", running: false });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe(expected);
    expect(fetchImpl).not.toHaveBeenCalled();
  };

  it('is off when the setting is disabled', async () => {
    write(configFile, JSON.stringify({ enabled: false }));
    await quiet({}, true, 'disabled');
  });
  it('is off while a turn is running', async () => {
    routeTitle();
    const fetchImpl = vi.fn();
    const h = host({ fetchImpl });
    h.noteAutoTitle("s1", 0);
    expect(await h.maybeRetitle({ sessionId: "s1", running: true }))
      .toMatchObject({ changed: false, reason: 'running' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('is off below six user turns since the last title', async () => {
    await quiet({ userTurns: 5 }, true, 'too-few-turns');
  });
  it('is off for an owner-renamed session, permanently', async () => {
    routeTitle();
    const fetchImpl = vi.fn();
    const h = host({ fetchImpl });
    h.noteAutoTitle("s1", 0);
    h.noteOwnerRename("s1");
    expect(await h.maybeRetitle({ sessionId: 's1', running: false }))
      .toMatchObject({ changed: false, reason: 'owner-renamed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('fails closed for a session it never wrote a title for', async () => {
    await quiet({}, false, 'owner-renamed');
  });
  it('is off when title is not routed, and never falls back', async () => {
    const fetchImpl = vi.fn();
    const h = host({ fetchImpl });
    h.noteAutoTitle("s1", 0);
    expect(await h.maybeRetitle({ sessionId: 's1', running: false }))
      .toMatchObject({ changed: false, reason: 'not-routed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('is off for an empty session id', async () => {
    routeTitle();
    const fetchImpl = vi.fn();
    expect(await host({ fetchImpl }).maybeRetitle({ sessionId: '', running: false }))
      .toMatchObject({ changed: false, reason: 'no-session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('RetitleHost.maybeRetitle — the decision', () => {
  it('renames once, records the previous title for undo, and names the route', async () => {
    routeTitle();
    const writes: Array<{ id: string; title: string; expected: string }> = [];
    const h = host({ fetchImpl: stubFetch(changedReply), writes, userTurns: 8 });
    h.noteAutoTitle("s1", 2);
    const result = await h.maybeRetitle({ sessionId: "s1", running: false });
    expect(result).toMatchObject({
      changed: true, title: "Deploy pipeline", previousTitle: "Old topic",
      routeName: 'cheap', model: 'stub-model',
    });
    expect(writes).toEqual([{ id: "s1", title: "Deploy pipeline", expected: "Old topic" }]);
    expect(h.getState("s1")).toEqual({
      source: 'auto', history: ['Old topic'], lastTitleUserTurns: 8,
    });
  });

  it('does not re-ask on every turn end once the model kept the title', async () => {
    routeTitle();
    const fetchImpl = stubFetch(JSON.stringify({ changed: false }));
    const h = host({ fetchImpl, userTurns: 8 });
    h.noteAutoTitle("s1", 2);
    expect(await h.maybeRetitle({ sessionId: 's1', running: false }))
      .toMatchObject({ changed: false, reason: 'model-kept-title' });
    expect(h.getState("s1")?.lastTitleUserTurns).toBe(8);
    const calls = fetchImpl.mock.calls.length;
    await h.maybeRetitle({ sessionId: 's1', running: false });
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('does not overwrite an owner rename made during the call', async () => {
    routeTitle();
    const writes: Array<{ id: string; title: string; expected: string }> = [];
    const inner = stubFetch(changedReply);
    let h: RetitleHost;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      h.noteOwnerRename("s1");
      return inner(url as string, init);
    }) as typeof fetch;
    h = host({ fetchImpl, writes });
    h.noteAutoTitle("s1", 0);
    expect(await h.maybeRetitle({ sessionId: 's1', running: false }))
      .toMatchObject({ changed: false, reason: "owner-renamed" });
    expect(writes).toEqual([]);
  });

  it('fails closed on malformed model output and writes nothing', async () => {
    routeTitle();
    const writes: Array<{ id: string; title: string; expected: string }> = [];
    const h = host({ fetchImpl: stubFetch("I think the title is fine"), writes });
    h.noteAutoTitle("s1", 0);
    expect(await h.maybeRetitle({ sessionId: 's1', running: false })).toMatchObject({ changed: false });
    expect(writes).toEqual([]);
  });

  it('leaves the title alone when the conditional write loses to a user rename', async () => {
    routeTitle();
    const h = host({ fetchImpl: stubFetch(changedReply), persist: async () => false });
    h.noteAutoTitle("s1", 0);
    expect(await h.maybeRetitle({ sessionId: 's1', running: false }))
      .toMatchObject({ changed: false, reason: 'title-changed' });
    expect(h.getState("s1")?.history).toEqual([]);
  });
});

describe('RetitleHost undo and ownership', () => {
  it('restores the previous title and shifts the ring', async () => {
    routeTitle();
    const writes: Array<{ id: string; title: string; expected: string }> = [];
    let current = "Old topic";
    const h = new RetitleHost({
      configFile, stateFile, harnessDir,
      readSessionTitle: async () => current,
      countUserTurns: async () => 8,
      listMessages: async () => [{ role: 'user', content: 'now the deploy pipeline' }],
      persistTitle: async (id, title, expected) => {
        writes.push({ id, title, expected });
        current = title;
        return true;
      },
      env: { STUB_KEY: "test-key" },
      fetchImpl: stubFetch(changedReply) as typeof fetch,
    });
    h.noteAutoTitle("s1", 0);
    await h.maybeRetitle({ sessionId: "s1", running: false });
    expect(current).toBe("Deploy pipeline");
    const undone = await h.undo("s1");
    expect(undone).toMatchObject({ changed: true, title: "Old topic" });
    expect(writes[writes.length - 1]).toEqual({ id: "s1", title: "Old topic", expected: "Deploy pipeline" });
    expect(h.getState("s1")?.history).toEqual([]);
  });

  it('is a no-op with no history', async () => {
    const h = host();
    h.noteAutoTitle("s1", 0);
    expect(await h.undo('s1')).toMatchObject({ changed: false, reason: 'no-history' });
  });

  it('clears the undo ring when the owner renames', () => {
    const h = host();
    h.noteAutoTitle("s1", 0);
    h.noteOwnerRename("s1");
    expect(h.getState('s1')).toMatchObject({ source: 'owner', history: [] });
  });
});

