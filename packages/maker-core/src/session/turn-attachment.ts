import type { CapabilityDescriptor } from '../extensions/registry.js';

/**
 * Turn-scoped `@` attachments (ROADMAP 8.4).
 *
 * The composer writes an `@<kind>:<id>` token into the draft text. That token
 * is the whole state: it is visible, editable and deletable like any other
 * character, so nothing about an attachment can hide from the owner. At send
 * time the token is removed from the message and replaced by one compact
 * preamble line for that turn only. No expert, skill, connector or note is
 * enabled, disabled or written anywhere.
 *
 * Everything here is pure. No I/O, no clock, no network, no model call, no
 * subscription. The caller supplies candidates and resolves tokens.
 *
 * Kinds are open strings on purpose. A new attachable kind arrives as a new
 * capability source plus one line in `ATTACHABLE_KINDS`; nothing here switches
 * on kind (AGENTS.md section 6.2).
 */

/**
 * Capability kinds a turn attachment may reference. These are the capability
 * registry's own kind slugs, so no translation layer exists between the hub,
 * the panel and the token.
 */
export const ATTACHABLE_KINDS = [
  'expert',
  'skill',
  'mcp-server',
  'connector',
  'vault-note',
] as const;

/** Display order in the panel and in the chips. Data, not a switch. */
export const ATTACHMENT_KIND_ORDER: readonly string[] = [
  'expert',
  'skill',
  'mcp-server',
  'connector',
  'vault-note',
];

/** Longest query the panel will treat as live. Longer text is ordinary prose. */
const MAX_TRIGGER_QUERY = 64;

/** A token id never carries whitespace, so the token ends at the next space. */
const TOKEN_KIND_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Characters that may sit immediately before `@` for it to be a trigger. */
const BOUNDARY_BEFORE = new Set(['', ' ', '\t', '(', '[', '{', '"', "'", '>', '-']);

const MAX_ATTACHMENTS = 8;
const MAX_SOURCE_CHARS = 400;

/**
 * How each kind is described to the agent. The value completes the sentence
 * `... - <verb>.` Unknown kinds fall back to a neutral verb, so a new kind
 * still renders without a code change.
 */
const KIND_VERBS: Record<string, string> = {
  expert: 'adopt its instructions for this turn',
  skill: 'read it and follow it for this turn',
  'mcp-server': 'use its tools for this turn',
  connector: 'prefer this endpoint for this turn',
  'vault-note': 'read it for this turn',
};
const DEFAULT_VERB = 'use it for this turn';

/** One attachable thing, as the panel lists it. */
export interface TurnAttachmentCandidate {
  kind: string;
  id: string;
  title: string;
  /** File, directory or config path this candidate came from. */
  source: string;
  subtitle?: string;
  tags?: readonly string[];
  /** False rows are listed but not selectable. Defaults to true. */
  enabled?: boolean;
}

/** A resolved attachment: what the preamble needs, and nothing more. */
export interface TurnAttachment {
  kind: string;
  id: string;
  title: string;
  source: string;
}

/** A live `@` query in the composer. */
export interface AttachmentTrigger {
  /** Index of the `@` in the plain text. */
  start: number;
  /** End of the trigger. Always the end of the text. */
  end: number;
  /** Everything typed after `@`. */
  query: string;
  /** Kind named before `:`, when the query names one. */
  kindHint: string | null;
  /** Query with any kind prefix removed. */
  term: string;
}

