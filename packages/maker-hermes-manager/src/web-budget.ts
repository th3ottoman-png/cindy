/**
 * Web-search budget per session (ROADMAP 13.5).
 *
 * Hermes web tools run on a paid backend (`web.backend: nous`), and an API turn can loop on
 * search. The daemon already answers every `pre_tool_call` hook (auto-review-gate.ts); this
 * module counts the allowed web calls of each session there and, at the cap, answers *block*
 * with a reason the model can read and carry on from.
 *
 * - File `~/.cindy-harness/web-budget.yaml` (human-editable, optional):
 *   `max_searches_per_session` (default 50, 0 = unlimited and nothing new is installed) and
 *   `tool_names` (default `[web_search, web_extract]`, the names Hermes 0.23.0 emits).
 * - A web call can arrive directly (`web_search`) or inside Hermes's `tool_call` batch wrapper
 *   (`{ calls: [{ name, arguments }] }`). Both count once: when a wrapper is allowed, its inner
 *   web calls are remembered for a short while, so a hook that also fires for those inner calls
 *   does not count them a second time.
 * - Counts are reserved before the rest of the review runs and released when the call ends up
 *   blocked, so two parallel calls can never both take the last slot.
 * - State is in memory per daemon session id and resets on a new session, `/clear` (which
 *   closes the daemon record) or a daemon restart.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import type { AutoReviewHookPayload, AutoReviewVerdict } from './auto-review-gate.js';

export const DEFAULT_WEB_BUDGET_MAX = 50;
export const DEFAULT_WEB_TOOL_NAMES: readonly string[] = ['web_search', 'web_extract'];
/** Hermes's batch wrapper for lazily loaded tools (`{ calls: [{ name, arguments }] }`). */
export const HERMES_TOOL_CALL_WRAPPER = 'tool_call';
/** How long an allowed wrapper's inner web calls are remembered for de-duplication. */
export const WRAPPED_CALL_TTL_MS = 120_000;
/** Upper bound for the cap so a typo cannot turn into an unbounded number. */
export const MAX_WEB_BUDGET = 10_000;

export interface WebBudgetConfig {
  maxSearchesPerSession: number;
  toolNames: string[];
}

export interface WebBudgetLoad {
  config: WebBudgetConfig;
  /** Problems found in the file; each one fell back to the default for that key. */
  errors: string[];
  file: string;
  exists: boolean;
}

export function defaultWebBudgetConfig(): WebBudgetConfig {
  return { maxSearchesPerSession: DEFAULT_WEB_BUDGET_MAX, toolNames: [...DEFAULT_WEB_TOOL_NAMES] };
}

export function defaultWebBudgetFile(): string {
  return nodePath.join(os.homedir(), '.cindy-harness', 'web-budget.yaml');
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

function parseToolList(items: string[], errors: string[]): string[] | null {
  const names = items.map(unquote).filter((name) => name.length > 0);
  const bad = names.filter((name) => !TOOL_NAME.test(name));
  if (bad.length > 0) {
    errors.push(`tool_names: invalid tool name(s) ${bad.map((b) => JSON.stringify(b)).join(', ')}; using the default list`);
    return null;
  }
  if (names.length === 0) {
    errors.push('tool_names: the list is empty; using the default list');
    return null;
  }
  return [...new Set(names)];
}

/**
 * Narrow reader for the two documented keys (the guardrails.yaml approach: no YAML dependency
 * for one small file). Unknown keys and unreadable values are listed in `errors` and the
 * default for that key is used, so a broken file never turns the budget off.
 */
export function parseWebBudgetYaml(text: string): { config: WebBudgetConfig; errors: string[] } {
  const config = defaultWebBudgetConfig();
  const errors: string[] = [];
  let listFor: 'tool_names' | null = null;
  let listItems: string[] = [];
  const flushList = (): void => {
    if (listFor === 'tool_names') {
      const names = parseToolList(listItems, errors);
      if (names) config.toolNames = names;
    }
    listFor = null;
    listItems = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const body = line.trim();
    if (listFor && indented && body.startsWith('-')) {
      listItems.push(body.slice(1).trim());
      continue;
    }
    if (indented) {
      errors.push(`unexpected indented line: ${JSON.stringify(body)}`);
      continue;
    }
    flushList();
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(body);
    if (!kv) {
      errors.push(`unreadable line: ${JSON.stringify(body)}`);
      continue;
    }
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === 'max_searches_per_session') {
      const n = Number(unquote(value));
      if (!/^\d+$/.test(unquote(value)) || !Number.isSafeInteger(n) || n > MAX_WEB_BUDGET) {
        errors.push(
          `max_searches_per_session: ${JSON.stringify(value)} is not a whole number from 0 to ${MAX_WEB_BUDGET}; using ${DEFAULT_WEB_BUDGET_MAX}`,
        );
      } else {
        config.maxSearchesPerSession = n;
      }
    } else if (key === 'tool_names') {
      if (!value) {
        listFor = 'tool_names';
      } else if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        const names = parseToolList(inner ? inner.split(',') : [], errors);
        if (names) config.toolNames = names;
      } else {
        errors.push('tool_names: expected a list; using the default list');
      }
    } else {
      errors.push(`unknown key ${JSON.stringify(key)} (ignored)`);
    }
  }
  flushList();
  return { config, errors };
}

/** Never throws: a missing file gives the defaults, an unreadable one lists the error. */
export async function loadWebBudgetConfig(file: string = defaultWebBudgetFile()): Promise<WebBudgetLoad> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      config: defaultWebBudgetConfig(),
      errors: code === 'ENOENT' ? [] : [`could not read the file (${code ?? 'error'}); using the defaults`],
      file,
      exists: code !== 'ENOENT',
    };
  }
  const parsed = parseWebBudgetYaml(text);
  return { ...parsed, file, exists: true };
}

