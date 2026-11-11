import { describe, expect, it } from 'vitest';

import {
  COUNCIL_MAX_FINDINGS_PER_REVIEWER,
  applyCouncilBlock,
  buildCouncilBrief,
  dropUnknownFiles,
  findingTokens,
  formatConsensusLabel,
  isSameFinding,
  mergeCouncilOutcomes,
  normalizeFilePath,
  normalizeSeverity,
  parseReviewerOutput,
  readCouncilBlock,
  renderCouncilBlock,
  reviewerKey,
  validateCouncilSelection,
  type CouncilFinding,
  type CouncilOutcome,
  type CouncilReviewer,
} from '../council-review.js';

const LOCAL: CouncilReviewer = { providerId: 'lmstudio-local', model: 'qwen3-8b' };
const API: CouncilReviewer = { providerId: 'tokenhub', model: 'hunyuan-t1' };
const THIRD: CouncilReviewer = { providerId: 'ollama-local', model: 'llama3.2' };
const AVAILABLE = [LOCAL, API, THIRD];

const finding = (over: Partial<CouncilFinding> = {}): CouncilFinding => ({
  file: 'src/app.ts',
  line: 10,
  severity: 'major',
  kind: 'other',
  title: 'Missing null check',
  detail: 'user may be undefined here',
  ...over,
});

const outcome = (
  reviewer: CouncilReviewer,
  findings: CouncilFinding[],
  status: 'ok' | 'failed' = 'ok',
): CouncilOutcome => ({
  reviewer,
  status,
  findings,
  ...(status === 'failed' ? { reason: 'unparseable' } : {}),
});

describe('validateCouncilSelection', () => {
  it('accepts one, two and three configured reviewers', () => {
    for (const selection of [[LOCAL], [LOCAL, API], [LOCAL, API, THIRD]]) {
      const result = validateCouncilSelection(selection, AVAILABLE);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.reviewers).toHaveLength(selection.length);
    }
  });

  it('rejects an empty selection, more than three, duplicates and unknown models', () => {
    expect(validateCouncilSelection([], AVAILABLE).errors).toContain('select at least one reviewer');
    expect(validateCouncilSelection([LOCAL, API, THIRD, LOCAL], AVAILABLE).errors).toContain(
      'at most 3 reviewers',
    );
    expect(validateCouncilSelection([LOCAL, LOCAL], AVAILABLE).errors).toContain(
      'lmstudio-local/qwen3-8b was selected twice',
    );
    expect(validateCouncilSelection([{ providerId: 'tokenhub', model: 'ghost' }], AVAILABLE).errors)
      .toContain('tokenhub/ghost is not a configured endpoint model');
  });

  it('rejects blank fields and non-list input without throwing', () => {
    expect(validateCouncilSelection([{ providerId: '  ', model: 'x' }], AVAILABLE).ok).toBe(false);
    expect(validateCouncilSelection(null, AVAILABLE).errors).toEqual(['reviewers must be a list']);
  });

  it('keys reviewers unambiguously even when the model contains a slash', () => {
    expect(reviewerKey({ providerId: 'a', model: 'b/c' })).toBe('a::b/c');
  });
});

describe('normalizeFilePath', () => {
  it('strips diff prefixes and unifies separators', () => {
    expect(normalizeFilePath('a/src/App.ts')).toBe('src/app.ts');
    expect(normalizeFilePath('b/src\\App.ts')).toBe('src/app.ts');
    expect(normalizeFilePath('./src/App.ts')).toBe('src/app.ts');
    expect(normalizeFilePath('  src/App.ts  ')).toBe('src/app.ts');
  });
});