/** One complete `@kind:id` token found in text. */
export interface TurnAttachmentToken {
  kind: string;
  id: string;
  /** Exact source text of the token, without the boundary character. */
  raw: string;
  start: number;
  end: number;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

/**
 * Detect a live `@` query.
 *
 * Only the trailing token counts: `@` must be the start of the last
 * whitespace-delimited word, must sit at a word boundary (so `name@host` is
 * prose, not a trigger), and must not contain a space. That keeps the panel
 * from opening while the owner is typing ordinary text.
 */
export function findAttachmentTrigger(text: string): AttachmentTrigger | null {
  if (!text) return null;
  const lineStart = text.lastIndexOf('\n') + 1;
  const line = text.slice(lineStart);
  const at = line.lastIndexOf('@');
  if (at < 0) return null;

  const query = line.slice(at + 1);
  if (query.length > MAX_TRIGGER_QUERY) return null;
  // Whitespace ends a token, so a spaced query is no longer live.
  if (/\s/.test(query)) return null;

  const before = at === 0 ? '' : line[at - 1];
  if (!BOUNDARY_BEFORE.has(before)) return null;

  const colon = query.indexOf(':');
  const rawHint = colon > 0 ? query.slice(0, colon).toLowerCase() : '';
  // Only a real attachable kind narrows the list. Otherwise `@foo:bar` would
  // filter to a kind that cannot exist and show an empty panel.
  const kindHint =
    TOKEN_KIND_RE.test(rawHint) && (ATTACHABLE_KINDS as readonly string[]).includes(rawHint)
      ? rawHint
      : null;
  const term = kindHint ? query.slice(colon + 1) : query;

  return {
    start: lineStart + at,
    end: text.length,
    query,
    kindHint,
    term,
  };
}

/**
 * True when a typed `@` query names an attachable kind, for example
 * `skill:sea`. The composer's existing file/agent panel keeps bare `@`; the
 * moment the query becomes capability-shaped, ownership hands over here. That
 * is how the prefix grammar is extended without two panels opening at once.
 */
export function isAttachmentKindQuery(query: string): boolean {
  const colon = query.indexOf(':');
  if (colon <= 0) return false;
  const hint = query.slice(0, colon).toLowerCase();
  return (ATTACHABLE_KINDS as readonly string[]).includes(hint);
}

function kindRank(kind: string): number {
  const index = ATTACHMENT_KIND_ORDER.indexOf(kind);
  return index < 0 ? ATTACHMENT_KIND_ORDER.length : index;
}

function scoreCandidate(candidate: TurnAttachmentCandidate, term: string): number {
  if (!term) return 1;
  const title = candidate.title.toLowerCase();
  const id = candidate.id.toLowerCase();

  if (title === term) return 100;
  if (title.startsWith(term)) return 80;

  const boundary = new RegExp(`(?:^|[\\s/_-])${escapeRegex(term)}`, 'i');
  if (boundary.test(candidate.title)) return 60;
  if (title.includes(term)) return 40;
  if (id.includes(term)) return 35;
  if (candidate.tags?.some((tag) => tag.toLowerCase().includes(term))) return 30;
  if (candidate.subtitle?.toLowerCase().includes(term)) return 20;
  return 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rank candidates for a trigger. With no term every enabled candidate of the
 * hinted kind is returned in display order, so a bare `@` shows a useful list
 * rather than an empty panel.
 */
export function rankAttachmentCandidates(
  candidates: readonly TurnAttachmentCandidate[],
  trigger: AttachmentTrigger,
  limit = 12,
): TurnAttachmentCandidate[] {
  const term = trigger.term.trim().toLowerCase();
  const scored: { candidate: TurnAttachmentCandidate; score: number; index: number }[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate.enabled === false) continue;
    if (trigger.kindHint && candidate.kind !== trigger.kindHint) continue;
    const score = scoreCandidate(candidate, term);
    if (score > 0) scored.push({ candidate, score, index });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      kindRank(left.candidate.kind) - kindRank(right.candidate.kind) ||
      left.index - right.index,
  );

  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/** Token ids never contain whitespace, so the token can end at a space. */
export function attachmentTokenId(id: string): string {
  return oneLine(id).replace(/\s+/g, '-');
}

/** The exact text written into the composer. */
export function attachmentToken(item: { kind: string; id: string }): string {
  return `@${item.kind}:${attachmentTokenId(item.id)}`;
}

/** Trailing punctuation belongs to the sentence, not to the token id. */
function trimTokenPunctuation(value: string): string {
  return value.replace(/[.,;:!?)\]}]+$/, '');
}

/**
 * Find every complete `@kind:id` token. A token must start at a word boundary
 * and must not contain whitespace, so `@skill:search_notes` parses and
 * `email@example.com` does not.
 */
