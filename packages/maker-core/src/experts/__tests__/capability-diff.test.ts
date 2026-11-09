import { describe, expect, it } from 'vitest';
import type { CapabilityDescriptor } from '../../extensions/registry';

import {
  capabilityDiffSummary,
  diffCapabilitySets,
  expertCapabilityDescriptors,
  EXPERT_KIND,
  MODEL_ROUTE_KIND,
  SKILL_KIND,
  TOOL_KIND,
  TOOLSET_KIND,
  type ExpertCapabilityFacts,
} from '../capability-diff';

const CODE_REVIEWER: ExpertCapabilityFacts = {
  slug: 'code-reviewer',
  name: 'Code Reviewer',
  dir: '/experts/code-reviewer',
  model: 'local-small',
  tools: ['read_file', 'search_notes', 'run_tests'],
  toolsets: ['filesystem'],
  skills: ['review-checklist'],
};

const VAULT_RESEARCHER: ExpertCapabilityFacts = {
  slug: 'vault-researcher',
  name: 'Vault Researcher',
  dir: '/experts/vault-researcher',
  model: 'local-small',
  tools: ['search_notes', 'read_note'],
  skills: ['vault-notes'],
};

function custom(kind: string, id: string): CapabilityDescriptor {
  return {
    kind,
    id,
    title: id,
    source: `/tmp/${kind}/${id}`,
    trust: 'local-file',
    declaredInterface: 'test',
    enabled: true,
  };
}

function ids(rows: readonly CapabilityDescriptor[]): string[] {
  return rows.map((row) => `${row.kind}:${row.id}`).sort();
}

describe('expertCapabilityDescriptors', () => {
  it('maps every declared surface of an expert file', () => {
    const rows = expertCapabilityDescriptors(CODE_REVIEWER);
    expect(ids(rows)).toEqual([
      'expert:code-reviewer',
      'model-route:local-small',
      'skill:review-checklist',
      'tool:read_file',
      'tool:run_tests',
      'tool:search_notes',
      'toolset:filesystem',
    ]);
    expect(rows.find((row) => row.kind === EXPERT_KIND)?.source).toBe(
      '/experts/code-reviewer/expert.md',
    );
    expect(rows.find((row) => row.kind === MODEL_ROUTE_KIND)?.source).toBe(
      '~/.cindy-harness/routing.yaml',
    );
  });

  it('counts skills found on disk as well as skills named in frontmatter', () => {
    const rows = expertCapabilityDescriptors({
      slug: 'code-reviewer',
      dir: '/experts/code-reviewer',
      skills: ['review-checklist'],
      skillFiles: [
        '/experts/code-reviewer/skills/sample-expert-skill/SKILL.md',
        '/experts/code-reviewer/skills/review-checklist/SKILL.md',
      ],
    });
    expect(ids(rows.filter((row) => row.kind === SKILL_KIND))).toEqual([
      'skill:review-checklist',
      'skill:sample-expert-skill',
    ]);
  });

  it('ignores a skill path that is not a SKILL.md file', () => {
    const rows = expertCapabilityDescriptors({
      slug: 'sparse',
      skillFiles: ['/experts/sparse/skills/notes.md', '/experts/sparse/skills//'],
    });
    expect(rows.filter((row) => row.kind === SKILL_KIND)).toEqual([]);
  });

  it('treats no expert as an empty capability set', () => {
    expect(expertCapabilityDescriptors(null)).toEqual([]);
    expect(expertCapabilityDescriptors(undefined)).toEqual([]);
    expect(expertCapabilityDescriptors({ slug: '' })).toEqual([]);
  });

  it('skips blank entries instead of emitting empty ids', () => {
    const rows = expertCapabilityDescriptors({
      slug: 'sparse',
      tools: ['ok', '', '  '],
      skills: [],
      toolsets: [],
    });
    expect(ids(rows)).toEqual(['expert:sparse', 'tool:ok']);
  });
});