describe('parseReviewerOutput', () => {
  it('parses a plain JSON object', () => {
    const result = parseReviewerOutput(JSON.stringify({
      findings: [{ file: 'src/app.ts', line: 4, severity: 'blocker', kind: 'null-deref', title: 'Null deref', detail: 'x' }],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([{
      file: 'src/app.ts',
      line: 4,
      severity: 'blocker',
      kind: 'null-deref',
      title: 'Null deref',
      detail: 'x',
    }]);
  });

  it('defaults an unknown or missing kind to other', () => {
    const result = parseReviewerOutput(JSON.stringify({
      findings: [
        { file: 'a.ts', line: 1, title: 'no kind', detail: 'd' },
        { file: 'a.ts', line: 2, title: 'odd kind', detail: 'd', kind: 'weird-thing' },
        { file: 'a.ts', line: 3, title: 'synonym', detail: 'd', kind: 'HTTP Error' },
      ],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings.map((f) => f.kind)).toEqual(['other', 'other', 'unchecked-response']);
  });

  it('parses a fenced JSON block and a bare array', () => {
    const fenced = parseReviewerOutput('Here you go:\n```json\n{"findings":[]}\n```');
    expect(fenced).toEqual({ ok: true, findings: [] });
    const bare = parseReviewerOutput('[{"file":"a.ts","line":1,"title":"t","detail":"d"}]');
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.findings).toHaveLength(1);
  });

  it('recovers JSON wrapped in prose', () => {
    const result = parseReviewerOutput(
      'I reviewed it. {"findings":[{"file":"a.ts","line":2,"title":"Bug","detail":"d"}]} Done.',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.findings[0]?.line).toBe(2);
  });

  it('treats prose-only, empty and wrong-shape replies as failures, never as silence', () => {
    expect(parseReviewerOutput('Looks fine to me.')).toEqual({ ok: false, reason: 'unparseable' });
    expect(parseReviewerOutput('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseReviewerOutput('{"summary":"no issues"}')).toEqual({
      ok: false,
      reason: 'no-findings-shape',
    });
  });

  it('drops items with no file and coerces missing or odd fields', () => {
    const result = parseReviewerOutput(JSON.stringify({
      findings: [
        { title: 'no file', detail: 'dropped' },
        { file: 'b.ts', line: '7', severity: 'critical', message: 'from message' },
        { file: 'c.ts', severity: 'nonsense', title: 'kept', detail: 'd' },
      ],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ file: 'b.ts', line: 7, severity: 'blocker' });
    expect(result.findings[0]?.title).toBe('from message');
    expect(result.findings[1]?.severity).toBe('minor');
  });

  it('caps findings per reviewer so one runaway reply cannot flood the checklist', () => {
    const many = Array.from({ length: COUNCIL_MAX_FINDINGS_PER_REVIEWER + 15 }, (_, i) => ({
      file: 'a.ts',
      line: i + 1,
      title: `issue ${i}`,
      detail: 'd',
    }));
    const result = parseReviewerOutput(JSON.stringify({ findings: many }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.findings).toHaveLength(COUNCIL_MAX_FINDINGS_PER_REVIEWER);
  });

  it('maps severity synonyms onto the four tiers', () => {
    expect(normalizeSeverity('CRITICAL')).toBe('blocker');
    expect(normalizeSeverity('medium')).toBe('major');
    expect(normalizeSeverity('warning')).toBe('minor');
    expect(normalizeSeverity('style')).toBe('nit');
    expect(normalizeSeverity(undefined)).toBe('minor');
  });
});

describe('dropUnknownFiles', () => {
  it('keeps findings in the diff and drops invented paths', () => {
    const kept = dropUnknownFiles(
      [finding({ file: 'src/app.ts' }), finding({ file: 'src/ghost.ts' })],
      [{ path: 'src/app.ts', patch: '' }],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.file).toBe('src/app.ts');
  });
});

describe('mergeCouncilOutcomes', () => {
  it('collapses the same finding from two models into one consensus row', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding()]),
      outcome(API, [finding({ title: 'Missing a null check', severity: 'blocker' })]),
    ]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ agreement: 2, of: 2, severity: 'blocker' });
    expect(verdict.findings[0]?.agreedBy.map(reviewerKey)).toEqual([reviewerKey(LOCAL), reviewerKey(API)]);
    expect(formatConsensusLabel(2, 2)).toBe('[2/2 models agreed]');
  });

  it('excludes a failed reviewer from the denominator', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding()]),
      outcome(API, [finding()]),
      outcome(THIRD, [], 'failed'),
    ]);
    expect(verdict.usableReviewers).toBe(2);
    expect(verdict.failedReviewers).toBe(1);
    expect(verdict.findings[0]).toMatchObject({ agreement: 2, of: 2 });
  });

  it('keeps two genuinely different defects on the same line separate', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [
        finding({ title: 'Missing null check', detail: 'a' }),
        finding({ title: 'SQL injection in query', detail: 'b' }),
      ]),
    ]);
    expect(verdict.findings).toHaveLength(2);
    expect(verdict.findings.every((f) => f.agreement === 1)).toBe(true);
  });

  it('does not merge the same title at a distant line or a different file', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding({ line: 10 })]),
      outcome(API, [finding({ line: 14 })]),
      outcome(THIRD, [finding({ file: 'src/other.ts', line: 10 })]),
    ]);
    expect(verdict.findings).toHaveLength(3);
  });

  it('merges when two models disagree by one line on where the block starts', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding({ line: 16 })]),
      outcome(API, [finding({ line: 17 })]),
    ]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ agreement: 2, of: 2 });
  });

  it('merges the same defect phrased with an identifier instead of words', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding({ line: 12, title: 'Potential crash in emailDomain' })]),
      outcome(API, [finding({ line: 12, title: 'Crash on email without @' })]),
    ]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ agreement: 2, of: 2 });
  });

  it('merges a long title against a short one that shares two distinguishing terms', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding({ line: 12, title: 'Unsafe array access in emailDomain' })]),
      outcome(API, [finding({ line: 12, title: 'emailDomain throws on missing @' })]),
    ]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ agreement: 2, of: 2 });
  });

  it('does not merge two different defects that share only a filler word', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding({ line: 3, title: 'Missing null check' })]),
      outcome(API, [finding({ line: 3, title: 'Missing error check' })]),
    ]);
    expect(verdict.findings).toHaveLength(2);
  });

  it('merges on the defect class even when the wording shares nothing', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding({ line: 17, kind: 'unchecked-response', title: 'Unchecked response status' })]),
      outcome(API, [finding({ line: 17, kind: 'unchecked-response', title: 'HTTP errors parsed as success' })]),
    ]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ agreement: 2, of: 2, kind: 'unchecked-response' });
  });

  it('keeps two different defect classes on the same line apart even with similar titles', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding({ line: 9, kind: 'null-deref', title: 'Null check missing on user' })]),
      outcome(API, [finding({ line: 9, kind: 'unsafe-cast', title: 'Null check missing on user' })]),
    ]);
    expect(verdict.findings).toHaveLength(2);
  });

  it('ranks by agreement, then severity, and keeps the longest explanation', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [
        finding({ line: 1, title: 'only one model saw this', severity: 'blocker' }),
        finding({ line: 2, title: 'everyone saw this', severity: 'minor', detail: 'short' }),
      ]),
      outcome(API, [finding({ line: 2, title: 'everyone saw this', severity: 'minor', detail: 'a much longer explanation' })]),
      outcome(THIRD, [finding({ line: 2, title: 'everyone saw this', severity: 'minor', detail: 'mid length text' })]),
    ]);
    expect(verdict.findings.map((f) => f.line)).toEqual([2, 1]);
    expect(verdict.findings[0]?.detail).toBe('a much longer explanation');
    expect(verdict.findings[0]?.agreement).toBe(3);
  });

  it('fills a missing suggestion from another reviewer without overwriting one', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [finding()]),
      outcome(API, [finding({ suggestion: 'if (!user) return;' })]),
    ]);
    expect(verdict.findings[0]?.suggestion).toBe('if (!user) return;');
  });

  it('returns no findings when every reviewer failed, and says so', () => {
    const verdict = mergeCouncilOutcomes([
      outcome(LOCAL, [], 'failed'),
      outcome(API, [], 'failed'),
    ]);
    expect(verdict.findings).toEqual([]);
    expect(verdict.usableReviewers).toBe(0);
    expect(verdict.failedReviewers).toBe(2);
  });
});

