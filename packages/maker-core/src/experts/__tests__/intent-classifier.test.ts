import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INTENT_RULES,
  MIN_PROMPT_CHARS,
  suggestExpertForPrompt,
  type ExpertSuggestionCandidate,
  type IntentRule,
} from '../intent-classifier';

const INSTALLED: readonly ExpertSuggestionCandidate[] = [
  { slug: 'code-reviewer', name: 'Code Reviewer', tags: ['code', 'review'] },
  {
    slug: 'vault-researcher',
    name: 'Vault Researcher',
    tags: ['notes', 'vault', 'obsidian', 'search', 'memory', 'graph', 'capture'],
  },
];

describe('suggestExpertForPrompt — code review intent', () => {
  it('recommends Code Reviewer for a git diff / regression prompt', () => {
    const result = suggestExpertForPrompt(
      'Please review this git diff and check for a regression bug',
      INSTALLED,
    );
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('code-reviewer');
    expect(result!.name).toBe('Code Reviewer');
    expect(result!.label).toBe('Code Review');
    expect(result!.score).toBeGreaterThanOrEqual(3);
    expect(result!.matched).toContain('git diff');
    expect(result!.matched).toContain('regression');
    expect(result!.matched).toContain('review');
  });

  it('matches a PR number through a RegExp signal', () => {
    const result = suggestExpertForPrompt('Can you check PR #42 for me?', INSTALLED);
    expect(result?.slug).toBe('code-reviewer');
    expect(result?.matched.some((label) => label.includes('pr'))).toBe(true);
  });

  it('is case insensitive', () => {
    const lower = suggestExpertForPrompt('REVIEW THIS GIT DIFF', INSTALLED);
    const upper = suggestExpertForPrompt('review this git diff', INSTALLED);
    expect(lower?.slug).toBe('code-reviewer');
    expect(lower).toEqual(upper);
  });

  it('matches multi-word phrases when whitespace varies', () => {
    const result = suggestExpertForPrompt('please handle the   git    diff today', INSTALLED);
    expect(result?.slug).toBe('code-reviewer');
    expect(result?.matched).toContain('git diff');
  });
});

describe('suggestExpertForPrompt — vault research intent', () => {
  it('recommends Vault Researcher for a vault / backlink prompt', () => {
    const result = suggestExpertForPrompt(
      'Search my vault notes for backlinks about the Cindy project',
      INSTALLED,
    );
    expect(result?.slug).toBe('vault-researcher');
    expect(result?.label).toBe('Vault Research');
    expect(result?.matched).toContain('backlinks');
    expect(result?.matched).toContain('vault');
  });

  it('recommends Vault Researcher for a "what did I write" recall prompt', () => {
    const result = suggestExpertForPrompt('What did I write about the roadmap in my notes?', INSTALLED);
    expect(result?.slug).toBe('vault-researcher');
  });

  it('prefers the higher-scoring intent when both intents are present', () => {
    const result = suggestExpertForPrompt(
      'Review this git diff, fix the regression bug, then save a note in my vault',
      INSTALLED,
    );
    expect(result?.slug).toBe('code-reviewer');
  });
});

describe('suggestExpertForPrompt — quiet by default', () => {
  it.each(['', '   ', 'hi', 'TODO'])('returns null for "%s"', (prompt) => {
    expect(suggestExpertForPrompt(prompt, INSTALLED)).toBeNull();
  });

  it('returns null for an unrelated prompt', () => {
    expect(suggestExpertForPrompt('Tell me a joke about a rubber duck', INSTALLED)).toBeNull();
    expect(suggestExpertForPrompt('hello there, how are you today?', INSTALLED)).toBeNull();
  });

  it('does not match signals inside longer words (whole-token only)', () => {
    expect(suggestExpertForPrompt('preview the different layouts', INSTALLED, { minScore: 1 })).toBeNull();
  });

  it('stays quiet below the score threshold', () => {
    const bare = [{ slug: 'code-reviewer', name: 'Code Reviewer' }];
    expect(suggestExpertForPrompt('please do an audit for me', bare)).toBeNull();
    expect(suggestExpertForPrompt('please do an audit for me', bare, { minScore: 1 })?.slug).toBe(
      'code-reviewer',
    );
  });

  it('honours a caller-supplied minPromptChars', () => {
    expect(suggestExpertForPrompt('bug fix', INSTALLED)).toBeNull();
    expect(suggestExpertForPrompt('bug fix', INSTALLED, { minPromptChars: 0 })?.slug).toBe(
      'code-reviewer',
    );
  });
});

