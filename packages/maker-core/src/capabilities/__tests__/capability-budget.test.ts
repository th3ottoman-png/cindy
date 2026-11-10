import { describe, expect, it } from 'vitest';
import {
  estimateCapabilityBudget,
  estimateTokensFromChars,
} from '../capability-budget.js';
import type { CapabilityPack } from '../capability-pack.js';

describe('CapabilityBudget (ROADMAP 8.7)', () => {
  const PACK: CapabilityPack = {
    version: 1,
    name: 'research-pack',
    expert: 'researcher',
    modelRoute: 'claude-3-5-sonnet',
    skills: ['github', 'vault-notes', 'web-search'],
    connectors: ['cindy_vault_notes'],
    pinnedNotes: ['Cindy/Research/Synthesis.md'],
    permissions: { bash: 'ask' },
  };

  it('estimates token count from character count accurately', () => {
    expect(estimateTokensFromChars(100)).toBe(25);
    expect(estimateTokensFromChars(4000)).toBe(1000);
    expect(estimateTokensFromChars(0)).toBe(1);
  });

  it('calculates capability budget breakdown and token utilization', () => {
    const report = estimateCapabilityBudget({
      packOrManifest: PACK,
      noteBodies: {
        'Cindy/Research/Synthesis.md': 'A'.repeat(8000), // 2000 tokens
      },
      invokedTools: ['read_note', 'google_search'],
      activeSkills: ['vault-notes', 'web-search'],
      maxContextTokens: 200000,
    });

    expect(report.totalEstimatedTokens).toBeGreaterThan(5000);
    expect(report.maxContextTokens).toBe(200000);
    expect(report.utilizationPercent).toBeGreaterThan(0);
    expect(report.breakdown.length).toBeGreaterThan(5);

    // Expert item
    const expertItem = report.breakdown.find((b) => b.kind === 'expert');
    expect(expertItem).toBeDefined();
    expect(expertItem?.tokens).toBe(1200);

    // Note item
    const noteItem = report.breakdown.find((b) => b.kind === 'note');
    expect(noteItem).toBeDefined();
    expect(noteItem?.tokens).toBe(2000);

    // Unused skills
    // 'github' skill was not active and no github tools were invoked
    const githubItem = report.breakdown.find((b) => b.id === 'skill:github');
    expect(githubItem?.isUnused).toBe(true);

    // Suggestion generated
    expect(report.suggestion).toContain('Disabling 1 unused skill frees about 1,400 tokens');
    expect(report.unusedTokens).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});