describe('diffCapabilitySets', () => {
  it('reports every addition when switching from a plain task to an expert', () => {
    const diff = diffCapabilitySets([], expertCapabilityDescriptors(CODE_REVIEWER));
    expect(diff.removed).toEqual([]);
    expect(diff.keptIds).toEqual([]);
    expect(diff.added).toHaveLength(7);
    expect(diff.summary).toBe(
      'adds 3 tools, adds toolset lock, adds model route local-small, adds 1 skill',
    );
  });

  it('reads like the roadmap example between two real experts', () => {
    const before = expertCapabilityDescriptors(VAULT_RESEARCHER);
    const after = expertCapabilityDescriptors(CODE_REVIEWER);
    const diff = diffCapabilitySets(before, after);
    expect(diff.summary).toBe(
      'adds 2 tools, drops 1 tool, adds toolset lock, keeps model, adds 1 skill, drops 1 skill',
    );
  });

  it('keeps model and toolset lock when both experts declare the same values', () => {
    const before = expertCapabilityDescriptors(CODE_REVIEWER);
    const after = expertCapabilityDescriptors({ ...CODE_REVIEWER, slug: 'code-reviewer-2' });
    const diff = diffCapabilitySets(before, after);
    expect(diff.model).toEqual({
      before: 'local-small',
      after: 'local-small',
      changed: false,
    });
    expect(diff.toolsetLock.state).toBe('unchanged');
    expect(diff.phrases).toContain('keeps model');
    expect(diff.phrases).toContain('keeps toolset lock');
  });

  it('drops the toolset lock when the target expert has none', () => {
    const diff = diffCapabilitySets(
      expertCapabilityDescriptors(CODE_REVIEWER),
      expertCapabilityDescriptors(VAULT_RESEARCHER),
    );
    expect(diff.toolsetLock).toEqual({
      before: ['filesystem'],
      after: [],
      state: 'dropped',
    });
    expect(diff.phrases).toContain('drops toolset lock');
  });

  it('names the new model when the route changes', () => {
    const diff = diffCapabilitySets(
      expertCapabilityDescriptors(CODE_REVIEWER),
      expertCapabilityDescriptors({ ...VAULT_RESEARCHER, model: 'deepseek-flash' }),
    );
    expect(diff.model.changed).toBe(true);
    expect(diff.phrases).toContain('changes model to deepseek-flash');
  });

  it('reports a dropped model route when the target has none', () => {
    const diff = diffCapabilitySets(
      expertCapabilityDescriptors(CODE_REVIEWER),
      expertCapabilityDescriptors({ ...VAULT_RESEARCHER, model: undefined }),
    );
    expect(diff.phrases).toContain('drops model route');
  });

  it('uses singular wording for one item', () => {
    const diff = diffCapabilitySets([], expertCapabilityDescriptors({
      slug: 'one-tool',
      tools: ['read_file'],
      skills: ['single-skill'],
    }));
    expect(diff.phrases).toContain('adds 1 tool');
    expect(diff.phrases).toContain('adds 1 skill');
  });

  it('says no capability changes for identical sets', () => {
    const rows = expertCapabilityDescriptors(CODE_REVIEWER);
    const diff = diffCapabilitySets(rows, rows);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.keptIds).toHaveLength(rows.length);
    expect(diff.summary).toBe('keeps toolset lock, keeps model');
    expect(diff.groups).toEqual([]);
  });

  it('reports a truly empty diff as no capability changes', () => {
    const diff = diffCapabilitySets([], []);
    expect(diff.summary).toBe('no capability changes');
    expect(diff.phrases).toEqual([]);
  });

  it('puts adds before drops inside one kind and orders kinds by the table', () => {
    const diff = diffCapabilitySets(
      [custom(TOOL_KIND, 'gone'), custom(SKILL_KIND, 'old-skill')],
      [custom(TOOL_KIND, 'new'), custom(SKILL_KIND, 'new-skill')],
    );
    expect(diff.phrases).toEqual([
      'adds 1 tool',
      'drops 1 tool',
      'adds 1 skill',
      'drops 1 skill',
    ]);
  });

  it('labels an unknown kind with its own slug instead of failing', () => {
    const diff = diffCapabilitySets([], [custom('quantum-widget', 'one'), custom('quantum-widget', 'two')]);
    expect(diff.phrases).toEqual(['adds 2 quantum-widgets']);
    expect(diff.groups[0].kind).toBe('quantum-widget');
  });

  it('never phrases the expert kind, the chip title already says it', () => {
    const diff = diffCapabilitySets(
      expertCapabilityDescriptors(VAULT_RESEARCHER),
      expertCapabilityDescriptors(CODE_REVIEWER),
    );
    expect(diff.groups.some((group) => group.kind === EXPERT_KIND)).toBe(true);
    expect(diff.phrases.some((phrase) => phrase.includes('expert'))).toBe(false);
  });

  it('ignores malformed rows and duplicate keys', () => {
    const malformed = [
      { kind: TOOL_KIND } as unknown as CapabilityDescriptor,
      null as unknown as CapabilityDescriptor,
    ];
    const duplicated = [custom(TOOL_KIND, 'dup'), custom(TOOL_KIND, 'dup')];
    const diff = diffCapabilitySets(malformed, duplicated);
    expect(diff.added).toHaveLength(1);
    expect(diff.phrases).toEqual(['adds 1 tool']);
  });

  it('is pure: the same inputs always give the same result', () => {
    const before = expertCapabilityDescriptors(VAULT_RESEARCHER);
    const after = expertCapabilityDescriptors(CODE_REVIEWER);
    expect(diffCapabilitySets(before, after)).toEqual(diffCapabilitySets(before, after));
    expect(capabilityDiffSummary(diffCapabilitySets(before, after))).toBe(
      diffCapabilitySets(before, after).summary,
    );
  });

  it('tracks skills as their own kind', () => {
    const diff = diffCapabilitySets(
      expertCapabilityDescriptors(VAULT_RESEARCHER),
      expertCapabilityDescriptors(CODE_REVIEWER),
    );
    const skills = diff.groups.find((group) => group.kind === SKILL_KIND);
    expect(ids(skills?.added ?? [])).toEqual(['skill:review-checklist']);
    expect(ids(skills?.removed ?? [])).toEqual(['skill:vault-notes']);
  });
});
