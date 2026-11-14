/**
 * Tool-batch labels (ROADMAP 13.4, blueprint §6).
 *
 * Pure by design: no I/O beyond the cache-file helpers, no clock, no Electron, no network.
 * The desktop host decides when to ask and calls the routed `tool-label` model; this module
 * owns the digest bounds (with secrets redacted), the reply contract and the per-session cache.
 *
 * Not routed = off. Nothing here ever falls back to the chat model (AGENTS.md §6.3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactSensitiveText } from '../privacy/screen-redaction.js';

/** The blueprint's label bound. */
export const TOOL_LABEL_MAX_WORDS = 6;
/** A label is a header, not a sentence: also cap the characters. */
export const TOOL_LABEL_MAX_CHARS = 60;
/** About 1.5 k tokens of digest, the blueprint's bound. Characters, so it is testable. */
export const TOOL_LABEL_DIGEST_CHAR_BUDGET = 6_000;
/** The first argument of each call is truncated to this many characters. */
export const TOOL_LABEL_ARG_CHARS = 160;
export const TOOL_LABEL_TIMEOUT_MS = 20_000;

export interface ToolLabelCall {
  name: string;
  input: unknown;
}

/** Keys that usually carry what a call was about, tried in this order before any other key. */
const PREFERRED_ARG_KEYS = [
  'command', 'cmd', 'file_path', 'path', 'filePath', 'pattern', 'query', 'url', 'description',
  'prompt', 'name', 'target',
] as const;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The first meaningful argument of a tool call, as one line. Never throws. */
export function firstToolArgument(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return oneLine(input);
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return input.length > 0 ? firstToolArgument(input[0]) : '';
  if (typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of PREFERRED_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  try {
    return oneLine(JSON.stringify(record) ?? '');
  } catch {
    return '';
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One line per call (`3. Bash: pnpm test`), first argument only, truncated, then redacted with
 * the same engine as screen-share mode (7.7), so keys, tokens, emails and home paths never leave
 * the machine in a label request. Calls past the budget are counted, not sent.
 */
export function buildToolLabelDigest(calls: readonly ToolLabelCall[]): string {
  const header = `Tool calls (${calls.length}):`;
  const lines: string[] = [];
  let used = header.length + 1;
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const name = oneLine(String(call.name ?? '')) || 'tool';
    const arg = truncate(firstToolArgument(call.input), TOOL_LABEL_ARG_CHARS);
    const line = redactSensitiveText(`${i + 1}. ${name}${arg ? `: ${arg}` : ''}`, { maskStyle: 'redacted' });
    // Reserve room for the "more" line so the digest never exceeds the budget.
    if (used + line.length + 1 + 40 > TOOL_LABEL_DIGEST_CHAR_BUDGET) {
      lines.push(`… and ${calls.length - i} more tool calls`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [header, ...lines].join('\n');
}

/**
 * Fail-closed reply contract: one short line of at most 6 words and 60 characters. Prose,
 * fences, JSON or an over-long answer give null, and the header keeps its generic text.
 */
export function parseToolLabel(reply: string): string | null {
  if (typeof reply !== 'string') return null;
  if (reply.includes('```') || reply.includes('{')) return null;
  const firstLine = reply.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const label = oneLine(
    firstLine
      .replace(/^label\s*:\s*/i, '')
      .replace(/^["'`“”‘’*_]+|["'`“”‘’*_]+$/g, '')
      .replace(/[.。!]+$/, ''),
  );
  if (!label) return null;
  const words = label.split(' ').filter(Boolean);
  if (words.length > TOOL_LABEL_MAX_WORDS) return null;
  if (label.length > TOOL_LABEL_MAX_CHARS) return null;
  return label;
}

/** `Updated auth tests · 7 tools` — the count always stays as the suffix. */
export function formatToolLabelHeader(label: string, toolCount: number): string {
  const n = Math.max(0, Math.floor(toolCount));
  return `${label} · ${n} ${n === 1 ? 'tool' : 'tools'}`;
}

export interface ToolLabelEntry {
  label: string;
  toolCount: number;
  routeName: string;
  model: string;
  provider: string;
  createdAt: number;
}

export interface ToolLabelCache {
  version: 1;
  /** Keyed by the group's first tool call (its tool_use id when known). */
  labels: Record<string, ToolLabelEntry>;
}

/** A session id becomes a file name; anything outside a safe set is replaced. */
export function toolLabelCacheFile(dir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  if (!safe) throw new Error('tool-label cache needs a session id');
  return path.join(dir, `${safe}.json`);
}

function isEntry(value: unknown): value is ToolLabelEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.label === 'string' && v.label.length > 0
    && typeof v.toolCount === 'number'
    && typeof v.routeName === 'string'
    && typeof v.model === 'string'
    && typeof v.provider === 'string'
    && typeof v.createdAt === 'number';
}

/** Missing or unreadable cache = no labels; one bad entry never hides the others. */
export function readToolLabelCache(file: string): ToolLabelCache {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, labels: {} };
  }
  const labels: Record<string, ToolLabelEntry> = {};
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).labels
    : undefined;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (isEntry(value)) labels[key] = value;
    }
  }
  return { version: 1, labels };
}

/** Read-modify-write with an atomic rename (AGENTS.md §4). Returns the new cache. */
export function writeToolLabelEntry(file: string, key: string, entry: ToolLabelEntry): ToolLabelCache {
  const cache = readToolLabelCache(file);
  const next: ToolLabelCache = { version: 1, labels: { ...cache.labels, [key]: entry } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** New prompt text for a new feature only; no existing agent's prompt is edited (AGENTS.md §3). */
export const TOOL_LABEL_SYSTEM_PROMPT = [
  'You name a batch of tool calls an AI agent just made.',
  `Reply with ONE label of at most ${TOOL_LABEL_MAX_WORDS} words, in past tense, saying what the batch did`,
  '(for example: Updated auth tests, Read the build config, Searched logs for timeout).',
  'No quotes, no trailing period, no preamble, no explanation, nothing else.',
].join(' ');
