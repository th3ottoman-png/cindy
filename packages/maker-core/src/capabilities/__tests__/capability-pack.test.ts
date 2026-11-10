import { describe, expect, it } from 'vitest';
import {
  exportSessionToPack,
  importPackToLaunchRecipe,
  parseCapabilityPack,
  previewPackSecurity,
  serializeCapabilityPack,
  suggestCapabilityPack,
  type CapabilityPack,
} from '../capability-pack.js';
import type { SessionManifest } from '../../session/session-manifest.js';

describe('CapabilityPack (ROADMAP 8.7)', () => {
  const SAMPLE_PACK_YAML = `
version: 1
name: code-reviewer-bundle
description: Code review pack with git tools and claude route
expert: code-reviewer
modelRoute: claude-3-5-sonnet
skills:
  - github
  - git-workspace
connectors:
  - cindy_vault_notes
pinnedNotes:
  - Cindy/Research/Architecture.md
permissions:
  bash: ask
  write_file: ask
tags:
  - code
  - git
`;

  it('parses valid capability pack YAML', () => {
    const pack = parseCapabilityPack(SAMPLE_PACK_YAML);
    expect(pack.version).toBe(1);
    expect(pack.name).toBe('code-reviewer-bundle');
    expect(pack.expert).toBe('code-reviewer');
    expect(pack.modelRoute).toBe('claude-3-5-sonnet');
    expect(pack.skills).toEqual(['github', 'git-workspace']);
    expect(pack.connectors).toEqual(['cindy_vault_notes']);
    expect(pack.pinnedNotes).toEqual(['Cindy/Research/Architecture.md']);
    expect(pack.permissions).toEqual({ bash: 'ask', write_file: 'ask' });
    expect(pack.tags).toEqual(['code', 'git']);
  });

  it('serializes and round-trips cleanly', () => {
    const original = parseCapabilityPack(SAMPLE_PACK_YAML);
    const yamlStr = serializeCapabilityPack(original);
    expect(yamlStr).toContain('version: 1');
    expect(yamlStr).toContain('name: code-reviewer-bundle');

    const reparsed = parseCapabilityPack(yamlStr);
    expect(reparsed).toEqual(original);
  });

  it('rejects invalid names or non-object payloads', () => {
    expect(() => parseCapabilityPack('')).toThrow();
    expect(() => parseCapabilityPack('not-a-map')).toThrow();
    expect(() => parseCapabilityPack('version: 1\nname: " "')).toThrow(/Invalid pack name/);
  });

  it('exports session manifest to a capability pack', () => {
    const manifest: SessionManifest = {
      version: 1,
      session: {
        id: 'sess-abc-12345678',
        agentKind: 'hermes',
        model: 'deepseek-r1',
        providerId: null,
        permissionMode: 'normal',
      },
      capabilities: [
        {
          kind: 'expert',
          id: 'researcher',
          label: 'Researcher',
          value: 'researcher',
          enabled: true,
          file: 'experts/researcher.md',
          reason: 'Active session expert',
          trust: 'local-file',
          declaredInterface: 'expert',
        },
        {
          kind: 'skill',
          id: 'web-search',
          label: 'Web Search',
          value: 'web-search',
          enabled: true,
          file: 'skills/web-search/SKILL.md',
          reason: 'Explicitly attached',
          trust: 'local-file',
          declaredInterface: 'skill',
        },
        {
          kind: 'connector',
          id: 'cindy_vault_notes',
          label: 'Cindy Notes MCP',
          value: 'cindy_vault_notes',
          enabled: true,
          file: 'connectors.json',
          reason: 'Active MCP connection',
          trust: 'local-file',
          declaredInterface: 'mcp-server',
        },
        {
          kind: 'pinned-note',
          id: 'note-1',
          label: 'Synthesis Note',
          value: 'Cindy/Research/Synthesis.md',
          enabled: true,
          file: 'notes/Synthesis.md',
          reason: 'Pinned by user',
          trust: 'local-file',
          declaredInterface: 'note',
        },
        {
          kind: 'permission',
          id: 'bash',
          label: 'Bash access',
          value: 'ask',
          enabled: true,
          file: 'config.json',
          reason: 'Session permission policy',
          trust: 'local-file',
          declaredInterface: 'permission',
        },
      ],
    };

    const pack = exportSessionToPack(manifest, { name: 'exported-research-pack' });
    expect(pack.name).toBe('exported-research-pack');
    expect(pack.expert).toBe('researcher');
    expect(pack.skills).toContain('web-search');
    expect(pack.connectors).toContain('cindy_vault_notes');
    expect(pack.pinnedNotes).toContain('Cindy/Research/Synthesis.md');
    expect(pack.permissions).toEqual({ bash: 'ask' });

    const recipe = importPackToLaunchRecipe(pack);
    expect(recipe.expertSlug).toBe('researcher');
    expect(recipe.expert).toBe('researcher');
    expect(recipe.skills).toEqual(['web-search']);
    expect(recipe.pinnedNotes).toEqual(['Cindy/Research/Synthesis.md']);
    expect(recipe.permissionMode).toBe('normal');
  });

  it('runs Phase 4.4 security scan preview', () => {
    const safePack: CapabilityPack = {
      version: 1,
      name: 'safe-pack',
      expert: 'writer',
      skills: ['grammar-check'],
      connectors: [],
      pinnedNotes: [],
      permissions: { bash: 'ask' },
    };
    const safePreview = previewPackSecurity(safePack);
    expect(safePreview.verdict).toBe('ok');
    expect(safePreview.hasAutoBash).toBe(false);

    const dangerousPack: CapabilityPack = {
      version: 1,
      name: 'dangerous-pack',
      expert: 'admin',
      skills: ['risky-exec'],
      connectors: ['remote-sudo-exec'],
      pinnedNotes: [],
      permissions: { bash: 'auto' },
    };
    const dangerousPreview = previewPackSecurity(dangerousPack, {
      'risky-exec': [{ level: 'high', message: 'Executes unreviewed binary payload' }],
    });
    expect(dangerousPreview.verdict).toBe('blocked');
    expect(dangerousPreview.hasAutoBash).toBe(true);
    expect(dangerousPreview.summary.high).toBeGreaterThanOrEqual(2);
  });

  it('extends 7.2 intent suggester to whole capability packs', () => {
    const packs: CapabilityPack[] = [
      {
        version: 1,
        name: 'code-review-pack',
        expert: 'code-reviewer',
        skills: ['github', 'git-workspace'],
        connectors: [],
        pinnedNotes: [],
        tags: ['review', 'git'],
        description: 'Comprehensive code review and git diff inspection',
      },
      {
        version: 1,
        name: 'deep-research-pack',
        expert: 'researcher',
        skills: ['web-search'],
        connectors: ['cindy_vault_notes'],
        pinnedNotes: ['Cindy/Research/Daily.md'],
        tags: ['research', 'literature', 'vault'],
        description: 'Deep literature search and obsidian synthesis',
      },
    ];

    const suggestion1 = suggestCapabilityPack('Please review my git PR changes on GitHub', packs);
    expect(suggestion1).toBeDefined();
    expect(suggestion1?.packName).toBe('code-review-pack');
    expect(suggestion1?.expert).toBe('code-reviewer');

    const suggestion2 = suggestCapabilityPack('Synthesize research papers into vault note', packs);
    expect(suggestion2).toBeDefined();
    expect(suggestion2?.packName).toBe('deep-research-pack');
  });
});
