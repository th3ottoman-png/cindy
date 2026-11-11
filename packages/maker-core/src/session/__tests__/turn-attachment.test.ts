import { describe, expect, it } from 'vitest';

import {
  applyTurnAttachments,
  attachmentCandidatesFromCapabilities,
  attachmentToken,
  attachmentTokenId,
  describeTurnAttachments,
  findAttachmentTrigger,
  isAttachmentKindQuery,
  parseTurnAttachmentTokens,
  rankAttachmentCandidates,
  renderTurnAttachmentPreamble,
  resolveTurnAttachments,
  stripTurnAttachmentTokens,
  type TurnAttachmentCandidate,
} from '../turn-attachment';

const CANDIDATES: readonly TurnAttachmentCandidate[] = [
  { kind: 'expert', id: 'code-reviewer', title: 'Code Reviewer', source: '/experts/code-reviewer/expert.md' },
  { kind: 'expert', id: 'vault-researcher', title: 'Vault Researcher', source: '/experts/vault-researcher/expert.md' },
  {
    kind: 'skill',
    id: 'search_notes',
    title: 'search_notes',
    source: '/skills/search_notes/SKILL.md',
    tags: ['notes', 'search'],
  },
  { kind: 'skill', id: 'review-checklist', title: 'Review checklist', source: '/skills/review-checklist/SKILL.md' },
  {
    kind: 'connector',
    id: 'local-ollama',
    title: 'local-ollama',
    source: '/providers.yaml',
    subtitle: 'http://127.0.0.1:11434',
  },
  {
    kind: 'vault-note',
    id: 'Cindy/Chats/2026-11-08-review.md',
    title: '2026-11-08 review',
    source: '/vault/Cindy/Chats/2026-11-08-review.md',
  },
  {
    kind: 'skill',
    id: 'broken-skill',
    title: 'Broken skill',
    source: '/skills/broken-skill/SKILL.md',
    enabled: false,
  },
];

describe('findAttachmentTrigger', () => {
  it('fires on a bare @ at the end of the text', () => {
    expect(findAttachmentTrigger('review this @')).toEqual({
      start: 12,
      end: 13,
      query: '',
      kindHint: null,
      term: '',
    });
  });

  it('fires on a trailing token and keeps the query', () => {
    const trigger = findAttachmentTrigger('review this @sea');
    expect(trigger).not.toBeNull();
    expect(trigger?.term).toBe('sea');
    expect(trigger?.kindHint).toBeNull();
    expect(trigger?.start).toBe(12);
  });

  it('reads a kind hint before the colon', () => {
    const trigger = findAttachmentTrigger('@skill:sea');
    expect(trigger?.kindHint).toBe('skill');
    expect(trigger?.term).toBe('sea');
  });

  it('treats an unknown prefix as part of the term, not a kind', () => {
    const trigger = findAttachmentTrigger('@NotAKind:sea');
    expect(trigger?.kindHint).toBeNull();
    expect(trigger?.term).toBe('NotAKind:sea');
  });

  it('does not treat a spaced query as a trigger at all', () => {
    expect(findAttachmentTrigger('@Not A Kind:sea')).toBeNull();
  });

  it('ignores an email address', () => {
    expect(findAttachmentTrigger('mail me at turko@example.com')).toBeNull();
  });

  it('ignores a spaced query, which means the token already ended', () => {
    expect(findAttachmentTrigger('@skill:search_notes and then')).toBeNull();
  });

  it('ignores a query longer than the live window', () => {
    expect(findAttachmentTrigger(`@${'x'.repeat(80)}`)).toBeNull();
  });

  it('ignores text with no at sign', () => {
    expect(findAttachmentTrigger('plain prose')).toBeNull();
    expect(findAttachmentTrigger('')).toBeNull();
  });

  it('only looks at the last line', () => {
    expect(findAttachmentTrigger('@skill:search_notes\nplain prose')).toBeNull();
    const trigger = findAttachmentTrigger('first line\n@vault-note:Cindy');
    expect(trigger?.term).toBe('Cindy');
    expect(trigger?.kindHint).toBe('vault-note');
    expect(trigger?.start).toBe(11);
  });

  it('fires after an opening bracket or quote', () => {
    expect(findAttachmentTrigger('(@sea')).not.toBeNull();
    expect(findAttachmentTrigger('"@sea')).not.toBeNull();
  });
});