describe('suggestExpertForPrompt — installed experts are the boundary', () => {
  it('returns null when no experts are installed', () => {
    expect(suggestExpertForPrompt('review this git diff', [])).toBeNull();
  });

  it('never suggests an expert that is not installed', () => {
    const vaultOnly = INSTALLED.filter((e) => e.slug === 'vault-researcher');
    expect(suggestExpertForPrompt('review this git diff', vaultOnly)).toBeNull();
    const codeOnly = INSTALLED.filter((e) => e.slug === 'code-reviewer');
    expect(suggestExpertForPrompt('search my vault notes for backlinks', codeOnly)).toBeNull();
  });

  it('ignores malformed candidates', () => {
    const malformed = [null, undefined, { slug: '', name: '' }] as unknown as ExpertSuggestionCandidate[];
    expect(suggestExpertForPrompt('review this git diff', malformed)).toBeNull();
  });

  it('suppresses an expert already selected for the draft', () => {
    expect(
      suggestExpertForPrompt('review this git diff', INSTALLED, { excludeSlug: 'code-reviewer' }),
    ).toBeNull();
    expect(
      suggestExpertForPrompt('review this git diff', INSTALLED, { excludeSlug: 'vault-researcher' })
        ?.slug,
    ).toBe('code-reviewer');
  });

  it('falls back to the slug when the name is blank', () => {
    const rules: readonly IntentRule[] = [
      { slug: 'x', label: 'X', strongPatterns: ['git diff'] },
    ];
    expect(suggestExpertForPrompt('review this git diff', [{ slug: 'x', name: '' }], { rules })?.name).toBe('x');
  });
});

describe('suggestExpertForPrompt — purity and extensibility', () => {
  it('is deterministic across repeated calls', () => {
    const prompt = 'Please review this git diff and check for a regression bug';
    const first = suggestExpertForPrompt(prompt, INSTALLED);
    const second = suggestExpertForPrompt(prompt, INSTALLED);
    const third = suggestExpertForPrompt(prompt, INSTALLED);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('does not mutate or write to its inputs', () => {
    const frozenExperts = Object.freeze([
      Object.freeze({ slug: 'code-reviewer', name: 'Code Reviewer', tags: Object.freeze(['code', 'review']) }),
    ]) as unknown as readonly ExpertSuggestionCandidate[];
    expect(() => suggestExpertForPrompt('review this git diff', frozenExperts)).not.toThrow();
    expect(frozenExperts[0].slug).toBe('code-reviewer');
  });

  it('clones caller RegExp rules so lastIndex never leaks between calls', () => {
    const rules: readonly IntentRule[] = [
      { slug: 'code-reviewer', label: 'Code Review', strongPatterns: [/git diff/g] },
    ];
    const run = () => suggestExpertForPrompt('review this git diff', INSTALLED, { rules });
    expect(run()?.slug).toBe('code-reviewer');
    expect(run()?.slug).toBe('code-reviewer');
    expect(run()?.slug).toBe('code-reviewer');
  });

  it('accepts caller-supplied rules without editing a central switch', () => {
    const rules: readonly IntentRule[] = [
      { slug: 'deploy-bot', label: 'Deployment', strongPatterns: ['ship to prod', 'deploy'] },
    ];
    const installed = [{ slug: 'deploy-bot', name: 'Deploy Bot' }];
    const result = suggestExpertForPrompt('please deploy to prod', installed, { rules });
    expect(result?.slug).toBe('deploy-bot');
    expect(result?.label).toBe('Deployment');
    expect(suggestExpertForPrompt('review this git diff', installed, { rules })).toBeNull();
  });

  it('breaks score ties by rule order', () => {
    const rules: readonly IntentRule[] = [
      { slug: 'a', label: 'A', strongPatterns: ['shared'] },
      { slug: 'b', label: 'B', strongPatterns: ['shared'] },
    ];
    const installed = [
      { slug: 'a', name: 'A' },
      { slug: 'b', name: 'B' },
    ];
    expect(suggestExpertForPrompt('shared signal', installed, { rules })?.slug).toBe('a');
  });

  it('deduplicates matched signal labels', () => {
    const result = suggestExpertForPrompt('please review this', INSTALLED);
    expect(result).not.toBeNull();
    expect(new Set(result!.matched).size).toBe(result!.matched.length);
  });

  it('ships the two default intents and the exported minimums', () => {
    expect(DEFAULT_INTENT_RULES.map((rule) => rule.slug)).toEqual([
      'code-reviewer',
      'vault-researcher',
    ]);
    expect(MIN_PROMPT_CHARS).toBe(8);
  });
});
