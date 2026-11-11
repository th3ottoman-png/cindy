/**
 * Multi-model council review (ROADMAP 11.4). Pure logic only: reviewer-selection validation,
 * the neutral diff brief, reviewer-output parsing, deduplication by file/line, and consensus
 * ranking. Nothing here calls a model, so the ranking rules stay auditable and testable without
 * a network, and the host owns dispatch and persistence.
 *
 * Honesty rules baked in:
 * - A reviewer whose reply cannot be parsed counts as FAILED, not as "no findings". Treating
 *   prose as silence would inflate the denominator and turn `[1/3 agreed]` into a lie.
 * - Consensus is computed over reviewers that actually produced a usable review (`of`), never
 *   over the number the owner selected.
 * - Nothing is invented: findings whose `file` is not in the diff are dropped, because a model
 *   naming a file that was never shown is a hallucination, not a finding.
 */

export const COUNCIL_MAX_REVIEWERS = 3;
export const COUNCIL_MIN_REVIEWERS = 1;
export const COUNCIL_MAX_FINDINGS_PER_REVIEWER = 40;
export const COUNCIL_DEFAULT_MAX_BRIEF_CHARS = 60_000;
export const COUNCIL_DEFAULT_MAX_FILES = 40;

/** `providers.yaml` id plus a model on that endpoint. */
export interface CouncilReviewer {
  providerId: string;
  model: string;
}

export const COUNCIL_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type CouncilSeverity = (typeof COUNCIL_SEVERITIES)[number];

/**
 * Closed defect vocabulary. Consensus must not depend on two models happening to choose the same
 * words, so the brief asks each reviewer to classify the defect. Two reviewers that pick the same
 * class at the same place agree, whatever prose they wrapped it in.
 */
export const COUNCIL_FINDING_KINDS = [
  'null-deref',
  'unchecked-response',
  'unencoded-input',
  'unsafe-cast',
  'unhandled-error',
  'off-by-one',
  'resource-leak',
  'race-condition',
  'injection',
  'secret-exposure',
  'data-loss',
  'other',
] as const;
export type CouncilFindingKind = (typeof COUNCIL_FINDING_KINDS)[number];

const KIND_SYNONYMS: Record<string, CouncilFindingKind> = {
  'null-deref': 'null-deref',
  'null-check': 'null-deref',
  'undefined-access': 'null-deref',
  'null-pointer': 'null-deref',
  'unchecked-response': 'unchecked-response',
  'http-error': 'unchecked-response',
  'unchecked-http': 'unchecked-response',
  'missing-status-check': 'unchecked-response',
  'unencoded-input': 'unencoded-input',
  'url-injection': 'unencoded-input',
  'path-injection': 'unencoded-input',
  'unsafe-cast': 'unsafe-cast',
  'unvalidated-cast': 'unsafe-cast',
  'type-assertion': 'unsafe-cast',
  'unhandled-error': 'unhandled-error',
  'missing-error-handling': 'unhandled-error',
  'exception': 'unhandled-error',
  'off-by-one': 'off-by-one',
  'index-bounds': 'off-by-one',
  'resource-leak': 'resource-leak',
  'race-condition': 'race-condition',
  'injection': 'injection',
  'sql-injection': 'injection',
  'command-injection': 'injection',
  'secret-exposure': 'secret-exposure',
  'credential-leak': 'secret-exposure',
  'data-loss': 'data-loss',
};

export function normalizeFindingKind(value: unknown): CouncilFindingKind {
  if (typeof value !== 'string') return 'other';
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return KIND_SYNONYMS[key] ?? 'other';
}

const SEVERITY_RANK: Record<CouncilSeverity, number> = {
  blocker: 3,
  major: 2,
  minor: 1,
  nit: 0,
};

export interface CouncilFinding {
  file: string;
  /** Line in the new file; 0 means a file-level finding. */
  line: number;
  severity: CouncilSeverity;
  /** Defect class from the closed vocabulary; `other` when the reviewer did not classify it. */
  kind: CouncilFindingKind;
  title: string;
  detail: string;
  /** Optional replacement code the owner can apply. */
  suggestion?: string;
}

export interface CouncilOutcome {
  reviewer: CouncilReviewer;
  status: 'ok' | 'failed';
  findings: CouncilFinding[];
  /** Credential-safe failure reason; never contains a prompt or a key. */
  reason?: string;
}