describe('isSameFinding and findingTokens', () => {
  it('ignores stopwords, splits identifiers and ignores word order', () => {
    expect(findingTokens('Missing a null check')).toEqual(['null', 'check']);
    expect(findingTokens('crash in emailDomain')).toEqual(['crash', 'email', 'domain']);
    expect(findingTokens('crash in email_domain')).toEqual(['crash', 'email', 'domain']);
    expect(isSameFinding(finding({ title: 'null check missing' }), finding({ title: 'Missing null check' })))
      .toBe(true);
  });

  it('treats unrelated titles as different', () => {
    expect(isSameFinding(finding({ title: 'missing null check' }), finding({ title: 'wrong colour' })))
      .toBe(false);
  });
});

describe('buildCouncilBrief', () => {
  const files = [
    { path: 'src/app.ts', patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b' },
    { path: 'src/b.ts', patch: 'diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-c\n+d' },
  ];

  it('is identical for every reviewer and names every file', () => {
    const a = buildCouncilBrief({ files });
    const b = buildCouncilBrief({ files });
    expect(a).toBe(b);
    expect(a).toContain('- src/app.ts');
    expect(a).toContain('- src/b.ts');
    expect(a).toContain('Return JSON only');
    expect(a).toContain('Do not invent files');
    expect(a).toContain('+b');
  });

  it('carries the owner note verbatim but bounded', () => {
    const brief = buildCouncilBrief({ files, note: 'Focus on the retry path.' });
    expect(brief).toContain('Owner note:\nFocus on the retry path.');
  });

  it('truncates at the character budget and says how many files were withheld', () => {
    const big = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.ts`,
      patch: `diff --git a/f${i}.ts b/f${i}.ts\n${'x'.repeat(500)}`,
    }));
    const brief = buildCouncilBrief({ files: big, maxChars: 1_200 });
    expect(brief).toMatch(/\[diff truncated: \d+ more file\(s\) not shown\]/);
  });

  it('handles an empty diff honestly', () => {
    expect(buildCouncilBrief({ files: [] })).toContain('(the diff is empty)');
  });
});

describe('routing.yaml persistence', () => {
  const routing = [
    '# owner comment',
    'routes:',
    '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
    'rules:',
    '  title: local-small',
    '',
  ].join('\n');

  it('appends a managed block and preserves the rest byte for byte', () => {
    const next = applyCouncilBlock(routing, [LOCAL, API]);
    expect(next.startsWith('# owner comment\nroutes:')).toBe(true);
    expect(next).toContain('council:');
    expect(next).toContain('{ provider: lmstudio-local, model: "qwen3-8b" }');
    expect(next).toContain('{ provider: tokenhub, model: "hunyuan-t1" }');
  });

  it('replaces the block instead of stacking a second copy', () => {
    const once = applyCouncilBlock(routing, [LOCAL, API]);
    const twice = applyCouncilBlock(once, [THIRD]);
    expect(twice.match(/BEGIN cindy-council/g)).toHaveLength(1);
    expect(twice).not.toContain('tokenhub');
    expect(twice).toContain('ollama-local');
  });

  it('round-trips through the block it wrote', () => {
    const block = renderCouncilBlock([LOCAL, API]);
    expect(block).toContain('council:\n  reviewers:');
    expect(readCouncilBlock(block)).toEqual([LOCAL, API]);
    expect(readCouncilBlock(applyCouncilBlock(routing, [THIRD]))).toEqual([THIRD]);
  });

  it('returns an empty selection for text with no council block', () => {
    expect(readCouncilBlock(routing)).toEqual([]);
    expect(readCouncilBlock('')).toEqual([]);
  });
});
