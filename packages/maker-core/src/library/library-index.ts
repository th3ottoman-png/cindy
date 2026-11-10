/**
 * Library index (ROADMAP 8.5).
 *
 * One searchable view over the local content this fork actually produces:
 * vault notes, auto-saved chat transcripts and generated summaries. The index
 * is built from plain file facts (path, title, tags, body, mtime), so the same
 * code serves the desktop app, a test and a future CLI.
 *
 * `kind` is an open slug. `artifact` is reserved for a real artifact store; this
 * fork has none, so no source emits it yet and nothing here switches on kind.
 *
 * Pure. No I/O, no clock, no network, no model call. Callers read files.
 */

import { attachmentTokenId } from '../session/turn-attachment.js';

/** Kinds the Library knows about. `artifact` has no source in this fork yet. */
export const LIBRARY_KINDS = ['note', 'chat', 'summary', 'artifact'] as const;

/** Display order. Data, not a switch. */
export const LIBRARY_KIND_ORDER: readonly string[] = ['note', 'chat', 'summary', 'artifact'];

const CHAT_PREFIX = 'Cindy/Chats/';
const SUMMARY_PREFIX = 'Cindy/Memory/';
const ARTIFACT_PREFIX = 'Cindy/Artifacts/';

const MAX_EXCERPT = 240;
const MAX_BODY_SCAN = 200_000;
const MIN_CITATION_NEEDLE = 4;

export interface LibraryClassifier {
  kind: string;
  prefix?: string;
  match?: (path: string) => boolean;
}

const customClassifiers: LibraryClassifier[] = [];

/**
 * Register a custom library classifier without modifying central code (AGENTS.md §6).
 */
export function registerLibraryClassifier(classifier: LibraryClassifier): () => void {
  customClassifiers.unshift(classifier);
  return () => {
    const idx = customClassifiers.indexOf(classifier);
    if (idx !== -1) customClassifiers.splice(idx, 1);
  };
}

/**
 * Clear custom classifiers (useful for test isolation).
 */
export function clearCustomLibraryClassifiers(): void {
  customClassifiers.length = 0;
}

export interface LibrarySourceEntry {
  /** Vault-relative path, forward slashes. Stable identity. */
  path: string;
  title: string;
  /** Explicit kind override (e.g. 'artifact', or dynamic extension kind). */
  kind?: string;
  tags?: readonly string[];
  mtimeMs?: number;
  /** Raw markdown. Used for the excerpt and for citation matching. */
  body?: string;
}

export interface LibraryEntry {
  kind: string;
  id: string;
  title: string;
  path: string;
  updatedAt: number | null;
  tags: string[];
  excerpt: string;
  /** Chat transcripts whose body mentions this entry's title or path. */
  citations: string[];
}

function normalisePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Classify by registered classifier or known Cindy folder prefixes. Everything outside
 * known folders is a note, which is the safe default: an unknown path is still useful content.
 */
export function classifyLibraryPath(path: string): string {
  const normalised = normalisePath(path);
  for (const classifier of customClassifiers) {
    if (classifier.prefix && normalised.startsWith(normalisePath(classifier.prefix))) {
      return classifier.kind;
    }
    if (classifier.match && classifier.match(normalised)) {
      return classifier.kind;
    }
  }
  if (normalised.startsWith(CHAT_PREFIX)) return 'chat';
  if (normalised.startsWith(SUMMARY_PREFIX)) return 'summary';
  if (normalised.startsWith(ARTIFACT_PREFIX)) return 'artifact';
  return 'note';
}

/** Drop YAML frontmatter, heading markers and fence noise, then bound it. */
export function libraryExcerpt(body: string | undefined): string {
  if (!body) return '';
  let text = body;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) text = text.slice(end + 4);
  }
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= MAX_EXCERPT ? cleaned : `${cleaned.slice(0, MAX_EXCERPT - 3)}...`;
}

/** A chat transcript name is `YYYY-MM-DD-<slug>-<8 hex>.md`; the date is useful. */
export function libraryChatDate(path: string): string | null {
  const name = normalisePath(path).split('/').pop() ?? '';
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-/);
  return match ? match[1] : null;
}

