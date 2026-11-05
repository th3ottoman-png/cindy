/**
 * Context size of a Hermes turn, read from the turn's HERMES_HOME.
 *
 * Hermes's stream-json `result.tokens.input` is the sum of every API call's
 * prompt in the session (cache reads included), so it grows with every tool
 * call and every turn; it is not how full the context is. The only place
 * Hermes 0.22.5 records a single call's prompt size is `logs/agent.log`:
 *
 *   … INFO [<session>] agent.conversation_loop: API call #7: model=deepseek-v4-pro
 *   provider=deepseek in=24510 out=262 total=24772 … cache=17536/24510 (72%) …
 *
 * `in=` is the full prompt (cached part included). The model's window comes
 * from the models.dev cache Hermes keeps in the same home. Both are best
 * effort: any missing or unreadable piece yields null/undefined, never a throw.
 * Re-verify the log format on every Hermes upgrade (HANDOVER §Versions).
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';

import { parseHermesCustomProviders } from './hermes-config.js';

export interface HermesApiCallUsage {
  promptTokens: number;
  model?: string;
  provider?: string;
}

export interface HermesTurnContextUsage extends HermesApiCallUsage {
  contextWindow?: number;
}

/** Enough for many turns of call lines; the log itself can grow to megabytes. */
const LOG_TAIL_BYTES = 256 * 1024;
const API_CALL_MARKER = '] agent.conversation_loop: API call #';

function field(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(line);
  return match?.[1];
}

