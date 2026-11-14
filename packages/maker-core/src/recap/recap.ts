/**
 * "Where you left off" recap (ROADMAP 13.3, blueprint §5).
 *
 * Pure by design: no I/O beyond the config file helpers, no clock, no Electron, no network.
 * The desktop host decides when to ask and calls the routed `recap` model; this module owns
 * the trigger decision, the prompt bounds and the config shape.
 *
 * Not routed = off. Nothing here ever falls back to the chat model (AGENTS.md §6.3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_RECAP_AWAY_MINUTES = 15;
export const MIN_RECAP_AWAY_MINUTES = 1;
export const MAX_RECAP_AWAY_MINUTES = 24 * 60;

/** A recap is noise in a short conversation; the blueprint sets the floor at 4 turns. */
export const RECAP_MIN_TURNS = 4;

/** About 6 k tokens of transcript, the blueprint's bound. Characters, not tokens, so it is testable. */
export const RECAP_PROMPT_CHAR_BUDGET = 24_000;

/** One recap per away period, and never a long wait on a background call. */
export const RECAP_TIMEOUT_MS = 15_000;

export interface RecapConfig {
  enabled: boolean;
  awayMinutes: number;
}

export const DEFAULT_RECAP_CONFIG: RecapConfig = {
  enabled: true,
  awayMinutes: DEFAULT_RECAP_AWAY_MINUTES,
};

export function normalizeAwayMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RECAP_AWAY_MINUTES;
  const floored = Math.floor(value);
  if (floored < MIN_RECAP_AWAY_MINUTES) return MIN_RECAP_AWAY_MINUTES;
  if (floored > MAX_RECAP_AWAY_MINUTES) return MAX_RECAP_AWAY_MINUTES;
  return floored;
}

export function readRecapConfig(file: string): { config: RecapConfig; issue?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { config: { ...DEFAULT_RECAP_CONFIG } };
    return { config: { ...DEFAULT_RECAP_CONFIG }, issue: 'recap.json is not readable JSON; defaults used' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: { ...DEFAULT_RECAP_CONFIG }, issue: 'recap.json is not an object; defaults used' };
  }
  const r = raw as Record<string, unknown>;
  const config: RecapConfig = {
    // Only an explicit false turns it off; a missing field keeps the default-on behaviour.
    enabled: r.enabled !== false,
    awayMinutes: normalizeAwayMinutes(r.awayMinutes),
  };
  const issue = r.awayMinutes !== undefined && normalizeAwayMinutes(r.awayMinutes) !== r.awayMinutes
    ? `awayMinutes ${String(r.awayMinutes)} is outside ${MIN_RECAP_AWAY_MINUTES}-${MAX_RECAP_AWAY_MINUTES}; clamped`
    : undefined;
  return issue ? { config, issue } : { config };
}

/** Atomic write: a temp file beside the target, then rename (AGENTS.md §4). */
export function writeRecapConfig(file: string, next: Partial<RecapConfig>): RecapConfig {
  const current = readRecapConfig(file).config;
  const config: RecapConfig = {
    enabled: typeof next.enabled === 'boolean' ? next.enabled : current.enabled,
    awayMinutes: next.awayMinutes === undefined ? current.awayMinutes : normalizeAwayMinutes(next.awayMinutes),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return config;
}

export interface RecapTriggerInput {
  enabled: boolean;
  /** When the owner last focused this session; null when it has never been focused. */
  lastFocusAt: number | null;
  now: number;
  awayMinutes: number;
  /** User turns in the conversation. */
  turnCount: number;
  /** turnCount at the last recap; null when there has never been one. */
  lastRecapTurn: number | null;
  running: boolean;
}

export type RecapReason =
  | 'ok'
  | 'disabled'
  | 'running'
  | 'never-focused'
  | 'too-few-turns'
  | 'no-new-turns'
  | 'not-away-long-enough';

/**
 * One decision, in a fixed order, so the reason is always the first rule that failed. At most
 * one recap per away period: `lastRecapTurn` must be behind the current turn count.
 */
export function shouldRecap(input: RecapTriggerInput): { recap: boolean; reason: RecapReason } {
  if (!input.enabled) return { recap: false, reason: 'disabled' };
  if (input.running) return { recap: false, reason: 'running' };
  if (input.turnCount < RECAP_MIN_TURNS) return { recap: false, reason: 'too-few-turns' };
  if (input.lastRecapTurn !== null && input.turnCount <= input.lastRecapTurn) {
    return { recap: false, reason: 'no-new-turns' };
  }
  if (input.lastFocusAt === null) return { recap: false, reason: 'never-focused' };
  const awayMs = normalizeAwayMinutes(input.awayMinutes) * 60_000;
  if (input.now - input.lastFocusAt < awayMs) return { recap: false, reason: 'not-away-long-enough' };
  return { recap: true, reason: 'ok' };
}

export interface RecapTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Newest turns first within the budget: a recap is about where the conversation stands NOW,
 * so when the transcript is too long the oldest turns are dropped, never the newest.
 */
export function buildRecapPrompt(turns: readonly RecapTurn[], openGoal?: string | null): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    const text = turn.text.trim();
    if (!text) continue;
    const line = `${turn.role === 'user' ? 'Owner' : 'Assistant'}: ${text}`;
    if (used + line.length + 1 > RECAP_PROMPT_CHAR_BUDGET) {
      // A single turn larger than the whole budget is truncated, not skipped: it is the
      // most recent thing that happened and dropping it would misreport the state.
      if (kept.length === 0) kept.push(line.slice(0, RECAP_PROMPT_CHAR_BUDGET));
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  kept.reverse();
  const goal = openGoal?.trim();
  const header = goal ? `Open goal: ${goal}\n\n` : '';
  return `${header}Recent conversation:\n${kept.join('\n')}`;
}

/** New prompt text for a new feature only; no existing agent's prompt is edited (AGENTS.md §3). */
export const RECAP_SYSTEM_PROMPT = [
  'You remind the owner where a conversation left off.',
  'Reply with ONE or TWO sentences: the current state, then the next step.',
  'No preamble, no heading, no bullet list, no quotes around the answer.',
  'Use only what the transcript supports. If the next step is unclear, say what is unresolved.',
].join(' ');