/**
 * Build the index and compute citations in one pass.
 *
 * A note is cited by a chat transcript when the transcript body contains the
 * note's path or title. Link-only backlinks miss this case because the
 * auto-saved transcripts do not write wiki links, so the scan is by text.
 * Bodies are bounded and only chat transcripts are scanned, so the cost stays
 * proportional to the number of chats.
 */
export function buildLibraryIndex(
  entries: readonly LibrarySourceEntry[],
): LibraryEntry[] {
  const bodies = new Map<string, string>();
  const index: LibraryEntry[] = entries.map((entry) => {
    const path = normalisePath(entry.path);
    const kind = entry.kind || classifyLibraryPath(path);
    const body = (entry.body ?? '').slice(0, MAX_BODY_SCAN);
    if (kind === 'chat' && body) bodies.set(path, body.toLowerCase());
    return {
      kind,
      id: path,
      title: entry.title.trim() || path,
      path,
      updatedAt: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : null,
      tags: [...(entry.tags ?? [])],
      excerpt: libraryExcerpt(entry.body),
      citations: [],
    };
  });

  if (bodies.size > 0) {
    for (const entry of index) {
      if (entry.kind === 'chat') continue;
      const needles = [entry.path, entry.title]
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length >= MIN_CITATION_NEEDLE);
      if (needles.length === 0) continue;
      const citing: string[] = [];
      for (const [chatPath, body] of bodies) {
        if (needles.some((needle) => body.includes(needle))) citing.push(chatPath);
      }
      entry.citations = citing.sort();
    }
  }

  return index;
}

function kindRank(kind: string): number {
  const position = LIBRARY_KIND_ORDER.indexOf(kind);
  return position < 0 ? LIBRARY_KIND_ORDER.length : position;
}

function scoreEntry(entry: LibraryEntry, term: string): number {
  if (!term) return 1;
  const title = entry.title.toLowerCase();
  if (title === term) return 100;
  if (title.startsWith(term)) return 80;
  const boundary = new RegExp(`(?:^|[\\s/_-])${escapeRegex(term)}`, 'i');
  if (boundary.test(entry.title)) return 60;
  if (title.includes(term)) return 40;
  if (entry.tags.some((tag) => tag.toLowerCase().includes(term))) return 30;
  if (entry.excerpt.toLowerCase().includes(term)) return 20;
  if (entry.path.toLowerCase().includes(term)) return 10;
  return 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keyword search across title, tags, excerpt and path. Newest first on a tie,
 * then kind order, so the same query always returns the same list.
 */
export function searchLibrary(
  index: readonly LibraryEntry[],
  query: string,
  limit = 40,
): LibraryEntry[] {
  const term = query.trim().toLowerCase();
  const scored: { entry: LibraryEntry; score: number; position: number }[] = [];

  for (let position = 0; position < index.length; position += 1) {
    const entry = index[position];
    const score = scoreEntry(entry, term);
    if (score > 0) scored.push({ entry, score, position });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
      kindRank(left.entry.kind) - kindRank(right.entry.kind) ||
      left.position - right.position,
  );

  return scored.slice(0, limit).map((item) => item.entry);
}

/** Kinds are derived from the rows, so an empty kind simply does not appear. */
export function groupLibraryByKind(
  index: readonly LibraryEntry[],
): { kind: string; items: LibraryEntry[] }[] {
  const groups = new Map<string, LibraryEntry[]>();
  for (const entry of index) {
    const items = groups.get(entry.kind);
    if (items) items.push(entry);
    else groups.set(entry.kind, [entry]);
  }
  return [...groups].map(([kind, items]) => ({ kind, items }));
}

/** Counts for the filter chips. */
export function libraryKindSummary(
  index: readonly LibraryEntry[],
): { kind: string; count: number }[] {
  return groupLibraryByKind(index)
    .map((group) => ({ kind: group.kind, count: group.items.length }))
    .sort((left, right) => kindRank(left.kind) - kindRank(right.kind));
}

/**
 * The token a row writes when dropped on a composer. It reuses the 8.4
 * attachment grammar, including its id encoder, so a dropped note becomes a
 * turn attachment with no second mechanism.
 */
export function libraryEntryToken(entry: { path: string; kind?: string }): string {
  return `@vault-note:${attachmentTokenId(normalisePath(entry.path))}`;
}
