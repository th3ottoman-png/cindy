import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapabilityPacksHost,
  registerCapabilityPacksHandlers,
} from '../capabilityPacks.js';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels.js';
import type { CapabilityPack } from '@cindy/maker-core/capability-pack';
import type { SessionManifest } from '@cindy/maker-core/session-manifest';

describe('CapabilityPacksHost (ROADMAP 8.7)', () => {
  let tmpPacksDir: string;
  let broadcastMock: ReturnType<typeof vi.fn>;

  const SAMPLE_PACK: CapabilityPack = {
    version: 1,
    name: 'test-reviewer-pack',
    description: 'Code review bundle for testing',
    expert: 'code-reviewer',
    modelRoute: 'claude-3-5-sonnet',
    skills: ['github', 'git-workspace'],
    connectors: ['cindy_vault_notes'],
    pinnedNotes: ['Cindy/Architecture.md'],
    permissions: { bash: 'ask' },
    tags: ['code', 'review'],
  };

  const SAMPLE_MANIFEST: SessionManifest = {
    version: 1,
    session: {
      id: 'session-777-abc',
      agentKind: 'hermes',
      model: 'deepseek-r1',
      providerId: null,
      permissionMode: 'normal',
    },
    capabilities: [
      {
        kind: 'expert',
        id: 'code-reviewer',
        label: 'Code Reviewer',
        value: 'code-reviewer',
        enabled: true,
        file: 'experts/code-reviewer.md',
        reason: 'Active expert',
        trust: 'local-file',
        declaredInterface: 'expert',
      },
      {
        kind: 'skill',
        id: 'github',
        label: 'GitHub',
        value: 'github',
        enabled: true,
        file: 'skills/github/SKILL.md',
        reason: 'Attached skill',
        trust: 'local-file',
        declaredInterface: 'skill',
      },
      {
        kind: 'connector',
        id: 'cindy_vault_notes',
        label: 'Cindy Notes',
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
        label: 'Note',
        value: 'Cindy/Architecture.md',
        enabled: true,
        file: 'notes/Architecture.md',
        reason: 'Pinned',
        trust: 'local-file',
        declaredInterface: 'note',
      },
    ],
  };

  beforeEach(() => {
    tmpPacksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-packs-test-'));
    broadcastMock = vi.fn();
  });

  afterEach(() => {
    if (fs.existsSync(tmpPacksDir)) {
      fs.rmSync(tmpPacksDir, { recursive: true, force: true });
    }
  });

  it('saves and lists capability packs', async () => {
    const host = new CapabilityPacksHost({
      packsDir: tmpPacksDir,
      broadcast: broadcastMock,
    });

    const saveRes = await host.savePack(SAMPLE_PACK);
    expect(saveRes.ok).toBe(true);
    expect(saveRes.name).toBe('test-reviewer-pack');
    expect(fs.existsSync(saveRes.file)).toBe(true);
    expect(broadcastMock).toHaveBeenCalledWith(MAKER_PUSH.CAPABILITY_PACKS_CHANGED, {
      name: 'test-reviewer-pack',
      action: 'saved',
    });

    const list = await host.listPacks();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('test-reviewer-pack');
    expect(list[0].expert).toBe('code-reviewer');
    expect(list[0].skills).toEqual(['github', 'git-workspace']);

    const retrieved = await host.getPack('test-reviewer-pack');
    expect(retrieved).toEqual(SAMPLE_PACK);
  });

  it('exports session manifest into a saved capability pack', async () => {
    const host = new CapabilityPacksHost({
      packsDir: tmpPacksDir,
      manifestProvider: async (id) => (id === 'session-777-abc' ? SAMPLE_MANIFEST : null),
      broadcast: broadcastMock,
    });

    const exportRes = await host.exportSession('session-777-abc', {
      name: 'exported-session-pack',
      description: 'Exported from session-777-abc',
    });

    expect(exportRes.ok).toBe(true);
    expect(exportRes.pack.name).toBe('exported-session-pack');
    expect(exportRes.pack.expert).toBe('code-reviewer');
    expect(exportRes.pack.skills).toContain('github');
    expect(exportRes.pack.pinnedNotes).toContain('Cindy/Architecture.md');

    // Can import into launch recipe
    const recipe = await host.importToLaunchRecipe('exported-session-pack');
    expect(recipe.expertSlug).toBe('code-reviewer');
    expect(recipe.skills).toContain('github');
    expect(recipe.pinnedNotes).toContain('Cindy/Architecture.md');
  });

  it('previews pack security, estimates budget, and explains graph connections', async () => {
    const host = new CapabilityPacksHost({
      packsDir: tmpPacksDir,
      broadcast: broadcastMock,
    });
    await host.savePack(SAMPLE_PACK);

    // 1. Security Preview
    const preview = await host.previewSecurity('test-reviewer-pack');
    expect(preview.verdict).toBe('ok');
    expect(preview.hasAutoBash).toBe(false);

    // 2. Budget Estimation
    const budget = await host.estimateBudget({ name: 'test-reviewer-pack' });
    expect(budget.totalEstimatedTokens).toBeGreaterThan(3000);
    expect(budget.breakdown.length).toBeGreaterThan(4);
    expect(budget.utilizationPercent).toBeGreaterThan(0);

    // 3. Explain Capability
    const explanation = await host.explain({
      name: 'test-reviewer-pack',
      capabilityId: 'gh_pr_diff',
    });
    expect(explanation.explanation).toContain('Skill: github');
    expect(explanation.graph.nodes['skill:github']).toBeDefined();
  });

  it('registers IPC handlers', async () => {
    const host = new CapabilityPacksHost({
      packsDir: tmpPacksDir,
    });
    await host.savePack(SAMPLE_PACK);

    const handlers: Record<string, Function> = {};
    const mockRegistry = {
      handle: (ch: string, fn: Function) => {
        handlers[ch] = fn;
      },
    } as any;

    registerCapabilityPacksHandlers(mockRegistry, {
      host,
      assertTrusted: () => {},
    });

    expect(handlers[MAKER_INVOKE.CAPABILITY_PACKS_LIST]).toBeDefined();
    expect(handlers[MAKER_INVOKE.CAPABILITY_PACKS_EXPORT]).toBeDefined();
    expect(handlers[MAKER_INVOKE.CAPABILITY_PACKS_IMPORT]).toBeDefined();
    expect(handlers[MAKER_INVOKE.CAPABILITY_PACKS_PREVIEW]).toBeDefined();
    expect(handlers[MAKER_INVOKE.CAPABILITY_PACKS_BUDGET]).toBeDefined();
    expect(handlers[MAKER_INVOKE.CAPABILITY_PACKS_EXPLAIN]).toBeDefined();

    const listRes = await handlers[MAKER_INVOKE.CAPABILITY_PACKS_LIST]({});
    expect(listRes).toHaveLength(1);
  });
});
