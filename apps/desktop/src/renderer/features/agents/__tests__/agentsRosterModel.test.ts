// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { ExpertEntry } from '@cindy/maker-core/experts';
import { parseImportedAgent } from '@cindy/maker-core/imported-agents';

import { buildRosterRows, filterRosterRows } from '../agentsRosterModel';

const expert = (slug: string, extra: Partial<NonNullable<ExpertEntry['expert']>> = {}, error?: string): ExpertEntry => ({
  slug,
  dir: `/home/o/.cindy-harness/experts/${slug}`,
  ...(error ? { error } : {
    expert: {
      slug,
      dir: `/home/o/.cindy-harness/experts/${slug}`,
      name: slug,
      description: `${slug} description`,
      agent: 'hermes',
      tools: [],
      skills: [],
      memory: false,
      tags: [],
      prompt: 'p',
      skillFiles: [],
      ...extra,
    },
  }),
});

const imported = parseImportedAgent(
  '---\nname: Historian\ndescription: History things.\ntools: Read, WebSearch\n---\nYou are history.',
  { source: 'claude-user', absolutePath: '/home/o/.claude/agents/historian.md', relPath: 'historian.md' },
);
const qwenImported = parseImportedAgent(
  '---\nname: Architect\ndescription: Designs.\n---\nYou design.',
  { source: 'qwen-project', absolutePath: '/proj/.qwen/agents/architect.md', relPath: 'architect.md' },
);

describe('agents roster model (ROADMAP 12.2)', () => {
  const rows = buildRosterRows(
    [expert('my-agent', { maxConcurrent: 2 }), expert('code-reviewer'), expert('broken', {}, 'name required')],
    [imported, qwenImported],
  );

  it('merges experts and imported agents with badges', () => {
    expect(rows.map((r) => r.id)).toEqual([
      'expert:my-agent',
      'expert:code-reviewer',
      'expert:broken',
      'imported:claude-user:historian.md',
      'imported:qwen-project:architect.md',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'expert', source: 'mine', program: 'hermes', maxConcurrent: 2 });
    expect(rows[1].source).toBe('built-in'); // starter slug
    expect(rows[2].error).toBe('name required');
    expect(rows[3]).toMatchObject({ kind: 'imported', source: 'claude-user', program: 'claude-code', blockedTools: ['WebSearch'] });
    expect(rows[4].source).toBe('qwen-project');
  });

  it('filter chips select their slice', () => {
    expect(filterRosterRows(rows, 'all', '')).toHaveLength(5);
    expect(filterRosterRows(rows, 'mine', '').map((r) => r.slug)).toEqual(['my-agent', 'code-reviewer', 'broken']);
    expect(filterRosterRows(rows, 'built-in', '').map((r) => r.slug)).toEqual(['code-reviewer']);
    expect(filterRosterRows(rows, 'claude-user', '').map((r) => r.name)).toEqual(['Historian']);
    expect(filterRosterRows(rows, 'claude-project', '')).toEqual([]);
    expect(filterRosterRows(rows, 'qwen', '').map((r) => r.name)).toEqual(['Architect']);
  });

  it('search matches name, description and path, case-insensitively', () => {
    expect(filterRosterRows(rows, 'all', 'HISTORIAN').map((r) => r.name)).toEqual(['Historian']);
    expect(filterRosterRows(rows, 'all', 'designs').map((r) => r.name)).toEqual(['Architect']);
    expect(filterRosterRows(rows, 'all', '.qwen/agents').map((r) => r.name)).toEqual(['Architect']);
    expect(filterRosterRows(rows, 'mine', 'historian')).toEqual([]);
  });
});