export interface ConsensusFinding extends CouncilFinding {
  id: string;
  /** Reviewers that raised this finding, in selection order. */
  agreedBy: CouncilReviewer[];
  agreement: number;
  /** Number of reviewers that produced a usable review. */
  of: number;
}

export interface CouncilVerdict {
  findings: ConsensusFinding[];
  outcomes: CouncilOutcome[];
  usableReviewers: number;
  failedReviewers: number;
}

export type CouncilParseResult =
  | { ok: true; findings: CouncilFinding[] }
  | { ok: false; reason: 'empty' | 'unparseable' | 'no-findings-shape' };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function reviewerKey(reviewer: CouncilReviewer): string {
  return `${reviewer.providerId}::${reviewer.model}`;
}

export interface CouncilSelectionValidation {
  ok: boolean;
  reviewers: CouncilReviewer[];
  errors: string[];
}

/**
 * Validate the owner's pick against the endpoints that actually exist. One to three reviewers,
 * unique, each present in `available`. Returns the normalised list on success.
 */
export function validateCouncilSelection(
  selected: unknown,
  available: readonly CouncilReviewer[],
): CouncilSelectionValidation {
  const errors: string[] = [];
  const reviewers: CouncilReviewer[] = [];
  const known = new Set(available.map(reviewerKey));
  const seen = new Set<string>();

  if (!Array.isArray(selected)) {
    return { ok: false, reviewers: [], errors: ['reviewers must be a list'] };
  }
  if (selected.length < COUNCIL_MIN_REVIEWERS) {
    errors.push('select at least one reviewer');
  }
  if (selected.length > COUNCIL_MAX_REVIEWERS) {
    errors.push(`at most ${COUNCIL_MAX_REVIEWERS} reviewers`);
  }

  for (const raw of selected) {
    if (!isRecord(raw)) {
      errors.push('every reviewer needs a provider and a model');
      continue;
    }
    const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!providerId || !model) {
      errors.push('every reviewer needs a provider and a model');
      continue;
    }
    const reviewer = { providerId, model };
    const key = reviewerKey(reviewer);
    if (!known.has(key)) {
      errors.push(`${providerId}/${model} is not a configured endpoint model`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`${providerId}/${model} was selected twice`);
      continue;
    }
    seen.add(key);
    reviewers.push(reviewer);
  }

  return { ok: errors.length === 0, reviewers, errors };
}

/** Strip a leading `a/` or `b/`, unify separators, drop `./`, and lowercase for comparison. */
export function normalizeFilePath(file: string): string {
  let out = file.trim().replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  if (/^[ab]\//.test(out) && out.length > 2) out = out.slice(2);
  return out.toLowerCase();
}

const SEVERITY_SYNONYMS: Record<string, CouncilSeverity> = {
  blocker: 'blocker',
  critical: 'blocker',
  severe: 'blocker',
  high: 'blocker',
  major: 'major',
  medium: 'major',
  moderate: 'major',
  error: 'major',
  minor: 'minor',
  low: 'minor',
  warning: 'minor',
  nit: 'nit',
  info: 'nit',
  note: 'nit',
  style: 'nit',
};

export function normalizeSeverity(value: unknown): CouncilSeverity {
  if (typeof value !== 'string') return 'minor';
  return SEVERITY_SYNONYMS[value.trim().toLowerCase()] ?? 'minor';
}

function asLine(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function firstLine(text: string, max = 120): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

function coerceFinding(raw: unknown): CouncilFinding | null {
  if (!isRecord(raw)) return null;
  const fileRaw = raw.file ?? raw.path ?? raw.filename ?? raw.filePath;
  if (typeof fileRaw !== 'string' || !fileRaw.trim()) return null;
  const detailRaw = raw.detail ?? raw.description ?? raw.body ?? raw.message ?? raw.why;
  const titleRaw = raw.title ?? raw.summary ?? raw.issue ?? raw.message;
  const detail = typeof detailRaw === 'string' ? detailRaw.trim() : '';
  const title = typeof titleRaw === 'string' && titleRaw.trim()
    ? firstLine(titleRaw)
    : firstLine(detail);
  if (!title && !detail) return null;
  const suggestionRaw = raw.suggestion ?? raw.patch ?? raw.fix ?? raw.replacement;
  const finding: CouncilFinding = {
    file: normalizeFilePath(fileRaw),
    line: asLine(raw.line ?? raw.startLine ?? raw.lineNumber ?? raw.line_number),
    severity: normalizeSeverity(raw.severity ?? raw.level ?? raw.priority),
    kind: normalizeFindingKind(raw.kind ?? raw.category ?? raw.class ?? raw.type),
    title: title || firstLine(detail),
    detail: detail || title,
  };
  if (typeof suggestionRaw === 'string' && suggestionRaw.trim()) {
    finding.suggestion = suggestionRaw.replace(/\s+$/, '');
  }
  return finding;
}

/** Try the whole reply, fenced blocks, then the outermost object or array. */
function extractJson(text: string): unknown {
  const attempts: string[] = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) attempts.push(match[1].trim());
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) attempts.push(text.slice(firstBrace, lastBrace + 1));
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) attempts.push(text.slice(firstBracket, lastBracket + 1));

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function findingsArray(doc: unknown): unknown[] | null {
  if (Array.isArray(doc)) return doc;
  if (!isRecord(doc)) return null;
  for (const key of ['findings', 'issues', 'notes', 'comments'] as const) {
    if (Array.isArray(doc[key])) return doc[key] as unknown[];
  }
  if (doc.file !== undefined || doc.path !== undefined) return [doc];
  return null;
}

