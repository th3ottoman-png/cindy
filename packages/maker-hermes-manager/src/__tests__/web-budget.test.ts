import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AutoReviewVerdict } from '../auto-review-gate.js';
import {
  DEFAULT_WEB_BUDGET_MAX,
  DEFAULT_WEB_TOOL_NAMES,
  WebBudget,
  cachedWebBudgetLoader,
  loadWebBudgetConfig,
  parseWebBudgetYaml,
  webBudgetReason,
  webCallsIn,
  type WebBudgetLoad,
} from '../web-budget.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpFile(name: string, body?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  if (body !== undefined) fs.writeFileSync(file, body);
  return file;
}

function fixed(max: number, toolNames: string[] = [...DEFAULT_WEB_TOOL_NAMES]): () => Promise<WebBudgetLoad> {
  return async () => ({ config: { maxSearchesPerSession: max, toolNames }, errors: [], file: '/f', exists: true });
}
const allow = async (): Promise<AutoReviewVerdict> => ({ decision: 'allow' });
const search = (q: string) => ({ toolName: 'web_search', toolInput: { query: q } });

describe('web-budget.yaml parsing (ROADMAP 13.5)', () => {
  it('missing file → defaults, no errors', async () => {
    const load = await loadWebBudgetConfig(tmpFile('web-budget.yaml'));
    expect(load.exists).toBe(false);
    expect(load.errors).toEqual([]);
    expect(load.config).toEqual({ maxSearchesPerSession: DEFAULT_WEB_BUDGET_MAX, toolNames: ['web_search', 'web_extract'] });
  });

  it('reads the cap and a block or flow tool list, with comments', () => {
    expect(parseWebBudgetYaml('max_searches_per_session: 2 # tight\ntool_names:\n  - web_search\n  - "web_extract"\n'))
      .toEqual({ config: { maxSearchesPerSession: 2, toolNames: ['web_search', 'web_extract'] }, errors: [] });
    expect(parseWebBudgetYaml('tool_names: [web_search]\nmax_searches_per_session: 0\n').config)
      .toEqual({ maxSearchesPerSession: 0, toolNames: ['web_search'] });
  });

  it('invalid values are listed and the default for that key is used', () => {
    const out = parseWebBudgetYaml('max_searches_per_session: -3\ntool_names: web_search\ncolour: blue\n');
    expect(out.config).toEqual({ maxSearchesPerSession: 50, toolNames: ['web_search', 'web_extract'] });
    expect(out.errors).toHaveLength(3);
    expect(out.errors.join('\n')).toMatch(/max_searches_per_session/);
    expect(out.errors.join('\n')).toMatch(/expected a list/);
    expect(out.errors.join('\n')).toMatch(/unknown key "colour"/);
    expect(parseWebBudgetYaml('max_searches_per_session: 2.5\n').errors).toHaveLength(1);
    expect(parseWebBudgetYaml('max_searches_per_session: 99999\n').config.maxSearchesPerSession).toBe(50);
    expect(parseWebBudgetYaml('tool_names:\n  - "bad name"\n').config.toolNames).toEqual(['web_search', 'web_extract']);
  });

  it('a file edit applies after the cache window', async () => {
    const file = tmpFile('web-budget.yaml', 'max_searches_per_session: 3\n');
    let t = 0;
    const load = cachedWebBudgetLoader(file, 2_000, () => t);
    expect((await load()).config.maxSearchesPerSession).toBe(3);
    fs.writeFileSync(file, 'max_searches_per_session: 7\n');
    t = 1_000;
    expect((await load()).config.maxSearchesPerSession).toBe(3);
    t = 2_500;
    expect((await load()).config.maxSearchesPerSession).toBe(7);
  });
});

describe('web calls in a hook payload', () => {
  it('direct web tools count, other tools do not', () => {
    expect(webCallsIn(search('a'), DEFAULT_WEB_TOOL_NAMES)).toHaveLength(1);
    expect(webCallsIn({ toolName: 'web_extract', toolInput: { urls: ['x'] } }, DEFAULT_WEB_TOOL_NAMES)).toHaveLength(1);
    expect(webCallsIn({ toolName: 'terminal', toolInput: { command: 'curl x' } }, DEFAULT_WEB_TOOL_NAMES)).toEqual([]);
  });

  it('reads web calls inside the tool_call batch wrapper and ignores the rest', () => {
    const calls = webCallsIn(
      {
        toolName: 'tool_call',
        toolInput: {
          calls: [
            { name: 'web_search', arguments: { query: 'a' } },
            { name: 'send_to_lead', arguments: { message: 'x' } },
            { name: 'web_extract', arguments: { urls: ['u'] } },
          ],
        },
      },
      DEFAULT_WEB_TOOL_NAMES,
    );
    expect(calls.map((c) => [c.name, c.wrapped])).toEqual([['web_search', true], ['web_extract', true]]);
    expect(webCallsIn({ toolName: 'tool_call', toolInput: { calls: 'nope' } }, DEFAULT_WEB_TOOL_NAMES)).toEqual([]);
  });
});

