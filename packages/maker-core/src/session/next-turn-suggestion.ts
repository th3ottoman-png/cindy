/**
 * ROADMAP 9.1 — next-turn suggestion extraction.
 * ---------------------------------------------------------------------------
 * When an agent closes a turn with a concrete continuation, this module turns
 * that closing line into one short phrase the owner can drop straight into the
 * composer. It is a heuristic over the assistant's own words: no model call, no
 * I/O, no clock, no network, no hidden state.
 *
 * Design rules, in order of importance:
 *
 * 1. Silence beats noise. A wrong pill costs more than no pill, so anything
 *    that reads like prose, a UI instruction ("click the … row"), a code fence,
 *    or a long paragraph returns `null`.
 * 2. The suggestion is a phrase the owner would *say to the agent*, not an
 *    instruction for the owner to follow by hand. A backticked command in a
 *    "Next action" line wins over the surrounding prose, because that is the
 *    text the agent is waiting for.
 * 3. Deterministic and inspectable. Every suggestion carries the reason and the
 *    source line, so the pill can explain itself and tests can pin behaviour.
 */

/** Why a suggestion was produced. Data, so a new reason needs no switch here. */
export type NextTurnSuggestionReason = 'question' | 'next-action' | 'offer' | 'option';

export interface NextTurnSuggestion {
  /** Exactly what one click writes into the composer. */
  text: string;
  /** Short pill label: `text`, ellipsised to `MAX_LABEL`. */
  label: string;
  reason: NextTurnSuggestionReason;
  /** Trimmed source line, kept for the tooltip and for tests. */
  sourceLine: string;
}

export interface SuggestNextTurnOptions {
  /** Hard cap on the suggestion text. Longer candidates are rejected. */
  maxLength?: number;
}

/** Longest suggestion text kept. Anything longer is prose, not a reply. */
export const DEFAULT_SUGGESTION_MAX_LENGTH = 160;

/** Longest pill label before ellipsis. */
export const SUGGESTION_MAX_LABEL = 72;

/** How many trailing non-empty lines are inspected. */
const MAX_SCAN_LINES = 24;

const FENCE_LINE = /^\s*(?:```|~~~)/;
const NEXT_ACTION_LINE =
  /^\s*[*_]{0,2}(?:next action|next step|next up|next)(?:[*_]{0,2})\s*(?:\([^)]*\))?\s*[:—-]\s*(.+)$/i;
const OFFER_LINE =
  /\b(?:shall i|should i|want me to|would you like me to|do you want me to|let me know|waiting on your (?:go|decision|call)|your call|say the word|tell me (?:which|when|if)|when you'?re ready)\b/i;
const LIST_ITEM_LINE = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.+)$/;
const CHOICE_CUE = /\b(?:which|choose|pick|option|either|one of|prefer)\b/i;
const QUESTION_TAIL = /\?\s*$/;
/** UI instructions are for the owner's hands, not for the composer. */
const UI_INSTRUCTION =
  /\b(?:click|tap|open the|open settings|navigate|scroll|look at|select the|type in the|run the app|reload|restart the app)\b/i;
const BACKTICK = /`([^`]+)`/g;
/** A short reply the agent would act on without further words. */
const STANDALONE_REPLY = /^(?:go|yes|no|yep|nope|continue|proceed|ok|okay|do it|ship it|start|stop)\b/i;

/**
 * Extract the single strongest continuation from one assistant message.
 *
 * Returns `null` when the message offers nothing worth one click. That is the
 * common case and it is not a failure.
 */
export function suggestNextTurn(
  assistantText: string | null | undefined,
  options?: SuggestNextTurnOptions,
): NextTurnSuggestion | null {
  const maxLength = options?.maxLength ?? DEFAULT_SUGGESTION_MAX_LENGTH;
  if (typeof assistantText !== 'string' || assistantText.trim() === '') return null;

  const lines = scanLines(stripFencedCode(assistantText));
  if (lines.length === 0) return null;

  const actionSuggestion = fromNextAction(lines, maxLength);
  if (actionSuggestion) return actionSuggestion;

  const questionSuggestion = fromQuestion(lines, maxLength);
  if (questionSuggestion) return questionSuggestion;

  const offerSuggestion = fromOffer(lines, maxLength);
  if (offerSuggestion) return offerSuggestion;

  return fromOption(lines, maxLength);
}

/** Stable identity for dismissal and de-duplication. */
export function nextTurnSuggestionKey(suggestion: NextTurnSuggestion): string {
  return `${suggestion.reason}:${suggestion.text}`;
}

// ---------------------------------------------------------------------------
// Extraction stages
// ---------------------------------------------------------------------------

function fromNextAction(
  lines: readonly string[],
  maxLength: number,
): NextTurnSuggestion | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = NEXT_ACTION_LINE.exec(lines[index]);
    if (!match) continue;
    const sourceLine = lines[index];
    const body = match[1].trim();

    // A backticked command is what the agent is waiting for. Take the last one,
    // because prose usually names the action first and the command last.
    const command = lastBacktickedCommand(body, maxLength);
    if (command) {
      return buildSuggestion(command, 'next-action', sourceLine, maxLength);
    }

    if (UI_INSTRUCTION.test(body)) continue;
    const cleaned = cleanPhrase(body);
    if (!looksLikeReply(cleaned, maxLength)) continue;
    return buildSuggestion(cleaned, 'next-action', sourceLine, maxLength);
  }
  return null;
}

function fromQuestion(
  lines: readonly string[],
  maxLength: number,
): NextTurnSuggestion | null {
  const last = lines[lines.length - 1];
  if (!QUESTION_TAIL.test(last)) return null;
  if (UI_INSTRUCTION.test(last)) return null;
  const cleaned = cleanPhrase(last);
  if (!looksLikeReply(cleaned, maxLength)) return null;
  return buildSuggestion(cleaned, 'question', last, maxLength);
}

function fromOffer(
  lines: readonly string[],
  maxLength: number,
): NextTurnSuggestion | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!OFFER_LINE.test(line)) continue;
    if (UI_INSTRUCTION.test(line)) continue;
    const cleaned = cleanPhrase(line);
    if (!looksLikeReply(cleaned, maxLength)) continue;
    return buildSuggestion(cleaned, 'offer', line, maxLength);
  }
  return null;
}