/**
 * Parse one reviewer reply. A reply that is prose, empty, or JSON of the wrong shape is a
 * failure, so the caller can exclude it from the consensus denominator.
 */
export function parseReviewerOutput(text: string): CouncilParseResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
  const doc = extractJson(text);
  if (doc === undefined) return { ok: false, reason: 'unparseable' };
  const items = findingsArray(doc);
  if (!items) return { ok: false, reason: 'no-findings-shape' };
  const findings: CouncilFinding[] = [];
  for (const item of items) {
    const finding = coerceFinding(item);
    if (finding) findings.push(finding);
    if (findings.length >= COUNCIL_MAX_FINDINGS_PER_REVIEWER) break;
  }
  return { ok: true, findings };
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at',
  'for', 'and', 'or', 'if', 'it', 'its', 'this', 'that', 'with', 'from', 'by', 'as', 'not',
  'no', 'but', 'so', 'can', 'will', 'should', 'would', 'may', 'might', 'must', 'when', 'then',
  'there', 'here', 'has', 'have', 'had', 'do', 'does', 'did', 'into', 'than', 'too', 'very',
  // Review filler. Two models describing the same defect rarely agree on these, and keeping
  // them dilutes the overlap that identifies the defect itself.
  'potential', 'possible', 'likely', 'missing', 'unchecked', 'unsafe', 'improper',
  'incorrect', 'invalid', 'cause', 'causes', 'issue', 'problem', 'bug',
]);

/**
 * Tokens used to decide whether two reviewers described the same defect. Identifiers are split
 * on camelCase and snake_case, because `emailDomain` and `email domain` are the same thing and
 * a model will pick either.
 */
export function findingTokens(title: string): string[] {
  const expanded = title
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return Array.from(new Set(
    expanded
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  ));
}

function overlap(a: readonly string[], b: readonly string[]): { shared: number; union: number } {
  if (a.length === 0 && b.length === 0) return { shared: 0, union: 0 };
  const setB = new Set(b);
  let shared = 0;
  for (const token of a) if (setB.has(token)) shared += 1;
  return { shared, union: a.length + b.length - shared };
}

/**
 * Two findings are the same when they point at the same place and describe it alike.
 *
 * Line numbers get a one-line window: models routinely disagree by one on where an added block
 * starts, and refusing to merge over that would hide real consensus. A file-level finding
 * (line 0) only matches another file-level finding.
 *
 * The defect class decides first. Two reviewers that both say `unchecked-response` at the same
 * place agree even when one wrote `Unchecked response status` and the other `HTTP errors parsed
 * as success`; and two different classes at the same line are two defects, whatever the titles.
 * Only when a reviewer left the class as `other` does title overlap decide: two distinguishing
 * terms and 40% overlap, which keeps `Missing null check` apart from `Missing error check`.
 */
