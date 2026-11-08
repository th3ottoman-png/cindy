/**
 * intent-classifier — ROADMAP 7.2 "Smart Intent Expert Suggester" (Task Router).
 * ---------------------------------------------------------------------------
 * Pure, deterministic, local-only intent matching for the new-task composer.
 *
 * Contract:
 * - No I/O, no clock, no model/route call, no network. The optional local-model
 *   classifier route in the roadmap is deliberately NOT used here: the row
 *   allows a lightweight heuristic and a heuristic keeps the hot path boring.
 * - Nothing is cached. The same arguments always produce the same result.
 * - Only installed experts can be suggested. A rule whose slug is not installed
 *   is skipped (fail open on convenience: the feature hides, the app still runs).
 * - Rules are DATA, not a switch statement. Callers may pass `options.rules` to
 *   add intents without editing this module, which keeps the plugin boundary.
 */

/** The minimum shape the classifier needs. `Expert` satisfies it structurally. */
export interface ExpertSuggestionCandidate {
  slug: string;
  name: string;
  tags?: readonly string[];
}

export interface IntentRule {
  /** Target expert slug. Must match an installed candidate's slug. */
  slug: string;
  /** Short human label, e.g. "Code Review". */
  label: string;
  /** Whole-word / whole-phrase signals, worth 1 point each. */
  patterns?: readonly (string | RegExp)[];
  /** High-confidence signals, worth 3 points each. */
  strongPatterns?: readonly (string | RegExp)[];
}

export interface ExpertSuggestion {
  slug: string;
  name: string;
  label: string;
  score: number;
  /** Matched signal labels, deduplicated. Useful for tests and tooltips. */
  matched: string[];
}

export interface ExpertSuggestionOptions {
  /** Override or extend the rule table. Data, not control flow. */
  rules?: readonly IntentRule[];
  /** Suppress a suggestion for an expert already selected for this draft. */
  excludeSlug?: string | null;
  minPromptChars?: number;
  minScore?: number;
}

export const MIN_PROMPT_CHARS = 8;
export const MIN_SUGGESTION_SCORE = 2;

const STRONG_POINTS = 3;
const WEAK_POINTS = 1;
const TAG_POINTS = 1;

/**
 * Default intent table. Adding an expert intent is a new row here or an
 * `options.rules` override, never a new branch in a switch statement.
 * Signals are lower-cased and matched on word tokens, so "review" never
 * matches "preview" and "diff" never matches "different".
 */
export const DEFAULT_INTENT_RULES: readonly IntentRule[] = [
  {
    slug: 'code-reviewer',
    label: 'Code Review',
    strongPatterns: [
      'git diff',
      'pull request',
      'merge request',
      'code review',
      'review this diff',
      'refactor',
      'regression',
      'bug fix',
      /\bpr\s*#?\d+\b/,
    ],
    patterns: [
      'review',
      'diff',
      'patch',
      'bug',
      'test',
      'tests',
      'unit test',
      'lint',
      'audit',
      'stack trace',
      'crash',
      'typescript',
      'commit',
    ],
  },
  {
    slug: 'vault-researcher',
    label: 'Vault Research',
    strongPatterns: [
      'search my notes',
      'search notes',
      'obsidian',
      'backlink',
      'backlinks',
      'notes vault',
      'from my notes',
      'what did i write',
      'synthesize memory',
    ],
    patterns: [
      'vault',
      'note',
      'notes',
      'memory',
      'wiki',
      'knowledge base',
      'tag cloud',
      'summarise my notes',
      'project note',
    ],
  },
];

function normaliseWords(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function signalLabel(signal: string | RegExp): string {
  return signal instanceof RegExp ? signal.source : signal.trim().toLowerCase();
}

/**
 * Match one signal against the normalised prompt.
 * String signals match a whole token sequence. RegExp signals are cloned so a
 * stateful /g or /y flag on a caller-supplied rule cannot leak `lastIndex`
 * between invocations (purity guarantee).
 */
function matchesSignal(
  haystack: string,
  tokens: readonly string[],
  signal: string | RegExp,
): boolean {
  if (signal instanceof RegExp) {
    const flags = signal.flags.replace(/[gy]/g, '');
    const re = new RegExp(signal.source, flags.includes('i') ? flags : `${flags}i`);
    return re.test(haystack);
  }
  const words = normaliseWords(signal);
  if (words.length === 0 || words.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - words.length; i += 1) {
    if (words.every((word, j) => tokens[i + j] === word)) return true;
  }
  return false;
}

function matchedSignals(
  haystack: string,
  tokens: readonly string[],
  signals: readonly (string | RegExp)[] | undefined,
): string[] {
  const out: string[] = [];
  for (const signal of signals ?? []) {
    if (matchesSignal(haystack, tokens, signal)) out.push(signalLabel(signal));
  }
  return out;
}

/**
 * Suggest at most one installed expert for a composer prompt, or `null`.
 * Highest score wins. Ties go to the earlier rule, so the result is stable.
 */
export function suggestExpertForPrompt(
  prompt: string,
  installedExperts: readonly ExpertSuggestionCandidate[],
  options: ExpertSuggestionOptions = {},
): ExpertSuggestion | null {
  const {
    rules = DEFAULT_INTENT_RULES,
    excludeSlug = null,
    minPromptChars = MIN_PROMPT_CHARS,
    minScore = MIN_SUGGESTION_SCORE,
  } = options;

  const haystack = (prompt ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (haystack.length < minPromptChars) return null;
  if (!Array.isArray(installedExperts) || installedExperts.length === 0) return null;

  const tokens = normaliseWords(haystack);
  if (tokens.length === 0) return null;

  const bySlug = new Map<string, ExpertSuggestionCandidate>();
  for (const expert of installedExperts) {
    if (!expert || typeof expert.slug !== 'string' || !expert.slug.trim()) continue;
    if (!bySlug.has(expert.slug)) bySlug.set(expert.slug, expert);
  }
  if (bySlug.size === 0) return null;

  let best: ExpertSuggestion | null = null;
  let bestOrder = Number.POSITIVE_INFINITY;

  rules.forEach((rule, order) => {
    const candidate = bySlug.get(rule.slug);
    if (!candidate) return;
    if (excludeSlug !== null && excludeSlug !== undefined && rule.slug === excludeSlug) return;

    const strong = matchedSignals(haystack, tokens, rule.strongPatterns);
    const weak = matchedSignals(haystack, tokens, rule.patterns);
    const tags = matchedSignals(haystack, tokens, candidate.tags ?? []);
    const score =
      strong.length * STRONG_POINTS + weak.length * WEAK_POINTS + tags.length * TAG_POINTS;
    if (score < minScore) return;

    const matched = [...new Set([...strong, ...weak, ...tags])];
    if (!best || score > best.score || (score === best.score && order < bestOrder)) {
      best = {
        slug: candidate.slug,
        name: candidate.name?.trim() || candidate.slug,
        label: rule.label,
        score,
        matched,
      };
      bestOrder = order;
    }
  });

  return best;
}