/**
 * A numbered or bulleted list at the very end, preceded by a line that asks the
 * owner to choose, is a menu. Offer its first entry: one click, no typing.
 */
function fromOption(
  lines: readonly string[],
  maxLength: number,
): NextTurnSuggestion | null {
  const tail: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!LIST_ITEM_LINE.test(lines[index])) break;
    tail.unshift(lines[index]);
  }
  if (tail.length === 0) return null;
  const headerIndex = lines.length - tail.length - 1;
  if (headerIndex < 0) return null;
  const header = lines[headerIndex];
  if (!CHOICE_CUE.test(header) && !QUESTION_TAIL.test(header)) return null;

  const first = LIST_ITEM_LINE.exec(tail[0]);
  if (!first) return null;
  const cleaned = cleanPhrase(first[1]);
  if (!looksLikeReply(cleaned, maxLength)) return null;
  return buildSuggestion(cleaned, 'option', tail[0], maxLength);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Drop fenced code blocks before scanning. A `?` or a "next step" comment inside
 * a code sample is not a question to the owner.
 */
function stripFencedCode(text: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (FENCE_LINE.test(line)) {
      inside = !inside;
      out.push('');
      continue;
    }
    out.push(inside ? '' : line);
  }
  return out.join('\n');
}

function scanLines(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '');
  return lines.slice(Math.max(0, lines.length - MAX_SCAN_LINES));
}

/** Strip markdown emphasis, list markers, quotes and trailing punctuation. */
function cleanPhrase(value: string): string {
  let text = value.trim();
  text = text.replace(LIST_ITEM_LINE, '$1');
  text = text.replace(/^[*_]{1,3}(.*?)[*_]{1,3}$/u, '$1');
  text = text.replace(/[*_]{1,3}/gu, '');
  text = text.replace(/^[`'"]+|[`'"]+$/gu, '');
  text = text.replace(/\s+/gu, ' ').trim();
  text = text.replace(/[:\-–—,;]+$/u, '').trim();
  return text;
}

/**
 * The last backticked phrase that reads like something the owner would send.
 * `Capabilities` (one word, a UI label) is rejected; `go 8.1` is accepted.
 */
function lastBacktickedCommand(body: string, maxLength: number): string | null {
  const matches = [...body.matchAll(BACKTICK)].map((match) => match[1].trim());
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = cleanPhrase(matches[index]);
    if (looksLikeReply(candidate, maxLength) && isCommandShaped(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isCommandShaped(value: string): boolean {
  if (STANDALONE_REPLY.test(value)) return true;
  const words = value.split(/\s+/u).filter(Boolean);
  return words.length >= 2 && words.length <= 10;
}

/**
 * Reject prose. A suggestion has to be short, must not be a question about the
 * agent's own work, and must not be a URL or a file path on its own.
 */
function looksLikeReply(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  if (/^https?:\/\//iu.test(value)) return false;
  const words = value.split(/\s+/u).filter(Boolean);
  if (words.length === 0 || words.length > 18) return false;
  // A long sentence ending in a full stop is prose, not a reply.
  if (words.length > 10 && /[.!?]$/u.test(value)) return false;
  return true;
}

function buildSuggestion(
  text: string,
  reason: NextTurnSuggestionReason,
  sourceLine: string,
  maxLength: number,
): NextTurnSuggestion {
  const bounded = text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
  return {
    text: bounded,
    label:
      bounded.length <= SUGGESTION_MAX_LABEL
        ? bounded
        : `${bounded.slice(0, SUGGESTION_MAX_LABEL - 1).trimEnd()}…`,
    reason,
    sourceLine: sourceLine.trim(),
  };
}
