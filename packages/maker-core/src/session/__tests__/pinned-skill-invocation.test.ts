import { describe, expect, it } from 'vitest';

import {
  MAX_PINNED_CHARS,
  MAX_PINNED_SKILLS,
  applyPinnedSkills,
  parsePinnedSkillTokens,
  renderPinnedSkillPreamble,
  type PinnedSkillInstructions,
} from '../pinned-skill-invocation';

const KNOWN = ['git-worktree', 'code-review', 'web-scraper'];

function pinned(slug: string, body = `# ${slug}\nFull procedure for ${slug}.\n`): PinnedSkillInstructions {
  return { slug, name: slug, instructions: body, truncated: false, availableScripts: [], availableReferences: [] };
}

describe('parsePinnedSkillTokens', () => {
  it('finds @skill:<slug> tokens only for installed skills', () => {
    const tokens = parsePinnedSkillTokens('review @skill:git-worktree and @skill:missing', KNOWN);
    expect(tokens.map((t) => t.slug)).toEqual(['git-worktree']);
    expect(tokens[0].raw).toBe('@skill:git-worktree');
  });

  it('finds a /name pin only when the name is an installed skill', () => {
    const tokens = parsePinnedSkillTokens('/git-worktree please isolate', KNOWN);
    expect(tokens.map((t) => t.slug)).toEqual(['git-worktree']);
  });

  it('never hijacks a real slash command or a filesystem path', () => {
    expect(parsePinnedSkillTokens('/issue fix the bug', KNOWN)).toEqual([]);
    expect(parsePinnedSkillTokens('/model claude', KNOWN)).toEqual([]);
    expect(parsePinnedSkillTokens('read /Users/me/git-worktree/file.ts', KNOWN)).toEqual([]);
  });

  it('does not parse email addresses or prose containing a colon', () => {
    expect(parsePinnedSkillTokens('mail me@example.com @skill:code-review', KNOWN).map((t) => t.slug)).toEqual([
      'code-review',
    ]);
  });

  it('deduplicates repeated pins, preserving order', () => {
    const tokens = parsePinnedSkillTokens('/web-scraper\nreview @skill:code-review @skill:code-review', KNOWN);
    expect(tokens.map((t) => t.slug)).toEqual(['web-scraper', 'code-review']);
  });

  it('is case-insensitive on the slug', () => {
    expect(parsePinnedSkillTokens('@skill:Git-Worktree', KNOWN).map((t) => t.slug)).toEqual(['git-worktree']);
  });

  it('caps the number of pins', () => {
    const many = Array.from({ length: MAX_PINNED_SKILLS + 5 }, (_, i) => `skill-${i}`);
    const text = many.map((s) => `@skill:${s}`).join(' ');
    expect(parsePinnedSkillTokens(text, many)).toHaveLength(MAX_PINNED_SKILLS);
  });

  it('returns nothing when no catalog is available', () => {
    expect(parsePinnedSkillTokens('@skill:git-worktree', [])).toEqual([]);
  });
});

describe('renderPinnedSkillPreamble', () => {
  it('returns an empty string with no pins', () => {
    expect(renderPinnedSkillPreamble([])).toBe('');
  });

  it('injects the full body plus asset paths, bounded', () => {
    const text = renderPinnedSkillPreamble([
      {
        ...pinned('git-worktree'),
        availableScripts: ['scripts/add.sh'],
        availableReferences: ['references/notes.md'],
      },
    ]);
    expect(text).toContain('<pinned_skills>');
    expect(text).toContain('Full procedure for git-worktree.');
    expect(text).toContain('scripts/add.sh');
    expect(text).toContain('references/notes.md');
    expect(text).toContain('</pinned_skills>');
    expect(text.length).toBeLessThanOrEqual(MAX_PINNED_CHARS);
  });

  it('marks a truncated skill explicitly', () => {
    const text = renderPinnedSkillPreamble([{ ...pinned('big'), truncated: true }]);
    expect(text).toContain('[Truncated: skill file exceeds 32KB]');
  });
});

describe('applyPinnedSkills', () => {
  it('injects the full body and strips the token for that turn only', () => {
    const out = applyPinnedSkills('review @skill:git-worktree this diff', [pinned('git-worktree')]);
    expect(out).toContain('<pinned_skills>');
    expect(out).toContain('Full procedure for git-worktree.');
    expect(out).not.toContain('@skill:git-worktree');
    expect(out).toContain('review this diff');
  });

  it('supports the /name form', () => {
    const out = applyPinnedSkills('/git-worktree isolate it', [pinned('git-worktree')]);
    expect(out).toContain('Full procedure for git-worktree.');
    expect(out).not.toContain('/git-worktree');
  });

  it('is a no-op with no resolved pins', () => {
    const text = 'review @skill:git-worktree this diff';
    expect(applyPinnedSkills(text, [])).toBe(text);
  });

  it('fails closed for chat-only sessions', () => {
    const text = 'review @skill:git-worktree';
    expect(applyPinnedSkills(text, [pinned('git-worktree')], { chatOnly: true })).toBe(text);
  });

  it('keeps a leading slash command on the first line', () => {
    const out = applyPinnedSkills('/issue @skill:code-review fix it', [pinned('code-review')]);
    expect(out.split('\n')[0]).toBe('/issue fix it');
    expect(out).toContain('<pinned_skills>');
  });

  it('is idempotent when applied twice', () => {
    const once = applyPinnedSkills('review @skill:git-worktree', [pinned('git-worktree')]);
    expect(applyPinnedSkills(once, [])).toBe(once);
  });

  it('leaves unknown pins visible in the text rather than silently dropping them', () => {
    const out = applyPinnedSkills('use @skill:missing here', [pinned('git-worktree')]);
    expect(out).toContain('@skill:missing');
  });
});