describe('rankAttachmentCandidates', () => {
  const trigger = (term: string, kindHint: string | null = null) => ({
    start: 0,
    end: term.length + 1,
    query: term,
    kindHint,
    term,
  });

  it('lists every enabled candidate for a bare @ in display order', () => {
    const ranked = rankAttachmentCandidates(CANDIDATES, trigger(''));
    expect(ranked.map((c) => `${c.kind}:${c.id}`)).toEqual([
      'expert:code-reviewer',
      'expert:vault-researcher',
      'skill:search_notes',
      'skill:review-checklist',
      'connector:local-ollama',
      'vault-note:Cindy/Chats/2026-11-08-review.md',
    ]);
  });

  it('never offers a disabled candidate', () => {
    const ranked = rankAttachmentCandidates(CANDIDATES, trigger('broken'));
    expect(ranked).toEqual([]);
  });

  it('filters by kind hint', () => {
    const ranked = rankAttachmentCandidates(CANDIDATES, trigger('re', 'skill'));
    expect(ranked.map((c) => c.id)).toEqual(['review-checklist']);
  });

  it('ranks an exact title first', () => {
    const ranked = rankAttachmentCandidates(CANDIDATES, trigger('search_notes'));
    expect(ranked[0].id).toBe('search_notes');
  });

  it('matches tags and subtitles', () => {
    expect(rankAttachmentCandidates(CANDIDATES, trigger('notes'))[0].id).toBe('search_notes');
    expect(rankAttachmentCandidates(CANDIDATES, trigger('11434'))[0].id).toBe('local-ollama');
  });

  it('respects the limit', () => {
    expect(rankAttachmentCandidates(CANDIDATES, trigger(''), 2)).toHaveLength(2);
  });

  it('returns nothing for an unmatched term', () => {
    expect(rankAttachmentCandidates(CANDIDATES, trigger('zzzznothing'))).toEqual([]);
  });
});

describe('isAttachmentKindQuery', () => {
  it('accepts a known attachable kind prefix', () => {
    expect(isAttachmentKindQuery('skill:sea')).toBe(true);
    expect(isAttachmentKindQuery('vault-note:Cindy')).toBe(true);
    expect(isAttachmentKindQuery('EXPERT:code')).toBe(true);
  });

  it('rejects a bare or unknown prefix', () => {
    expect(isAttachmentKindQuery('sea')).toBe(false);
    expect(isAttachmentKindQuery('')).toBe(false);
    expect(isAttachmentKindQuery('notakind:sea')).toBe(false);
    expect(isAttachmentKindQuery(':sea')).toBe(false);
  });
});

describe('token grammar', () => {
  it('builds a token from kind and id', () => {
    expect(attachmentToken({ kind: 'skill', id: 'search_notes' })).toBe('@skill:search_notes');
  });

  it('replaces whitespace in an id so the token stays one word', () => {
    expect(attachmentTokenId('Cindy/My Note.md')).toBe('Cindy/My-Note.md');
    expect(attachmentToken({ kind: 'vault-note', id: 'Cindy/My Note.md' })).toBe(
      '@vault-note:Cindy/My-Note.md',
    );
  });

  it('parses every token and reports exact spans', () => {
    const text = 'use @skill:search_notes then @note:Cindy/x.md';
    const tokens = parseTurnAttachmentTokens(text);
    expect(tokens.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'skill:search_notes',
      'note:Cindy/x.md',
    ]);
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe('@skill:search_notes');
    expect(text.slice(tokens[1].start, tokens[1].end)).toBe('@note:Cindy/x.md');
  });

  it('does not parse an email address', () => {
    expect(parseTurnAttachmentTokens('mail turko@example.com now')).toEqual([]);
  });

  it('drops trailing punctuation from the id', () => {
    const [token] = parseTurnAttachmentTokens('use @skill:search_notes, please');
    expect(token.id).toBe('search_notes');
    expect(token.end).toBe(4 + '@skill:search_notes'.length);
  });

  it('de-duplicates repeated tokens', () => {
    const tokens = parseTurnAttachmentTokens('@skill:a @skill:a');
    expect(tokens).toHaveLength(1);
  });

  it('parses a token at the very start of the text', () => {
    const [token] = parseTurnAttachmentTokens('@expert:code-reviewer');
    expect(token.start).toBe(0);
    expect(token.kind).toBe('expert');
  });
});