/** Re-reads the owner's file at most every `ttlMs`, so a hand edit applies within seconds. */
export function cachedWebBudgetLoader(
  file: string = defaultWebBudgetFile(),
  ttlMs = 2_000,
  now: () => number = Date.now,
): () => Promise<WebBudgetLoad> {
  let cache: { at: number; load: WebBudgetLoad } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.load;
    const load = await loadWebBudgetConfig(file);
    cache = { at: now(), load };
    return load;
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface WebCall {
  name: string;
  /** Name + stable arguments: the same search always has the same key. */
  key: string;
  /** True when the call came inside a `tool_call` wrapper. */
  wrapped: boolean;
}

/** The web calls one hook payload would run, direct or inside the `tool_call` wrapper. */
export function webCallsIn(payload: Pick<AutoReviewHookPayload, 'toolName' | 'toolInput'>, toolNames: readonly string[]): WebCall[] {
  const names = new Set(toolNames);
  if (names.has(payload.toolName)) {
    return [{ name: payload.toolName, key: `${payload.toolName}\u0000${stableJson(payload.toolInput ?? {})}`, wrapped: false }];
  }
  if (payload.toolName !== HERMES_TOOL_CALL_WRAPPER) return [];
  const input = payload.toolInput;
  const calls = input && typeof input === 'object' && !Array.isArray(input) ? (input as { calls?: unknown }).calls : undefined;
  if (!Array.isArray(calls)) return [];
  const out: WebCall[] = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const c = call as { name?: unknown; arguments?: unknown };
    if (typeof c.name !== 'string' || !names.has(c.name)) continue;
    out.push({ name: c.name, key: `${c.name}\u0000${stableJson(c.arguments ?? {})}`, wrapped: true });
  }
  return out;
}

export function webBudgetReason(used: number, max: number): string {
  return (
    `web-search budget reached (${used}/${max}) — this call did not run. `
    + 'Answer with what you already found; the owner can raise the cap in '
    + '~/.cindy-harness/web-budget.yaml or start a new session.'
  );
}

export interface WebBudgetSnapshot {
  used: number;
  max: number;
  toolNames: string[];
  errors: string[];
  file: string;
}

interface SessionState {
  used: number;
  /** Inner web calls of allowed wrappers: key → expiry times (one per remembered call). */
  wrapped: Map<string, number[]>;
}

export interface WebBudgetOptions {
  load: () => Promise<WebBudgetLoad>;
  now?: () => number;
  wrappedTtlMs?: number;
}

export class WebBudget {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly wrappedTtlMs: number;

  constructor(private readonly opts: WebBudgetOptions) {
    this.now = opts.now ?? Date.now;
    this.wrappedTtlMs = opts.wrappedTtlMs ?? WRAPPED_CALL_TTL_MS;
  }

  load(): Promise<WebBudgetLoad> {
    return this.opts.load();
  }

  /** True when a cap is set, i.e. the daemon must install its hook for the budget's sake. */
  async armed(): Promise<boolean> {
    return (await this.opts.load()).config.maxSearchesPerSession > 0;
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { used: 0, wrapped: new Map() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Consumes a remembered inner call of an allowed wrapper; true when one was there. */
  private takeWrapped(s: SessionState, key: string): boolean {
    const list = s.wrapped.get(key);
    if (!list) return false;
    const now = this.now();
    const live = list.filter((until) => until > now);
    const hit = live.length > 0;
    if (hit) live.shift();
    if (live.length > 0) s.wrapped.set(key, live);
    else s.wrapped.delete(key);
    return hit;
  }

  private remember(s: SessionState, key: string): void {
    const list = s.wrapped.get(key) ?? [];
    list.push(this.now() + this.wrappedTtlMs);
    s.wrapped.set(key, list);
  }

  /**
   * Runs `next` (the rest of the review) unless the call would exceed the cap. Non-web calls,
   * and every call while the cap is 0, pass straight through and are never counted.
   */
  async review(
    sessionId: string,
    payload: Pick<AutoReviewHookPayload, 'toolName' | 'toolInput'>,
    next: () => Promise<AutoReviewVerdict>,
  ): Promise<AutoReviewVerdict> {
    const { config } = await this.opts.load();
    const max = config.maxSearchesPerSession;
    if (max <= 0) return next();
    const calls = webCallsIn(payload, config.toolNames);
    if (calls.length === 0) return next();
    const s = this.state(sessionId);
    const fresh = calls.filter((call) => call.wrapped || !this.takeWrapped(s, call.key));
    const cost = fresh.length;
    if (cost === 0) return next();
    if (s.used + cost > max) {
      return { decision: 'block', reason: webBudgetReason(s.used, max) };
    }
    s.used += cost;
    let verdict: AutoReviewVerdict;
    try {
      verdict = await next();
    } catch (error) {
      s.used -= cost;
      throw error;
    }
    if (verdict.decision !== 'allow') {
      s.used -= cost;
      return verdict;
    }
    for (const call of fresh) if (call.wrapped) this.remember(s, call.key);
    return verdict;
  }

  async snapshot(sessionId: string): Promise<WebBudgetSnapshot> {
    const load = await this.opts.load();
    return {
      used: this.sessions.get(sessionId)?.used ?? 0,
      max: load.config.maxSearchesPerSession,
      toolNames: [...load.config.toolNames],
      errors: [...load.errors],
      file: load.file,
    };
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