export function isSameFinding(a: CouncilFinding, b: CouncilFinding): boolean {
  if (normalizeFilePath(a.file) !== normalizeFilePath(b.file)) return false;
  const sameLine = a.line === b.line
    || (a.line > 0 && b.line > 0 && Math.abs(a.line - b.line) === 1);
  if (!sameLine) return false;

  const kindA = a.kind ?? 'other';
  const kindB = b.kind ?? 'other';
  if (kindA !== 'other' && kindB !== 'other') return kindA === kindB;

  const { shared, union } = overlap(findingTokens(a.title), findingTokens(b.title));
  if (union === 0) return true;
  if (shared === union) return true;
  return shared >= 2 && shared / union >= 0.4;
}

interface FindingGroup {
  finding: CouncilFinding;
  reviewers: CouncilReviewer[];
  keys: Set<string>;
}

/**
 * Merge per-reviewer outcomes into consensus findings. Deduplication is file + line + a
 * similarity test on the title, so two genuinely different defects on the same line stay
 * separate while the same defect phrased differently by two models collapses into one.
 */
export function mergeCouncilOutcomes(outcomes: readonly CouncilOutcome[]): CouncilVerdict {
  const usable = outcomes.filter((o) => o.status === 'ok');
  const groups: FindingGroup[] = [];

  for (const outcome of usable) {
    const key = reviewerKey(outcome.reviewer);
    for (const finding of outcome.findings) {
      const existing = groups.find((g) => isSameFinding(g.finding, finding));
      if (!existing) {
        groups.push({ finding, reviewers: [outcome.reviewer], keys: new Set([key]) });
        continue;
      }
      if (!existing.keys.has(key)) {
        existing.keys.add(key);
        existing.reviewers.push(outcome.reviewer);
      }
      // Keep the most severe label and the most detailed explanation; never overwrite with less.
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.finding.severity]) {
        existing.finding = { ...existing.finding, severity: finding.severity };
      }
      if (finding.detail.length > existing.finding.detail.length) {
        existing.finding = { ...existing.finding, detail: finding.detail };
      }
      if (!existing.finding.suggestion && finding.suggestion) {
        existing.finding = { ...existing.finding, suggestion: finding.suggestion };
      }
    }
  }

  const findings: ConsensusFinding[] = groups.map((group) => {
    const tokens = findingTokens(group.finding.title).slice(0, 4);
    return {
      ...group.finding,
      id: `${group.finding.file}#${group.finding.line}#${tokens.join('-') || 'finding'}`,
      agreedBy: group.reviewers,
      agreement: group.keys.size,
      of: usable.length,
    };
  });

  findings.sort((a, b) => (
    b.agreement - a.agreement
    || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || a.file.localeCompare(b.file)
    || a.line - b.line
  ));

  return {
    findings,
    outcomes: [...outcomes],
    usableReviewers: usable.length,
    failedReviewers: outcomes.length - usable.length,
  };
}

/** The label the checklist shows, e.g. `[2/3 models agreed]`. */
export function formatConsensusLabel(agreement: number, of: number): string {
  return `[${agreement}/${of} models agreed]`;
}

export interface CouncilDiffFile {
  path: string;
  patch: string;
}

export interface CouncilBriefInput {
  files: readonly CouncilDiffFile[];
  /** Optional owner note, appended verbatim after the rules. */
  note?: string;
  maxChars?: number;
  maxFiles?: number;
}

const BRIEF_RULES = [
  'You are reviewing a code diff. Report only concrete defects you can point at in the diff:',
  'bugs, unhandled errors, security problems, data loss, or behaviour that contradicts the',
  "code's own intent. Do not report style preferences, naming taste, or praise. If you find",
  'nothing, return an empty findings array.',
  '',
  'Return JSON only, with no prose and no markdown fences, in exactly this shape:',
  '{"findings":[{"file":"path/as/in/diff","line":123,"kind":"unchecked-response",',
  '"severity":"blocker|major|minor|nit","title":"short label","detail":"what is wrong and why",',
  '"suggestion":"optional replacement code"}]}',
  '',
  'Rules:',
  '- "file" must be one of the paths listed below.',
  '- "line" is the line number in the new file; use 0 for a file-level finding.',
  '- "kind" must be exactly one of these, chosen by what is wrong, not by the wording:',
  `  ${COUNCIL_FINDING_KINDS.join(', ')}.`,
  '- Keep each "detail" under 400 characters.',
  '- Report at most 10 findings, most severe first.',
  '- Do not invent files, lines, or APIs that are not in the diff.',
];