describe('stripTurnAttachmentTokens', () => {
  it('removes tokens and tidies the gaps', () => {
    expect(stripTurnAttachmentTokens('review @skill:search_notes this diff')).toBe(
      'review this diff',
    );
  });

  it('removes a token at the start and at the end', () => {
    expect(stripTurnAttachmentTokens('@skill:a review this @note:b')).toBe('review this');
  });

  it('leaves prose with no tokens untouched', () => {
    const text = 'plain prose, with punctuation.';
    expect(stripTurnAttachmentTokens(text)).toBe(text);
  });

  it('keeps the owner text when only a token was present', () => {
    expect(stripTurnAttachmentTokens('@skill:a')).toBe('');
  });
});

describe('renderTurnAttachmentPreamble', () => {
  it('returns an empty string for no attachments', () => {
    expect(renderTurnAttachmentPreamble([])).toBe('');
  });

  it('names the kind, the title, the source and the scope', () => {
    const preamble = renderTurnAttachmentPreamble([
      { kind: 'skill', id: 'search_notes', title: 'search_notes', source: '/skills/search_notes/SKILL.md' },
    ]);
    expect(preamble).toBe(
      '[Attached for this turn only: skill "search_notes" at /skills/search_notes/SKILL.md - read it and follow it for this turn. Nothing here changes the session.]',
    );
  });

  it('uses a neutral verb for an unknown kind', () => {
    const preamble = renderTurnAttachmentPreamble([
      { kind: 'quantum-widget', id: 'w', title: 'Widget', source: '/w' },
    ]);
    expect(preamble).toContain('quantum-widget "Widget" at /w - use it for this turn');
  });

  it('joins several attachments in one line', () => {
    const preamble = renderTurnAttachmentPreamble([
      { kind: 'skill', id: 'a', title: 'A', source: '/a' },
      { kind: 'vault-note', id: 'b', title: 'B', source: '/b' },
    ]);
    expect(preamble).toContain('; vault-note "B"');
    expect(preamble.split('\n')).toHaveLength(1);
  });

  it('de-duplicates and bounds the list', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      kind: 'skill',
      id: `s${index}`,
      title: `S${index}`,
      source: `/s${index}`,
    }));
    const preamble = renderTurnAttachmentPreamble([...many, many[0]]);
    expect(preamble).toContain('"S7"');
    expect(preamble).not.toContain('"S8"');
  });

  it('omits the source when it is unknown', () => {
    const preamble = renderTurnAttachmentPreamble([
      { kind: 'skill', id: 'a', title: 'A', source: '' },
    ]);
    expect(preamble).toContain('skill "A" - ');
  });
});

