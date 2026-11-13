/**
 * Expert form (ROADMAP 12.2): the New-agent form ⇄ expert.md contract, the concurrency
 * cap check, and the starter-expert vocabulary. Pure — no I/O except the starter sync test.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  expertFormToMarkdown,
  expertSlugFromName,
  markdownToExpertForm,
} from '../expert-form';
import {
  STARTER_EXPERT_SLUGS,
  checkExpertConcurrency,
  isStarterExpert,
  loadExperts,
} from '../expert-loader';

const FORM_MD = [
  '---',
  'name: Form Agent',
  'description: Does form things.',
  'agent: claude-code',
  'model: local-small',
  'max_concurrent: 3',
  'memory: false',
  '---',
  '',
  'You are a form agent.',
  '',
].join('\n');

describe('markdownToExpertForm / expertFormToMarkdown', () => {
  it('parses every form field out of expert.md', () => {
    const fields = markdownToExpertForm(FORM_MD);
    expect(fields).toEqual({
      name: 'Form Agent',
      description: 'Does form things.',
      agent: 'claude-code',
      model: 'local-small',
      maxConcurrent: 3,
      prompt: '\nYou are a form agent.\n',
    });
  });

  it('round-trips fields through markdown unchanged', () => {
    const fields = markdownToExpertForm(FORM_MD);
    const again = markdownToExpertForm(expertFormToMarkdown(fields));
    expect(again).toEqual(fields);
  });

  it('keeps unknown frontmatter keys and the body byte-identical on re-render', () => {
    const withExtras = '---\nname: X\ndescription: D.\nagent: hermes\ncustom_key: keep-me\ntags: [a, b]\n---\n\nBody  with   spacing.\n';
    const fields = markdownToExpertForm(withExtras);
    const rendered = expertFormToMarkdown(fields, withExtras);
    expect(rendered).toContain('custom_key: keep-me');
    expect(rendered).toContain('- a');
    // The body after the frontmatter is byte-identical.
    const bodyOf = (md: string): string => md.split(/^---\s*$/m).slice(2).join('---');
    expect(bodyOf(rendered)).toBe(bodyOf(withExtras));
    expect(markdownToExpertForm(rendered)).toEqual(fields);
  });

  it('renders a fresh file without a base, defaulting max_concurrent away', () => {
    const md = expertFormToMarkdown({
      name: 'New',
      description: 'D.',
      agent: 'hermes',
      prompt: 'Body.',
    });
    expect(md).toContain('name: New');
    expect(md).toContain('agent: hermes');
    expect(md).toContain('memory: false');
    expect(md).not.toContain('max_concurrent');
    expect(md).not.toContain('model:');
    expect(md.endsWith('Body.')).toBe(true);
  });

  it('writes max_concurrent only above 1 and drops model when cleared', () => {
    const base = FORM_MD;
    const fields = { ...markdownToExpertForm(base), model: undefined, maxConcurrent: 1 };
    const md = expertFormToMarkdown(fields, base);
    expect(md).not.toContain('max_concurrent');
    expect(md).not.toContain('model:');
    expect(md).toContain('agent: claude-code');
  });

  it('defaults missing or invalid frontmatter to safe form values', () => {
    const fields = markdownToExpertForm('---\nname: X\nagent: bogus\nmax_concurrent: 0\n---\nBody.');
    expect(fields.agent).toBe('hermes');
    expect(fields.maxConcurrent).toBeUndefined();
    expect(fields.model).toBeUndefined();
  });
});

describe('expertSlugFromName', () => {
  it('derives kebab-case slugs the draft validator accepts', () => {
    expect(expertSlugFromName('Code Reviewer')).toBe('code-reviewer');
    expect(expertSlugFromName('  UK  Cold Email!  ')).toBe('uk-cold-email');
    expect(expertSlugFromName('!!!')).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    expect(expertSlugFromName('a')).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    expect(expertSlugFromName('N'.repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe('checkExpertConcurrency (ROADMAP 12.2)', () => {
  const running = [{ sessionId: '644dda60-2bb6-4557-8c2a-f4ec77f00f0d', title: 'First chat' }];

  it('defaults to one conversation at once', () => {
    expect(checkExpertConcurrency('X', undefined, [])).toEqual({ ok: true });
    const refused = checkExpertConcurrency('X', undefined, running);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain('X');
      expect(refused.message).toContain('First chat');
      expect(refused.message).toContain('max_concurrent');
    }
  });

  it('allows up to the cap and refuses at it, naming every running session', () => {
    const two = [...running, { sessionId: 'aaaaaaaa-bbbb', title: null }];
    expect(checkExpertConcurrency('X', 2, running)).toEqual({ ok: true });
    const refused = checkExpertConcurrency('X', 2, two);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain('First chat');
      expect(refused.message).toContain('aaaaaaaa');
    }
  });

  it('falls back to the session id when there is no title', () => {
    const refused = checkExpertConcurrency('X', 1, [{ sessionId: 'abcdef12-3456' }]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('abcdef12');
  });
});

describe('starter expert vocabulary (ROADMAP 12.2)', () => {
  it('matches the shipped docs/experts-examples directories exactly', () => {
    const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/experts-examples');
    const shipped = fs.readdirSync(examples)
      .filter((n) => !n.startsWith('.') && fs.statSync(path.join(examples, n)).isDirectory())
      .sort();
    expect([...STARTER_EXPERT_SLUGS].sort()).toEqual(shipped);
    expect(loadExperts(examples).every((e) => !e.error)).toBe(true);
  });

  it('recognizes starter slugs only', () => {
    expect(isStarterExpert('code-reviewer')).toBe(true);
    expect(isStarterExpert('historian')).toBe(false);
  });
});
