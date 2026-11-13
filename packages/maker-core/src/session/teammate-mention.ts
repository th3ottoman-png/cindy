/**
 * @-mention teammates (ROADMAP 12.3, ADR 0011).
 *
 * `@agent:<roster-id>` brings a roster entry into a running conversation as an Orca worker
 * teammate. It is deliberately NOT a turn attachment (8.4): `agent` is not an attachable kind,
 * the token survives `applyTurnAttachments`, and the host resolves it at send time. The token
 * is plain visible text; nothing here starts a session or writes state.
 *
 * Pure by design. No I/O, no clock, no network, no model call.
 */

import { parseImportedAgentId, type ImportedAgentSource } from '../experts/imported-agents.js';

/** The composer sigil. Distinct from 8.4's `@expert:` so that behaviour never changes. */
export const TEAMMATE_MENTION_SIGIL = '@agent:';

export type TeammateRosterRef =
  | { kind: 'expert'; slug: string; rosterId: string }
  | { kind: 'imported'; source: ImportedAgentSource; relPath: string; rosterId: string };

/** Expert slugs are directory names under the experts root (same rule as the binding store). */
const EXPERT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validate the roster-id part of a mention; the Agents page id space (ROADMAP 12.1). */
export function parseTeammateRosterId(id: unknown): TeammateRosterRef | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (id.startsWith('expert:')) {
    const slug = id.slice('expert:'.length);
    if (!EXPERT_SLUG.test(slug) || slug.includes('..')) return null;
    return { kind: 'expert', slug, rosterId: `expert:${slug}` };
  }
  const imported = parseImportedAgentId(id);
  if (!imported) return null;
  return { kind: 'imported', source: imported.source, relPath: imported.relPath, rosterId: id };
}

export interface TeammateMentionToken {
  ref: TeammateRosterRef;
  /** Exact source text of the token, without the boundary character. */
  raw: string;
  start: number;
  end: number;
}

/** Trailing punctuation belongs to the sentence, not to the roster id (same rule as 8.4). */
function trimTokenPunctuation(value: string): string {
  return value.replace(/[.,;:!?)\]}]+$/, '');
}

const MENTION_PATTERN = /(^|[\s([{"'>-])@agent:([^\s]+)/g;

interface RawMention {
  id: string;
  raw: string;
  /** The token exactly as typed, before punctuation trim; used for refusal messages. */
  rawTyped: string;
  start: number;
  end: number;
}

function scanMentions(text: string): RawMention[] {
  if (!text.includes(TEAMMATE_MENTION_SIGIL)) return [];
  const out: RawMention[] = [];
  const pattern = new RegExp(MENTION_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const id = trimTokenPunctuation(match[2]);
    if (!id) continue;
    const start = match.index + match[1].length;
    const raw = `${TEAMMATE_MENTION_SIGIL}${id}`;
    out.push({
      id,
      raw,
      rawTyped: `${TEAMMATE_MENTION_SIGIL}${match[2]}`,
      start,
      end: start + raw.length,
    });
  }
  return out;
}

/**
 * Every valid `@agent:<roster-id>` token, in order, including repeats — the service dedupes
 * for dispatch, the stripper removes all occurrences.
 */
export function parseTeammateMentions(text: string): TeammateMentionToken[] {
  const tokens: TeammateMentionToken[] = [];
  for (const mention of scanMentions(text)) {
    const ref = parseTeammateRosterId(mention.id);
    if (!ref) continue;
    tokens.push({ ref, raw: mention.raw, start: mention.start, end: mention.end });
  }
  return tokens;
}

/**
 * Token-shaped mentions whose id is not a roster id. The host refuses the send when this is
 * non-empty (fail closed): a typo never rides to the lead as prose.
 */
export function findInvalidTeammateMentions(text: string): string[] {
  return scanMentions(text)
    .filter((mention) => parseTeammateRosterId(mention.id) === null)
    .map((mention) => mention.rawTyped);
}

function tidyMentionWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Remove every teammate mention, leaving the owner's prose (and any 8.4 tokens) intact. */
export function stripTeammateMentions(text: string): string {
  const tokens = parseTeammateMentions(text);
  if (tokens.length === 0) return text;
  let output = '';
  let cursor = 0;
  for (const token of tokens) {
    let from = token.start;
    let to = token.end;
    // A token alone on its line takes the whole line with it, so no blank line is left behind.
    const lineStart = text.lastIndexOf('\n', token.start - 1) + 1;
    const lineEnd = text.indexOf('\n', token.end);
    const before = text.slice(lineStart, token.start);
    const after = lineEnd === -1 ? text.slice(token.end) : text.slice(token.end, lineEnd);
    if (/^\s*$/.test(before) && /^\s*$/.test(after)) {
      from = Math.max(lineStart, cursor);
      to = lineEnd === -1 ? text.length : lineEnd + 1;
    }
    output += text.slice(cursor, from);
    cursor = to;
  }
  output += text.slice(cursor);
  return tidyMentionWhitespace(output);
}

/**
 * The visible note appended to the lead's message so the transcript shows why a worker report
 * arrives. New-feature prompt text (AGENTS.md §3): it steers only the new teammate flow.
 */
export function renderTeammateDispatchNote(names: readonly string[]): string {
  if (names.length === 0) return '';
  const quoted = names.map((name) => `"${name}"`).join(', ');
  const noun = names.length === 1 ? 'teammate' : 'teammates';
  return `(This message was dispatched to ${noun} ${quoted} as a worker task. Acknowledge briefly and let the teammate do the work; their report will arrive as a worker message.)`;
}
