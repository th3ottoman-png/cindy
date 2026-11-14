import { describe, expect, it } from 'vitest';

import {
  buildSquadLaunchPlan,
  DEFAULT_SQUAD_MAX_TURNS,
  DEFAULT_SQUAD_WORKER_PERMISSION_MODE,
  MAX_SQUAD_MEMBERS,
  parseSquadYaml,
  renderSquadKickoff,
  renderSquadYaml,
  squadSlugFromName,
  type SquadDefinition,
} from '../squad.js';

const VALID = `name: Review squad
description: Reviews a diff from three angles and merges the findings.
lead: expert:orchestrator
members:
  - expert:code-reviewer
  - imported:claude-user:security-reviewer.md
  - imported:claude-user:typescript-reviewer.md
worker_permission_mode: bypassPermissions
max_turns: 20
`;

const ROSTER = [
  'expert:orchestrator',
  'expert:code-reviewer',
  'imported:claude-user:security-reviewer.md',
  'imported:claude-user:typescript-reviewer.md',
];

function squad(overrides: Partial<SquadDefinition> = {}): SquadDefinition {
  return {
    name: 'Review squad',
    description: 'Reviews a diff.',
    lead: 'expert:orchestrator',
    members: ['expert:code-reviewer', 'imported:claude-user:security-reviewer.md'],
    workerPermissionMode: 'bypassPermissions',
    maxTurns: 20,
    ...overrides,
  };
}

