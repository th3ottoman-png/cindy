import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  lookupModelsDevContextWindow,
  parseLastApiCall,
  readTurnContextUsage,
} from '../hermes-context.js';

// Hermes 0.22.5 `agent.log` lines (format observed live 2026-11-02; ids synthetic).
const SID = 'local-aaaa';
const OTHER = 'local-bbbb';
const call = (sid: string, n: number, inTokens: number, model = 'deepseek-v4-pro', provider = 'deepseek'): string =>
  `2026-11-02 11:51:40,067 INFO [${sid}] agent.conversation_loop: API call #${n}: model=${model} provider=${provider} in=${inTokens} out=262 total=${inTokens + 262} latency=3.6s cache=17536/${inTokens} (72%) id=067cb43d`;
const turnLine = `2026-11-02 11:51:34,526 INFO [${SID}] agent.turn_context: conversation turn: session=${SID} model=deepseek-v4-pro provider=deepseek platform=cli history=11 msg='read in=99 please'`;

describe('parseLastApiCall', () => {
  it('returns the last API call of the session: its prompt size, model and provider', () => {
    const log = [turnLine, call(SID, 6, 17541), call(OTHER, 1, 99999), call(SID, 7, 24510), ''].join('\n');
    expect(parseLastApiCall(log, SID)).toEqual({
      promptTokens: 24510,
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
    });
  });

  it('ignores other sessions, non-call lines and a session id that is only a prefix', () => {
    const log = [turnLine, call(OTHER, 3, 500), call(`${SID}x`, 2, 700)].join('\n');
    expect(parseLastApiCall(log, SID)).toBeNull();
    expect(parseLastApiCall(log, OTHER)?.promptTokens).toBe(500);
  });

  it('returns null for an empty session id or a line without in=', () => {
    expect(parseLastApiCall(call(SID, 1, 10), '')).toBeNull();
    const noIn = `2026-11-02 11:51:40,067 INFO [${SID}] agent.conversation_loop: API call #1: model=m provider=p out=3`;
    expect(parseLastApiCall(noIn, SID)).toBeNull();
  });
});

describe('lookupModelsDevContextWindow', () => {
  const cache = {
    deepseek: { models: { 'deepseek-v4-pro': { limit: { context: 1_048_576, output: 393_216 } } } },
    zenmux: { models: { 'deepseek/deepseek-v4-pro': { limit: { context: 1_000_000 } } } },
  };

  it('finds the model under its provider', () => {
    expect(lookupModelsDevContextWindow(cache, 'deepseek', 'deepseek-v4-pro')).toBe(1_048_576);
  });

  it('returns undefined for an unknown provider, model or a malformed limit', () => {
    expect(lookupModelsDevContextWindow(cache, 'custom', 'deepseek-v4-pro')).toBeUndefined();
    expect(lookupModelsDevContextWindow(cache, 'deepseek', 'nope')).toBeUndefined();
    expect(lookupModelsDevContextWindow({ deepseek: { models: { m: { limit: { context: 'x' } } } } }, 'deepseek', 'm'))
      .toBeUndefined();
    expect(lookupModelsDevContextWindow(null, 'deepseek', 'm')).toBeUndefined();
  });
});

describe('readTurnContextUsage', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ctx-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads the prompt size from logs/agent.log and the window from models_dev_cache.json', () => {
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs', 'agent.log'), [call(SID, 1, 13468), call(SID, 2, 13571), ''].join('\n'));
    fs.writeFileSync(
      path.join(home, 'models_dev_cache.json'),
      JSON.stringify({ deepseek: { models: { 'deepseek-v4-pro': { limit: { context: 1_048_576 } } } } }),
    );
    expect(readTurnContextUsage(home, SID)).toEqual({
      promptTokens: 13571,
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      contextWindow: 1_048_576,
    });
  });

  it('only reads the tail of a large log', () => {
    fs.mkdirSync(path.join(home, 'logs'));
    const filler = `${'x'.repeat(200)}\n`.repeat(5_000); // ~1 MB of noise after the call line
    fs.writeFileSync(path.join(home, 'logs', 'agent.log'), `${call(SID, 1, 111)}\n${filler}`);
    expect(readTurnContextUsage(home, SID)).toBeNull();
    fs.appendFileSync(path.join(home, 'logs', 'agent.log'), `${call(SID, 2, 222)}\n`);
    expect(readTurnContextUsage(home, SID)?.promptTokens).toBe(222);
  });

  it('returns the prompt size without a window when the model is not in models.dev', () => {
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs', 'agent.log'), `${call(SID, 1, 5000, 'qwen3-8b', 'custom')}\n`);
    expect(readTurnContextUsage(home, SID)).toEqual({ promptTokens: 5000, model: 'qwen3-8b', provider: 'custom' });
  });

  it('returns null when the log is missing, without throwing', () => {
    expect(readTurnContextUsage(home, SID)).toBeNull();
    expect(readTurnContextUsage(path.join(home, 'missing'), SID)).toBeNull();
  });
});
