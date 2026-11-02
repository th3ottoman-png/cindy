import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ExpertEntry } from '@cindy/maker-core/experts';

import {
  ExpertListView,
  decideExternalChange,
  fieldsFromForm,
  formFromFields,
  uniqueExpertSlug,
} from '../ExpertsSection';

const entry = (
  slug: string,
  extra: Partial<NonNullable<ExpertEntry['expert']>> = {},
): ExpertEntry => ({
  slug,
  dir: `/home/o/.cindy-harness/experts/${slug}`,
  expert: {
    slug,
    dir: `/home/o/.cindy-harness/experts/${slug}`,
    name: slug,
    description: '',
    agent: 'hermes',
    tools: [],
    skills: [],
    memory: false,
    tags: [],
    prompt: 'p',
    skillFiles: [],
    ...extra,
  },
});

describe('Settings expert editor (ROADMAP 3.3)', () => {
  it('lists valid experts with actions and broken ones with their error and no edit button', () => {
    const html = renderToStaticMarkup(
      <ExpertListView
        entries={[
          entry('code-reviewer', { name: 'Code Reviewer', description: 'Reviews diffs' }),
          { slug: 'broken', dir: '/x/broken', error: 'frontmatter "name" is required' },
        ]}
        selected="code-reviewer"
        onEdit={() => undefined}
        onDuplicate={() => undefined}
      />,
    );
    expect(html).toContain('Code Reviewer');
    expect(html).toContain('Reviews diffs');
    expect(html).toContain('data-testid="expert-edit-code-reviewer"');
    expect(html).toContain('data-testid="expert-duplicate-code-reviewer"');
    expect(html).toContain('frontmatter &quot;name&quot; is required');
    expect(html).toContain('/x/broken/expert.md');
    expect(html).not.toContain('data-testid="expert-edit-broken"');
    expect(html).not.toContain('data-testid="expert-duplicate-broken"');
  });

  it('round-trips form fields: tags as a comma list, empty model omitted', () => {
    const form = formFromFields({
      name: 'A',
      description: 'd',
      model: 'strong',
      tags: ['x', 'y'],
      memory: true,
      prompt: 'p',
    });
    expect(form).toEqual({
      name: 'A',
      description: 'd',
      model: 'strong',
      tags: 'x, y',
      memory: true,
      prompt: 'p',
    });
    expect(fieldsFromForm({ ...form, model: '  ', tags: ' x ,, y ,' })).toEqual({
      name: 'A',
      description: 'd',
      tags: ['x', 'y'],
      memory: true,
      prompt: 'p',
    });
  });

  it('suggests a free kebab-case folder name', () => {
    expect(uniqueExpertSlug('UK Cold Email Writer', [])).toBe('uk-cold-email-writer');
    expect(uniqueExpertSlug('Code Reviewer (copy)', ['code-reviewer-copy'])).toBe(
      'code-reviewer-copy-2',
    );
    expect(uniqueExpertSlug('!!', [])).toBe('expert');
  });

  it('reloads a clean form when the file changes on disk, but never silently drops unsaved edits', () => {
    expect(decideExternalChange({ dirty: false, openHash: 'a', diskHash: 'a' })).toBe('unchanged');
    expect(decideExternalChange({ dirty: false, openHash: 'a', diskHash: 'b' })).toBe('reload');
    expect(decideExternalChange({ dirty: true, openHash: 'a', diskHash: 'b' })).toBe('conflict');
    expect(decideExternalChange({ dirty: true, openHash: 'a', diskHash: null })).toBe('conflict');
  });
});
