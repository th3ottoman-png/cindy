/**
 * Tool-batch label host (ROADMAP 13.4): not routed = off, one routed call per uncached group,
 * the cache means a second ask never calls again, and every failure leaves the group generic.
 * No real network: fetchImpl is injected, and the routing files are a temp harness dir.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOOL_LABEL_MAX_GROUPS_PER_REQUEST,
  ToolLabelHost,
  defaultToolLabelCacheDir,
  parseToolLabelGroups,
} from '../toolLabels.js';

let tmp: string;
let harnessDir: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** A routed `tool-label` rule pointing at a loopback provider, so no real endpoint is contacted. */
function routeToolLabel(): void {
  write(
    path.join(harnessDir, 'providers.yaml'),
    [
      'providers:',
      '  - id: stub',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:9/v1',
      '    keyEnv: STUB_KEY',
    ].join('\n'),
  );
  write(
    path.join(harnessDir, 'routing.yaml'),
    [
      'routes:',
      '  cheap: { provider: stub, model: stub-model }',
      'rules:',
      '  tool-label: cheap',
    ].join('\n'),
  );
}

/** Stubs the probe and the generation call; counts generation calls separately. */
function stubFetch(replies: string[]) {
  let i = 0;
  const generations: string[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'stub-model' }] }), { status: 200 });
    }
    generations.push(String(init?.body ?? ''));
    const text = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );
  });
  return { fn, generations };
}

function host(fetchImpl?: typeof fetch) {
  return new ToolLabelHost({
    harnessDir,
    now: () => 1_700_000_000_000,
    env: { STUB_KEY: 'test-key' },
    ...(fetchImpl ? { fetchImpl } : {}),
    log: { warn: () => undefined },
  });
}

const group = (key: string, n = 2) => ({
  key,
  calls: Array.from({ length: n }, (_, i) => ({
    name: 'Read',
    input: { file_path: `src/${i}.ts` },
  })),
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-tool-label-host-'));
  harnessDir = path.join(tmp, '.cindy-harness');
  fs.mkdirSync(harnessDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ToolLabelHost — not routed', () => {
  it('reports off and never calls the network', async () => {
    const { fn } = stubFetch(['x']);
    const h = host(fn as unknown as typeof fetch);
    expect(h.getConfig()).toEqual({ routed: false });
    expect(await h.labelGroups('s1', [group('toolu_1')])).toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });
  it('hides cached labels while the route is off, so headers revert to generic', async () => {
    routeToolLabel();
    const { fn } = stubFetch(['Read source files']);
    const h = host(fn as unknown as typeof fetch);
    await h.labelGroups('s1', [group('toolu_1')]);
    expect(Object.keys(h.getLabels('s1'))).toEqual(['toolu_1']);
    fs.rmSync(path.join(harnessDir, 'routing.yaml'));
    expect(h.getLabels('s1')).toEqual({});
  });
  it('uses ~/.cindy-harness/tool-labels by default', () => {
    expect(defaultToolLabelCacheDir()).toBe(
      path.join(os.homedir(), '.cindy-harness', 'tool-labels'),
    );
  });
});

describe('ToolLabelHost — routed', () => {
  it('names the route and model', () => {
    routeToolLabel();
    expect(host().getConfig()).toEqual({ routed: true, routeName: 'cheap', model: 'stub-model' });
  });

  it('labels each uncached group once, persists route/model/count, and never re-bills', async () => {
    routeToolLabel();
    const { fn, generations } = stubFetch(['Read source files', 'Ran the tests']);
    const h = host(fn as unknown as typeof fetch);
    const labels = await h.labelGroups('s1', [group('toolu_1', 3), group('toolu_2', 1)]);
    expect(generations).toHaveLength(2);
    expect(labels.toolu_1).toEqual({
      label: 'Read source files',
      toolCount: 3,
      routeName: 'cheap',
      model: 'stub-model',
      provider: 'stub',
      createdAt: 1_700_000_000_000,
    });
    expect(labels.toolu_2?.label).toBe('Ran the tests');

    // Reopen: a fresh host over the same files reads the cache and makes no generation call.
    const again = host(fn as unknown as typeof fetch);
    expect(again.getLabels('s1')).toEqual(labels);
    await again.labelGroups('s1', [group('toolu_1', 3), group('toolu_2', 1)]);
    expect(generations).toHaveLength(2);
    expect(fs.existsSync(path.join(harnessDir, 'tool-labels', 's1.json'))).toBe(true);
  });

  it('sends the redacted digest with the new label prompt', async () => {
    routeToolLabel();
    const { fn, generations } = stubFetch(['Called the API']);
    await host(fn as unknown as typeof fetch).labelGroups('s1', [
      {
        key: 'toolu_9',
        calls: [
          {
            name: 'Bash',
            input: { command: 'curl -H "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456" u' },
          },
        ],
      },
    ]);
    const body = JSON.parse(generations[0]!);
    const text = JSON.stringify(body.messages);
    expect(text).toContain('Tool calls (1):');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(body.messages[0].role).toBe('system');
  });

  it('retries once on an empty or over-long reply, then uses the good one', async () => {
    routeToolLabel();
    const { fn, generations } = stubFetch(['', 'Listed proof files']);
    const labels = await host(fn as unknown as typeof fetch).labelGroups('s1', [group('toolu_1')]);
    expect(generations).toHaveLength(2);
    expect(labels.toolu_1?.label).toBe('Listed proof files');
  });

  it('two rejected replies leave the group generic and stop there', async () => {
    routeToolLabel();
    const { fn, generations } = stubFetch([
      'The agent read a lot of files and then ran every test',
    ]);
    const h = host(fn as unknown as typeof fetch);
    expect(await h.labelGroups('s1', [group('toolu_1')])).toEqual({});
    expect(generations).toHaveLength(2);
  });

  it('a failed call never throws and leaves the group generic', async () => {
    routeToolLabel();
    const fn = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'stub-model' }] }), { status: 200 });
      }
      return new Response('boom', { status: 500 });
    });
    expect(await host(fn as unknown as typeof fetch).labelGroups('s1', [group('toolu_1')])).toEqual(
      {},
    );
    // One call plus one retry, never more.
    expect(fn.mock.calls.filter(([u]) => !String(u).endsWith('/models'))).toHaveLength(2);
  });

  it('caps the groups per request', async () => {
    routeToolLabel();
    const { fn, generations } = stubFetch(['Read files']);
    const many = Array.from({ length: TOOL_LABEL_MAX_GROUPS_PER_REQUEST + 3 }, (_, i) =>
      group(`toolu_${i}`),
    );
    // Good replies: one call per group, so the cap equals the number of generation calls.
    await host(fn as unknown as typeof fetch).labelGroups('s1', many);
    expect(generations).toHaveLength(TOOL_LABEL_MAX_GROUPS_PER_REQUEST);
  });
});

describe('parseToolLabelGroups', () => {
  it('drops malformed groups and calls without throwing', () => {
    expect(parseToolLabelGroups(null)).toEqual([]);
    expect(
      parseToolLabelGroups([
        { key: '', calls: [{ name: 'x' }] },
        { key: 'k', calls: 'no' },
        { key: 'k2', calls: [{ name: '' }, 3, { name: 'Read', input: { a: 1 } }] },
      ]),
    ).toEqual([{ key: 'k2', calls: [{ name: 'Read', input: { a: 1 } }] }]);
  });
});