export function parseTurnAttachmentTokens(text: string): TurnAttachmentToken[] {
  if (!text.includes('@')) return [];
  const tokens: TurnAttachmentToken[] = [];
  const seen = new Set<string>();
  const pattern = /(^|[\s([{"'>-])@([a-z0-9][a-z0-9-]*):([^\s]+)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const kind = match[2];
    const id = trimTokenPunctuation(match[3]);
    if (!kind || !id) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = match.index + match[1].length;
    tokens.push({
      kind,
      id,
      raw: `@${kind}:${id}`,
      start,
      end: start + 1 + kind.length + 1 + id.length,
    });
  }

  return tokens;
}

function tidyAttachmentWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove every attachment token, leaving the owner's prose intact.
 *
 * `preserveKinds` (ROADMAP 11.1) leaves tokens of those kinds in place so a downstream
 * resolver can consume them. Defaults to stripping everything, so 8.4 behaviour is unchanged.
 */
export function stripTurnAttachmentTokens(text: string, preserveKinds: readonly string[] = []): string {
  const tokens = parseTurnAttachmentTokens(text);
  if (tokens.length === 0) return text;
  const preserve = new Set(preserveKinds);

  let output = '';
  let cursor = 0;
  for (const token of tokens) {
    if (preserve.has(token.kind)) continue;
    output += text.slice(cursor, token.start);
    cursor = token.end;
  }
  output += text.slice(cursor);
  return tidyAttachmentWhitespace(output);
}

function dedupeAttachments(items: readonly TurnAttachment[]): TurnAttachment[] {
  const seen = new Set<string>();
  const unique: TurnAttachment[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

/**
 * One compact line that tells the agent what was attached for this turn.
 * Bounded, so a long note path or many attachments cannot flood the prompt.
 */
export function renderTurnAttachmentPreamble(items: readonly TurnAttachment[]): string {
  const unique = dedupeAttachments(items).slice(0, MAX_ATTACHMENTS);
  if (unique.length === 0) return '';

  const parts = unique.map((item) => {
    const verb = KIND_VERBS[item.kind] ?? DEFAULT_VERB;
    const source = item.source ? ` at ${truncate(item.source, MAX_SOURCE_CHARS)}` : '';
    return `${item.kind} "${oneLine(item.title)}"${source} - ${verb}`;
  });

  return `[Attached for this turn only: ${parts.join('; ')}. Nothing here changes the session.]`;
}

/**
 * Turn the composed message into what the agent receives: tokens removed, one
 * preamble line added. A leading slash command stays on the first line so the
 * composer's command routing still matches it.
 */
export function applyTurnAttachments(
  text: string,
  items: readonly TurnAttachment[],
  options: { preserveKinds?: readonly string[] } = {},
): string {
  const preamble = renderTurnAttachmentPreamble(items);
  if (!preamble) return text;

  const body = stripTurnAttachmentTokens(text, options.preserveKinds);
  if (!body) return preamble;

  if (body.startsWith('/')) {
    const lineEnd = body.indexOf('\n');
    if (lineEnd < 0) return `${body}\n\n${preamble}`;
    return `${body.slice(0, lineEnd)}\n\n${preamble}\n${body.slice(lineEnd + 1)}`;
  }

  return `${preamble}\n\n${body}`;
}

/** Short human summary, used by chips and aria labels. */
export function describeTurnAttachments(items: readonly TurnAttachment[]): string {
  const unique = dedupeAttachments(items);
  if (unique.length === 0) return 'No turn attachments';
  return unique.map((item) => `${item.kind} ${item.title}`).join(', ');
}

/**
 * Map capability rows to panel candidates. Only attachable kinds survive, and
 * a row that is disabled or hidden is listed but not selectable, so the owner
 * can see why it is not available.
 */
export function attachmentCandidatesFromCapabilities(
  descriptors: readonly CapabilityDescriptor[],
  kinds: readonly string[] = ATTACHABLE_KINDS,
): TurnAttachmentCandidate[] {
  const allowed = new Set(kinds);
  return descriptors
    .filter((descriptor) => allowed.has(descriptor.kind))
    .map((descriptor) => ({
      kind: descriptor.kind,
      id: descriptor.id.startsWith(`${descriptor.kind}:`)
        ? descriptor.id.slice(descriptor.kind.length + 1)
        : descriptor.id,
      title: descriptor.title,
      source: descriptor.source,
      subtitle: descriptor.subtitle,
      tags: descriptor.tags,
      enabled: descriptor.enabled && descriptor.visible !== false,
    }));
}

/** Resolve parsed tokens against candidates, dropping anything unknown. */
export function resolveTurnAttachments(
  tokens: readonly TurnAttachmentToken[],
  candidates: readonly TurnAttachmentCandidate[],
): TurnAttachment[] {
  const byKey = new Map<string, TurnAttachmentCandidate>();
  for (const candidate of candidates) {
    byKey.set(`${candidate.kind}:${attachmentTokenId(candidate.id)}`, candidate);
  }

  const resolved: TurnAttachment[] = [];
  for (const token of tokens) {
    const candidate = byKey.get(`${token.kind}:${token.id}`);
    resolved.push(
      candidate
        ? {
            kind: candidate.kind,
            id: candidate.id,
            title: candidate.title,
            source: candidate.source,
          }
        : { kind: token.kind, id: token.id, title: token.id, source: '' },
    );
  }
  return dedupeAttachments(resolved);
}