describe('parseSquadYaml', () => {
  it('parses a well-formed squad', () => {
    const res = parseSquadYaml(VALID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.squad.name).toBe('Review squad');
    expect(res.squad.lead).toBe('expert:orchestrator');
    expect(res.squad.members).toEqual([
      'expert:code-reviewer',
      'imported:claude-user:security-reviewer.md',
      'imported:claude-user:typescript-reviewer.md',
    ]);
    expect(res.squad.workerPermissionMode).toBe('bypassPermissions');
    expect(res.squad.maxTurns).toBe(20);
  });

  it('defaults permission mode and turn cap when absent', () => {
    const res = parseSquadYaml('name: S\nlead: expert:a\nmembers:\n  - expert:b\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.squad.workerPermissionMode).toBe(DEFAULT_SQUAD_WORKER_PERMISSION_MODE);
    expect(res.squad.maxTurns).toBe(DEFAULT_SQUAD_MAX_TURNS);
    expect(res.squad.description).toBe('');
  });

  it('accepts CRLF line endings', () => {
    const res = parseSquadYaml(VALID.replace(/\n/g, '\r\n'));
    expect(res.ok).toBe(true);
  });

  it('ignores unknown keys', () => {
    const res = parseSquadYaml(VALID + 'tags:\n  - x\ncustom: 1\n');
    expect(res.ok).toBe(true);
  });

  it('rejects invalid YAML without throwing', () => {
    const res = parseSquadYaml('name: [unclosed');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/invalid YAML/);
  });

  it('rejects an empty file', () => {
    expect(parseSquadYaml('').ok).toBe(false);
    expect(parseSquadYaml('# just a comment\n').ok).toBe(false);
  });

  it('rejects a non-mapping document', () => {
    expect(parseSquadYaml('- a\n- b\n').ok).toBe(false);
    expect(parseSquadYaml('just a string').ok).toBe(false);
  });

  it('requires a name', () => {
    const res = parseSquadYaml('lead: expert:a\nmembers:\n  - expert:b\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/name/);
  });

  it('requires a well-formed lead roster id', () => {
    expect(parseSquadYaml('name: S\nlead: not-an-id\nmembers:\n  - expert:b\n').ok).toBe(false);
    expect(parseSquadYaml('name: S\nmembers:\n  - expert:b\n').ok).toBe(false);
    expect(parseSquadYaml('name: S\nlead: expert:../escape\nmembers:\n  - expert:b\n').ok).toBe(false);
  });

  it('requires a non-empty members list of well-formed ids', () => {
    expect(parseSquadYaml('name: S\nlead: expert:a\n').ok).toBe(false);
    expect(parseSquadYaml('name: S\nlead: expert:a\nmembers: []\n').ok).toBe(false);
    expect(parseSquadYaml('name: S\nlead: expert:a\nmembers: expert:b\n').ok).toBe(false);
    expect(parseSquadYaml('name: S\nlead: expert:a\nmembers:\n  - bogus\n').ok).toBe(false);
  });

  it('refuses the lead as a member and duplicate members', () => {
    const lead = parseSquadYaml('name: S\nlead: expert:a\nmembers:\n  - expert:a\n');
    expect(lead.ok).toBe(false);
    const dup = parseSquadYaml('name: S\nlead: expert:a\nmembers:\n  - expert:b\n  - expert:b\n');
    expect(dup.ok).toBe(false);
  });

  it('caps the member count', () => {
    const many = Array.from({ length: MAX_SQUAD_MEMBERS + 1 }, (_, i) => `  - expert:m${i}`).join('\n');
    const res = parseSquadYaml(`name: S\nlead: expert:a\nmembers:\n${many}\n`);
    expect(res.ok).toBe(false);
  });

  it('validates the permission mode enum', () => {
    const res = parseSquadYaml('name: S\nlead: expert:a\nmembers:\n  - expert:b\nworker_permission_mode: default\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/worker_permission_mode/);
  });

  it('validates max_turns as a bounded positive integer', () => {
    for (const bad of ['0', '-3', '1.5', '999', '"20"']) {
      const res = parseSquadYaml(`name: S\nlead: expert:a\nmembers:\n  - expert:b\nmax_turns: ${bad}\n`);
      expect(res.ok).toBe(false);
    }
    expect(parseSquadYaml('name: S\nlead: expert:a\nmembers:\n  - expert:b\nmax_turns: 1\n').ok).toBe(true);
  });
});

describe('renderSquadYaml', () => {
  it('round-trips a parsed squad', () => {
    const parsed = parseSquadYaml(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rendered = renderSquadYaml(parsed.squad);
    const again = parseSquadYaml(rendered);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.squad).toEqual(parsed.squad);
  });

  it('keeps unknown keys from a base file', () => {
    const base = VALID + 'tags:\n  - keep-me\n';
    const rendered = renderSquadYaml(squad(), base);
    expect(rendered).toContain('keep-me');
    const again = parseSquadYaml(rendered);
    expect(again.ok).toBe(true);
  });

  it('writes a fresh file with only the owned keys', () => {
    const rendered = renderSquadYaml(squad());
    expect(rendered).toContain('name: Review squad');
    expect(rendered).toContain('lead: expert:orchestrator');
    expect(rendered).toContain('worker_permission_mode: bypassPermissions');
    expect(rendered).toContain('max_turns: 20');
  });
});

describe('squadSlugFromName', () => {
  it('derives a kebab slug', () => {
    expect(squadSlugFromName('Review Squad')).toBe('review-squad');
    expect(squadSlugFromName('  Three-Angle   Review! ')).toBe('three-angle-review');
  });
  it('falls back for short or symbol-only names', () => {
    expect(squadSlugFromName('A')).toBe('squad-a');
    expect(squadSlugFromName('!!!')).toBe('squad-');
  });
});

describe('renderSquadKickoff', () => {
  it('prefixes every member token and keeps the task', () => {
    const msg = renderSquadKickoff(['expert:a', 'imported:claude-user:b.md'], 'Review the diff.');
    expect(msg).toBe('@agent:expert:a @agent:imported:claude-user:b.md\n\nReview the diff.');
  });
  it('uses a minimal assembly note when no task is given', () => {
    const msg = renderSquadKickoff(['expert:a'], '   ');
    expect(msg.startsWith('@agent:expert:a\n\n')).toBe(true);
    expect(msg).toMatch(/squad/i);
  });
});

describe('buildSquadLaunchPlan', () => {
  it('builds a plan with binding ids and a kickoff message', () => {
    const res = buildSquadLaunchPlan(squad(), ROSTER, 'Review the diff.');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.leadRosterId).toBe('expert:orchestrator');
    expect(res.plan.leadBindingId).toBe('orchestrator');
    expect(res.plan.members).toEqual([
      { rosterId: 'expert:code-reviewer', bindingId: 'code-reviewer' },
      { rosterId: 'imported:claude-user:security-reviewer.md', bindingId: 'imported:claude-user:security-reviewer.md' },
    ]);
    expect(res.plan.workerPermissionMode).toBe('bypassPermissions');
    expect(res.plan.maxTurns).toBe(20);
    expect(res.plan.kickoffMessage).toContain('@agent:expert:code-reviewer');
    expect(res.plan.kickoffMessage).toContain('Review the diff.');
  });

  it('refuses an unknown lead and names it', () => {
    const res = buildSquadLaunchPlan(squad({ lead: 'expert:ghost' }), ROSTER);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(' ')).toMatch(/lead "expert:ghost"/);
  });

  it('refuses unknown members and names each', () => {
    const res = buildSquadLaunchPlan(squad({ members: ['expert:ghost1', 'expert:ghost2'] }), ROSTER);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(2);
    expect(res.errors.join(' ')).toMatch(/ghost1/);
    expect(res.errors.join(' ')).toMatch(/ghost2/);
  });

  it('collects lead and member errors together', () => {
    const res = buildSquadLaunchPlan(squad({ lead: 'expert:ghost', members: ['expert:gone'] }), ROSTER);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(2);
  });

  it('refuses a permission ceiling below Full access (ADR 0011 §5)', () => {
    const res = buildSquadLaunchPlan(squad({ workerPermissionMode: 'auto' }), ROSTER);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(' ')).toMatch(/Full access/);
  });

  it('never launches when any id is unknown even if the ceiling is valid', () => {
    const res = buildSquadLaunchPlan(squad({ members: ['expert:code-reviewer', 'expert:ghost'] }), ROSTER);
    expect(res.ok).toBe(false);
  });
});
