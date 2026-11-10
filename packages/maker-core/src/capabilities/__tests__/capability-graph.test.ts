import { describe, expect, it } from 'vitest';
import {
  buildCapabilityGraph,
  explainCapability,
  findUnusedCapabilities,
} from '../capability-graph.js';
import type { CapabilityPack } from '../capability-pack.js';

describe('CapabilityGraph (ROADMAP 8.7)', () => {
  const SAMPLE_PACK: CapabilityPack = {
    version: 1,
    name: 'full-dev-pack',
    expert: 'fullstack-dev',
    modelRoute: 'claude-3-7-sonnet',
    skills: ['github', 'vault-notes'],
    connectors: ['cindy_vault_notes'],
    pinnedNotes: ['Cindy/Architecture.md'],
    permissions: { bash: 'ask' },
  };

  it('builds directed capability graph connecting expert to skills, tools, and notes', () => {
    const graph = buildCapabilityGraph(SAMPLE_PACK);

    expect(graph.nodes['expert:fullstack-dev']).toBeDefined();
    expect(graph.nodes['route:claude-3-7-sonnet']).toBeDefined();
    expect(graph.nodes['skill:github']).toBeDefined();
    expect(graph.nodes['skill:vault-notes']).toBeDefined();
    expect(graph.nodes['connector:cindy_vault_notes']).toBeDefined();
    expect(graph.nodes['note:Cindy/Architecture.md']).toBeDefined();
    expect(graph.nodes['tool:gh_pr_diff']).toBeDefined();

    // Verify edges
    const expertOutbounds = graph.outbound['expert:fullstack-dev'];
    expect(expertOutbounds).toContain('skill:github');
    expect(expertOutbounds).toContain('skill:vault-notes');
    expect(expertOutbounds).toContain('connector:cindy_vault_notes');
    expect(expertOutbounds).toContain('note:Cindy/Architecture.md');
    expect(expertOutbounds).toContain('route:claude-3-7-sonnet');

    // Tool provided by skill
    const githubOutbounds = graph.outbound['skill:github'];
    expect(githubOutbounds).toContain('tool:gh_pr_diff');

    // Inbounds
    expect(graph.inbound['tool:gh_pr_diff']).toContain('skill:github');
  });

  it('explains "Why is this on?" by tracing dependency paths to roots', () => {
    const graph = buildCapabilityGraph(SAMPLE_PACK);

    const explanation1 = explainCapability(graph, 'gh_pr_diff');
    expect(explanation1).toContain('Tool');
    expect(explanation1).toContain('Skill: github');
    expect(explanation1).toContain('Expert (fullstack-dev)');

    const explanation2 = explainCapability(graph, 'skill:vault-notes');
    expect(explanation2).toContain('Skill');
    expect(explanation2).toContain('Expert (fullstack-dev)');

    const explanation3 = explainCapability(graph, 'note:Cindy/Architecture.md');
    expect(explanation3).toContain('attached into session context');

    const explanationMissing = explainCapability(graph, 'unknown-capability');
    expect(explanationMissing).toContain('not present in the current capability graph');
  });

  it('finds unused capabilities given invoked tool names', () => {
    const graph = buildCapabilityGraph(SAMPLE_PACK);

    // Only invoked gh_pr_diff
    const unused = findUnusedCapabilities(graph, ['gh_pr_diff'], ['github']);
    expect(unused.unusedSkills).toContain('vault-notes');
    expect(unused.unusedTools).toContain('gh_pr_merge');
    expect(unused.unusedTools).toContain('read_note');
    expect(unused.totalUnused).toBeGreaterThan(0);
  });
});
