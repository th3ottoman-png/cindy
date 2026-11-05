import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCompressionWatcher,
  lookupModelsDevContextWindow,
  parseCompressionLine,
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

  it('returns the prompt size without a window when the model is not in models.dev and no custom provider exists', () => {
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs', 'agent.log'), `${call(SID, 1, 5000, 'qwen3-8b', 'custom')}\n`);
    expect(readTurnContextUsage(home, SID)).toEqual({ promptTokens: 5000, model: 'qwen3-8b', provider: 'custom' });
  });

  it('resolves context window from config.yaml custom_providers when model is outside models.dev', () => {
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs', 'agent.log'), `${call(SID, 1, 5000, 'qwen3-8b', 'custom')}\n`);
    fs.writeFileSync(
      path.join(home, 'config.yaml'),
      `custom_providers:
  - name: lmstudio-local
    base_url: http://127.0.0.1:1234/v1
    context_length: 65536
`,
    );
    expect(readTurnContextUsage(home, SID)).toEqual({
      promptTokens: 5000,
      model: 'qwen3-8b',
      provider: 'custom',
      contextWindow: 65536,
    });
  });

  it('matches custom provider by specific provider name in custom_providers', () => {
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs', 'agent.log'), `${call(SID, 1, 4200, 'llama-3', 'ollama-local')}\n`);
    fs.writeFileSync(
      path.join(home, 'config.yaml'),
      `custom_providers:
  - name: lmstudio-local
    base_url: http://127.0.0.1:1234/v1
    context_length: 32768
  - name: ollama-local
    base_url: http://127.0.0.1:11434/v1
    context_length: 131072
`,
    );
    expect(readTurnContextUsage(home, SID)).toEqual({
      promptTokens: 4200,
      model: 'llama-3',
      provider: 'ollama-local',
      contextWindow: 131072,
    });
  });

  it('returns null when the log is missing, without throwing', () => {
    expect(readTurnContextUsage(home, SID)).toBeNull();
    expect(readTurnContextUsage(path.join(home, 'missing'), SID)).toBeNull();
  });
});

// Hermes 0.22.5 compression lines (format observed live 2026-11-03 in a Cindy session home).
const started = (sid: string, at: string, tokens: string): string =>
  `2026-11-03 ${at} INFO agent.conversation_compression: context compression started: session=${sid} messages=57 tokens=~${tokens} model=deepseek-flash focus=None`;
const done = (sid: string, at: string, tokens: string): string =>
  `2026-11-03 ${at} INFO agent.conversation_compression: context compression done: session=${sid} messages=79->29 rough_tokens=~${tokens} awaiting_real_usage=true`;

describe('parseCompressionLine (ROADMAP 1.11)', () => {
  it('reads the phase, a stable id and the token count of a compression line', () => {
    expect(parseCompressionLine(started(SID, '09:35:56,138', '57,437'), SID))
      .toEqual({ phase: 'started', id: `${SID}@2026-11-03 09:35:56,138`, tokens: 57437 });
    expect(parseCompressionLine(done(SID, '09:36:36,350', '35,694'), SID))
      .toEqual({ phase: 'done', id: `${SID}@2026-11-03 09:36:36,350`, tokens: 35694 });
  });

  it('ignores other sessions, a prefix id, telemetry and refusal lines', () => {
    expect(parseCompressionLine(started(OTHER, '09:35:56,138', '57,437'), SID)).toBeNull();
    expect(parseCompressionLine(done(`${SID}x`, '09:36:36,350', '35,694'), SID)).toBeNull();
    expect(parseCompressionLine('2026-11-03 12:53:23,171 INFO agent.conversation_compression: context compression attempt telemetry: {"commit_status":"aborted"}', SID)).toBeNull();
    expect(parseCompressionLine(`2026-11-03 12:53:23,170 WARNING agent.conversation_compression: Compression refused: compressed transcript would be larger than the original (session=${SID}, ~73,940 -> ~74,293 tokens)`, SID)).toBeNull();
  });

  it('accepts any session while the Hermes session id is not known yet (fresh session)', () => {
    expect(parseCompressionLine(done(OTHER, '09:36:36,350', '1,000'))?.tokens).toBe(1000);
  });
});

describe('createCompressionWatcher (ROADMAP 1.11)', () => {
  let home = '';
  let log = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cmp-'));
    fs.mkdirSync(path.join(home, 'logs'));
    log = path.join(home, 'logs', 'agent.log');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports only lines written after it was created, and pairs done with its started size', () => {
    fs.writeFileSync(log, `${started(SID, '09:00:00,000', '50,000')}\n${done(SID, '09:00:10,000', '20,000')}\n`);
    const watcher = createCompressionWatcher(home);
    expect(watcher.poll(SID)).toEqual([]);
    fs.appendFileSync(log, `${call(SID, 1, 56000)}\n${started(SID, '09:32:02,349', '56,110')}\n`);
    expect(watcher.poll(SID)).toEqual([
      { phase: 'started', id: `${SID}@2026-11-03 09:32:02,349`, preTokens: 56110 },
    ]);
    fs.appendFileSync(log, `${done(SID, '09:32:22,636', '42,244')}\n`);
    expect(watcher.poll(SID)).toEqual([
      { phase: 'done', id: `${SID}@2026-11-03 09:32:22,636`, preTokens: 56110, postTokens: 42244 },
    ]);
    expect(watcher.poll(SID)).toEqual([]);
  });

  it('waits for a line to be complete before reading it', () => {
    const watcher = createCompressionWatcher(home);
    const line = done(SID, '09:36:36,350', '35,694');
    fs.appendFileSync(log, line.slice(0, 40));
    expect(watcher.poll(SID)).toEqual([]);
    fs.appendFileSync(log, `${line.slice(40)}\n`);
    expect(watcher.poll(SID)).toEqual([
      { phase: 'done', id: `${SID}@2026-11-03 09:36:36,350`, postTokens: 35694 },
    ]);
  });

  it('starts from an empty log when the file appears later, and never throws on a missing home', () => {
    const watcher = createCompressionWatcher(home);
    fs.writeFileSync(log, `${started(SID, '10:00:00,000', '9,000')}\n`);
    expect(watcher.poll(SID)).toHaveLength(1);
    expect(createCompressionWatcher(path.join(home, 'missing')).poll(SID)).toEqual([]);
  });
});