/** The session's last `API call #N` line in `logText`, or null. */
export function parseLastApiCall(logText: string, hermesSessionId: string): HermesApiCallUsage | null {
  if (!hermesSessionId) return null;
  const prefix = `[${hermesSessionId}${API_CALL_MARKER}`;
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const at = line.indexOf(prefix);
    if (at < 0) continue;
    const rest = line.slice(at + prefix.length);
    const promptTokens = Number(field(rest, 'in'));
    if (!Number.isFinite(promptTokens) || promptTokens < 0) return null;
    const model = field(rest, 'model');
    const provider = field(rest, 'provider');
    return {
      promptTokens,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `limit.context` of `<provider>.models.<model>` in a parsed models.dev cache. */
export function lookupModelsDevContextWindow(
  cache: unknown,
  provider: string,
  model: string,
): number | undefined {
  const entry = asRecord(asRecord(asRecord(asRecord(cache)?.[provider])?.models)?.[model]);
  const context = asRecord(entry?.limit)?.context;
  return typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : undefined;
}

function readTail(file: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// models_dev_cache.json is ~6 MB; parse it once per file version.
const modelsDevCache = new Map<string, { mtimeMs: number; size: number; data: unknown }>();

function readModelsDevCache(home: string): unknown {
  const file = nodePath.join(home, 'models_dev_cache.json');
  try {
    const stat = fs.statSync(file);
    const cached = modelsDevCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.data;
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    modelsDevCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    return data;
  } catch {
    return undefined;
  }
}

/**
 * Context length from custom_providers in config.yaml when models.dev does not describe the model/provider.
 */
export function lookupCustomProviderContextWindow(
  home: string,
  provider?: string,
  _model?: string,
): number | undefined {
  try {
    const configPath = nodePath.join(home, 'config.yaml');
    let configYaml: string | null = null;
    if (fs.existsSync(configPath)) {
      configYaml = fs.readFileSync(configPath, 'utf8');
    } else {
      const parentConfig = nodePath.join(home, '..', 'config.yaml');
      if (fs.existsSync(parentConfig)) {
        configYaml = fs.readFileSync(parentConfig, 'utf8');
      }
    }
    if (!configYaml) return undefined;
    const entries = parseHermesCustomProviders(configYaml);
    if (entries.length === 0) return undefined;

    if (provider && provider !== 'custom') {
      const match = entries.find((e) => e.name === provider);
      if (match?.contextLength) return match.contextLength;
    }
    if (entries[0]?.contextLength) {
      return entries[0].contextLength;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The last API call's prompt size for `hermesSessionId` in `home`, with the
 * model's window when models.dev or custom_providers in config.yaml knows it.
 * Synchronous on purpose: the daemon calls it while forwarding the `result` event,
 * so the context-usage event it builds lands before that result without reordering the stream.
 */
export function readTurnContextUsage(home: string, hermesSessionId: string): HermesTurnContextUsage | null {
  const tail = readTail(nodePath.join(home, 'logs', 'agent.log'), LOG_TAIL_BYTES);
  if (tail === null) return null;
  const call = parseLastApiCall(tail, hermesSessionId);
  if (!call) return null;
  const modelsDevWindow = call.provider && call.model
    ? lookupModelsDevContextWindow(readModelsDevCache(home), call.provider, call.model)
    : undefined;
  const contextWindow = modelsDevWindow ?? lookupCustomProviderContextWindow(home, call.provider, call.model);
  return { ...call, ...(contextWindow !== undefined ? { contextWindow } : {}) };
}

// ── Auto compression (ROADMAP 1.11, ADR 0010) ───────────────────────────────
//
// Hermes compresses a long context on its own, mid-turn, and only logs it:
//
//   … INFO agent.conversation_compression: context compression started: session=<id> messages=57 tokens=~56,110 …
//   … INFO agent.conversation_compression: context compression done: session=<id> messages=57->29 rough_tokens=~42,244 …
//
// Nothing reaches stream-json, so the daemon follows agent.log while a turn runs.

export interface HermesCompressionLine {
  phase: 'started' | 'done';
  /** `<session>@<log timestamp>`: stable across re-reads of the same line. */
  id: string;
  tokens: number;
}

export interface HermesCompressionEvent {
  phase: 'started' | 'done';
  id: string;
  /** Context size before compressing (from the `started` line). */
  preTokens?: number;
  /** Estimated size after (from the `done` line). */
  postTokens?: number;
}

const COMPRESSION_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3}) .*agent\.conversation_compression: context compression (started|done): session=(\S+) .*?(?:^|\s)(?:tokens|rough_tokens)=~?([\d,]+)/;

/**
 * One compression line, or null. With no `hermesSessionId` (a fresh session whose
 * id is not bound yet) any session matches: each Cindy session has its own home.
 */
export function parseCompressionLine(line: string, hermesSessionId?: string): HermesCompressionLine | null {
  const match = COMPRESSION_LINE.exec(line);
  if (!match) return null;
  const [, at, phase, session, rawTokens] = match;
  if (hermesSessionId && session !== hermesSessionId) return null;
  const tokens = Number(rawTokens.replace(/,/g, ''));
  if (!Number.isFinite(tokens)) return null;
  return { phase: phase as 'started' | 'done', id: `${session}@${at}`, tokens };
}

export interface CompressionWatcher {
  /** Compression events in lines appended since the last poll (or since creation). */
  poll(hermesSessionId?: string): HermesCompressionEvent[];
}

/**
 * Follows `<home>/logs/agent.log` from its size at creation. Best effort: a
 * missing or unreadable log yields no events, never a throw.
 */
export function createCompressionWatcher(home: string): CompressionWatcher {
  const file = nodePath.join(home, 'logs', 'agent.log');
  const sizeOf = (): number | null => {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  };
  let offset = sizeOf() ?? 0;
  let partial = '';
  let startedTokens: number | undefined;

  const readNew = (): string => {
    const size = sizeOf();
    if (size === null) return '';
    if (size < offset) {
      // Rotated or truncated: start over on the new file.
      offset = 0;
      partial = '';
    }
    if (size === offset) return '';
    let from = offset;
    if (size - from > LOG_TAIL_BYTES) {
      from = size - LOG_TAIL_BYTES;
      partial = '';
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      offset = size;
      return buffer.toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };

  return {
    poll(hermesSessionId?: string): HermesCompressionEvent[] {
      const text = partial + readNew();
      const end = text.lastIndexOf('\n');
      partial = end < 0 ? text : text.slice(end + 1);
      if (end < 0) return [];
      const events: HermesCompressionEvent[] = [];
      for (const line of text.slice(0, end).split('\n')) {
        const parsed = parseCompressionLine(line, hermesSessionId);
        if (!parsed) continue;
        if (parsed.phase === 'started') {
          startedTokens = parsed.tokens;
          events.push({ phase: 'started', id: parsed.id, preTokens: parsed.tokens });
        } else {
          events.push({
            phase: 'done',
            id: parsed.id,
            ...(startedTokens !== undefined ? { preTokens: startedTokens } : {}),
            postTokens: parsed.tokens,
          });
          startedTokens = undefined;
        }
      }
      return events;
    },
  };
}