describe('applyTurnAttachments', () => {
  const skill = {
    kind: 'skill',
    id: 'search_notes',
    title: 'search_notes',
    source: '/skills/search_notes/SKILL.md',
  };

  it('is a no-op with no attachments', () => {
    expect(applyTurnAttachments('review @skill:search_notes', [])).toBe(
      'review @skill:search_notes',
    );
  });

  it('strips the token and prepends the preamble', () => {
    const out = applyTurnAttachments('review @skill:search_notes this diff', [skill]);
    expect(out.startsWith('[Attached for this turn only:')).toBe(true);
    expect(out).toContain('\n\nreview this diff');
    expect(out).not.toContain('@skill:search_notes');
  });

  it('keeps a leading slash command on the first line', () => {
    const out = applyTurnAttachments('/issue @skill:search_notes fix it', [skill]);
    // The command still starts the message, so command routing still matches it.
    expect(out.split('\n')[0]).toBe('/issue fix it');
    expect(out).toContain('[Attached for this turn only:');
    expect(out.split('\n')[0].startsWith('/issue')).toBe(true);
  });

  it('puts the preamble after a multi-line slash command body', () => {
    const out = applyTurnAttachments('/issue @skill:search_notes\nfix it', [skill]);
    expect(out.split('\n')[0]).toBe('/issue');
    expect(out).toContain('[Attached for this turn only:');
    expect(out).toContain('fix it');
  });

  it('returns only the preamble when the token was the whole message', () => {
    expect(applyTurnAttachments('@skill:search_notes', [skill])).toContain(
      'skill "search_notes"',
    );
    expect(applyTurnAttachments('@skill:search_notes', [skill])).not.toContain('\n\n');
  });

  it('leaves the projected text alone when no attachments remain', () => {
    const once = applyTurnAttachments('review @skill:search_notes', [skill]);
    expect(applyTurnAttachments(once, [])).toBe(once);
    expect(once).not.toContain('@skill:search_notes');
  });

  it('ROADMAP 11.1: preserveKinds leaves skill tokens for the pin resolver', () => {
    const out = applyTurnAttachments('review @skill:search_notes and @expert:alice this diff', [skill], {
      preserveKinds: ['skill'],
    });
    expect(out).toContain('@skill:search_notes');
    expect(out).not.toContain('@expert:alice');
    expect(out).toContain('[Attached for this turn only:');
  });

  it('ROADMAP 11.1: without preserveKinds all 8.4 tokens are still stripped', () => {
    const out = applyTurnAttachments('review @skill:search_notes this diff', [skill]);
    expect(out).not.toContain('@skill:search_notes');
  });
});

describe('capability mapping and resolution', () => {
  const descriptors = [
    {
      kind: 'expert',
      id: 'expert:code-reviewer',
      title: 'Code Reviewer',
      source: '/experts/code-reviewer/expert.md',
      trust: 'local-file' as const,
      declaredInterface: 'expert.md frontmatter',
      enabled: true,
    },
    {
      kind: 'plugin',
      id: 'plugin:hello',
      title: 'hello',
      source: '/plugins/hello',
      trust: 'local-file' as const,
      declaredInterface: 'extension plugin',
      enabled: true,
    },
    {
      kind: 'skill',
      id: 'skill:hidden',
      title: 'Hidden',
      source: '/skills/hidden/SKILL.md',
      trust: 'local-file' as const,
      declaredInterface: 'SKILL.md',
      enabled: true,
      visible: false,
    },
  ];

  it('keeps only attachable kinds and strips the kind prefix from the id', () => {
    const candidates = attachmentCandidatesFromCapabilities(descriptors);
    expect(candidates.map((c) => `${c.kind}:${c.id}`)).toEqual([
      'expert:code-reviewer',
      'skill:hidden',
    ]);
  });

  it('marks a hidden capability as not selectable', () => {
    const candidates = attachmentCandidatesFromCapabilities(descriptors);
    expect(candidates.find((c) => c.id === 'hidden')?.enabled).toBe(false);
  });

  it('resolves tokens to candidates and keeps unknown tokens as a bare reference', () => {
    const candidates = attachmentCandidatesFromCapabilities(descriptors);
    const tokens = parseTurnAttachmentTokens('@expert:code-reviewer @skill:ghost');
    const resolved = resolveTurnAttachments(tokens, candidates);
    expect(resolved).toEqual([
      {
        kind: 'expert',
        id: 'code-reviewer',
        title: 'Code Reviewer',
        source: '/experts/code-reviewer/expert.md',
      },
      { kind: 'skill', id: 'ghost', title: 'ghost', source: '' },
    ]);
  });
});

describe('describeTurnAttachments', () => {
  it('summarises the set', () => {
    expect(
      describeTurnAttachments([
        { kind: 'skill', id: 'a', title: 'A', source: '/a' },
        { kind: 'vault-note', id: 'b', title: 'B', source: '/b' },
      ]),
    ).toBe('skill A, vault-note B');
  });

  it('says so when nothing is attached', () => {
    expect(describeTurnAttachments([])).toBe('No turn attachments');
  });
});