/**
 * Build the same neutral brief for every reviewer. Identical text per reviewer is deliberate:
 * a council is only useful when the only variable is the model.
 */
export function buildCouncilBrief(input: CouncilBriefInput): string {
  const maxChars = input.maxChars ?? COUNCIL_DEFAULT_MAX_BRIEF_CHARS;
  const maxFiles = input.maxFiles ?? COUNCIL_DEFAULT_MAX_FILES;
  const parts: string[] = [...BRIEF_RULES];
  const note = input.note?.trim();
  if (note) parts.push('', 'Owner note:', note.slice(0, 2_000));
  parts.push('', 'Files in this diff:', ...input.files.slice(0, maxFiles).map((f) => `- ${f.path}`), '', 'Diff:');

  let body = '';
  let included = 0;
  for (const file of input.files.slice(0, maxFiles)) {
    const chunk = `${file.patch.startsWith('diff --git') ? '' : `diff --git a/${file.path} b/${file.path}\n`}${file.patch}\n`;
    if (body.length + chunk.length > maxChars) break;
    body += chunk;
    included += 1;
  }

  parts.push(body.trimEnd() || '(the diff is empty)');
  const omittedFiles = Math.max(0, input.files.length - included);
  if (omittedFiles > 0) {
    parts.push('', `[diff truncated: ${omittedFiles} more file(s) not shown]`);
  }
  return parts.join('\n');
}

/** Keep findings whose file actually appears in the diff; drop model inventions. */
export function dropUnknownFiles(
  findings: readonly CouncilFinding[],
  files: readonly CouncilDiffFile[],
): CouncilFinding[] {
  const known = new Set(files.map((f) => normalizeFilePath(f.path)));
  return findings.filter((finding) => known.has(normalizeFilePath(finding.file)));
}

export const COUNCIL_BLOCK_BEGIN = '# BEGIN cindy-council (managed by Cindy; this block is rewritten)';
export const COUNCIL_BLOCK_END = '# END cindy-council';

/** Render the managed block appended to `routing.yaml`. */
export function renderCouncilBlock(reviewers: readonly CouncilReviewer[]): string {
  const lines = [
    COUNCIL_BLOCK_BEGIN,
    'council:',
    '  reviewers:',
    ...reviewers.map((r) => `    - { provider: ${r.providerId}, model: ${JSON.stringify(r.model)} }`),
    COUNCIL_BLOCK_END,
  ];
  return lines.join('\n');
}

/**
 * Replace the managed block in place, or append it. Text-level, so the rest of the owner's
 * `routing.yaml` (comments, ordering, hand-written routes) is preserved byte for byte.
 */
export function applyCouncilBlock(text: string, reviewers: readonly CouncilReviewer[]): string {
  const block = renderCouncilBlock(reviewers);
  const start = text.indexOf(COUNCIL_BLOCK_BEGIN);
  const end = text.indexOf(COUNCIL_BLOCK_END);
  if (start !== -1 && end > start) {
    const after = end + COUNCIL_BLOCK_END.length;
    return `${text.slice(0, start)}${block}${text.slice(after)}`;
  }
  const base = text.replace(/\s+$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** Read the last-used selection back out of the managed block. */
export function readCouncilBlock(text: string): CouncilReviewer[] {
  const start = text.indexOf(COUNCIL_BLOCK_BEGIN);
  const end = text.indexOf(COUNCIL_BLOCK_END);
  if (start === -1 || end <= start) return [];
  const block = text.slice(start, end);
  const out: CouncilReviewer[] = [];
  for (const line of block.split('\n')) {
    const match = /^\s*-\s*\{\s*provider:\s*([^,\s]+)\s*,\s*model:\s*(?:"([^"]+)"|([^}\s]+))\s*\}/.exec(line);
    if (!match) continue;
    const providerId = match[1]?.trim() ?? '';
    const model = (match[2] ?? match[3] ?? '').trim();
    if (!providerId || !model) continue;
    out.push({ providerId, model });
    if (out.length >= COUNCIL_MAX_REVIEWERS) break;
  }
  return out;
}