describe('WebBudget decisions', () => {
  it('allows below the cap and blocks at it with the reason, without running the rest of the review', async () => {
    const budget = new WebBudget({ load: fixed(2) });
    let reviewed = 0;
    const next = async (): Promise<AutoReviewVerdict> => {
      reviewed += 1;
      return { decision: 'allow' };
    };
    expect(await budget.review('s', search('a'), next)).toEqual({ decision: 'allow' });
    expect(await budget.review('s', search('b'), next)).toEqual({ decision: 'allow' });
    const third = await budget.review('s', search('c'), next);
    expect(third).toEqual({ decision: 'block', reason: webBudgetReason(2, 2) });
    expect(third.reason).toContain('web-search budget reached (2/2)');
    expect(reviewed).toBe(2);
    expect((await budget.snapshot('s')).used).toBe(2);
  });

  it('never counts non-web tools, and 0 means unlimited', async () => {
    const capped = new WebBudget({ load: fixed(1) });
    for (let i = 0; i < 5; i++) {
      expect((await capped.review('s', { toolName: 'terminal', toolInput: { command: `ls ${i}` } }, allow)).decision).toBe('allow');
    }
    expect((await capped.snapshot('s')).used).toBe(0);
    const unlimited = new WebBudget({ load: fixed(0) });
    for (let i = 0; i < 60; i++) expect((await unlimited.review('s', search(`q${i}`), allow)).decision).toBe('allow');
    expect((await unlimited.snapshot('s')).used).toBe(0);
    expect(await unlimited.armed()).toBe(false);
    expect(await capped.armed()).toBe(true);
  });

  it('counts per session and resets', async () => {
    const budget = new WebBudget({ load: fixed(1) });
    expect((await budget.review('a', search('x'), allow)).decision).toBe('allow');
    expect((await budget.review('b', search('x'), allow)).decision).toBe('allow');
    expect((await budget.review('a', search('y'), allow)).decision).toBe('block');
    budget.reset('a');
    expect((await budget.review('a', search('y'), allow)).decision).toBe('allow');
  });

  it('a call the rest of the review blocks (or that throws) does not use up the budget', async () => {
    const budget = new WebBudget({ load: fixed(1) });
    expect((await budget.review('s', search('a'), async () => ({ decision: 'block', reason: 'owner said no' }))).reason)
      .toBe('owner said no');
    await expect(budget.review('s', search('a'), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await budget.snapshot('s')).used).toBe(0);
    expect((await budget.review('s', search('a'), allow)).decision).toBe('allow');
  });

  it('two parallel calls cannot both take the last slot', async () => {
    const budget = new WebBudget({ load: fixed(1) });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = budget.review('s', search('a'), async () => { await gate; return { decision: 'allow' }; });
    const second = await budget.review('s', search('b'), allow);
    release();
    expect((await slow).decision).toBe('allow');
    expect(second.decision).toBe('block');
  });

  it('a wrapper counts its inner web calls once, even if the hook also fires for each inner call', async () => {
    let t = 0;
    const budget = new WebBudget({ load: fixed(2), now: () => t, wrappedTtlMs: 1_000 });
    const wrapper = {
      toolName: 'tool_call',
      toolInput: { calls: [{ name: 'web_search', arguments: { query: 'a' } }, { name: 'web_search', arguments: { query: 'b' } }] },
    };
    expect((await budget.review('s', wrapper, allow)).decision).toBe('allow');
    expect((await budget.snapshot('s')).used).toBe(2);
    // The same two calls arriving on their own are the wrapper's inner calls: not counted again.
    expect((await budget.review('s', search('a'), allow)).decision).toBe('allow');
    expect((await budget.review('s', search('b'), allow)).decision).toBe('allow');
    expect((await budget.snapshot('s')).used).toBe(2);
    // A third, different search is over the cap.
    expect((await budget.review('s', search('c'), allow)).decision).toBe('block');
    // An identical repeat long after the wrapper is a new search, and over the cap.
    t = 5_000;
    expect((await budget.review('s', search('a'), allow)).decision).toBe('block');
  });

  it('a wrapper that would exceed the cap is blocked whole', async () => {
    const budget = new WebBudget({ load: fixed(1) });
    const wrapper = {
      toolName: 'tool_call',
      toolInput: { calls: [{ name: 'web_search', arguments: { query: 'a' } }, { name: 'web_extract', arguments: { urls: ['u'] } }] },
    };
    expect((await budget.review('s', wrapper, allow)).reason).toContain('(0/1)');
    expect((await budget.snapshot('s')).used).toBe(0);
  });

  it('snapshot reports the cap, tool names, file and errors of the current file', async () => {
    const file = tmpFile('web-budget.yaml', 'max_searches_per_session: nope\n');
    const budget = new WebBudget({ load: () => loadWebBudgetConfig(file) });
    const snap = await budget.snapshot('s');
    expect(snap).toMatchObject({ used: 0, max: 50, toolNames: ['web_search', 'web_extract'], file });
    expect(snap.errors).toHaveLength(1);
  });
});
