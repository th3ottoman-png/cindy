import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { CapabilityPacksHost } from '../capabilityPacks.js';
import {
  createVaultNotesMcpServer,
  EXPORT_CAPABILITY_PACK_TOOL,
  ESTIMATE_CONTEXT_BUDGET_TOOL,
} from '../../mcp-integrations/vaultNotesMcpServer.js';
import { buildCapabilityGraph } from '@cindy/maker-core/capability-graph';
import type { SessionManifest } from '@cindy/maker-core/session-manifest';

describe('CapabilityPacksLive (ROADMAP 8.7)', () => {
  let tmpVaultDir: string;
  let tmpPacksDir: string;
  let broadcastEvents: { channel: string; payload: unknown }[];

  const LIVE_MANIFEST: SessionManifest = {
    version: 1,
    session: {
      id: 'sess-live-87878787',
      agentKind: 'hermes',
      model: 'claude-3-7-sonnet',
      providerId: 'anthropic',
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
        reason: 'Active session expert',
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
        kind: 'skill',
        id: 'git-workspace',
        label: 'Git Workspace',
        value: 'git-workspace',
        enabled: true,
        file: 'skills/git-workspace/SKILL.md',
        reason: 'Attached skill',
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
        id: 'note-arch',
        label: 'Architecture Spec',
        value: 'Cindy/Research/Architecture.md',
        enabled: true,
        file: 'notes/Architecture.md',
        reason: 'Pinned by user',
        trust: 'local-file',
        declaredInterface: 'note',
      },
      {
        kind: 'permission',
        id: 'bash',
        label: 'Bash Execution',
        value: 'ask',
        enabled: true,
        file: 'config.json',
        reason: 'Session permission policy',
        trust: 'local-file',
        declaredInterface: 'permission',
      },
      {
        kind: 'model-route',
        id: 'claude-3-7-sonnet',
        label: 'Model Route',
        value: 'claude-3-7-sonnet',
        enabled: true,
        file: 'routing.yaml',
        reason: 'Designated model route',
        trust: 'local-file',
        declaredInterface: 'route',
      },
    ],
  };

  beforeEach(() => {
    tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-live-vault-'));
    tmpPacksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-live-packs-'));
    broadcastEvents = [];

    // Stage pinned note in vault
    const resDir = path.join(tmpVaultDir, 'Cindy', 'Research');
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(
      path.join(resDir, 'Architecture.md'),
      '# System Architecture\n\nDetailed specifications of the local multi-agent topology.\n'.repeat(40),
      'utf8',
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpVaultDir)) {
      fs.rmSync(tmpVaultDir, { recursive: true, force: true });
    }
    if (fs.existsSync(tmpPacksDir)) {
      fs.rmSync(tmpPacksDir, { recursive: true, force: true });
    }
  });

  it('live-proves session export to pack, offline import into launch recipe, graph traversal, and token budget estimation', async () => {
    const host = new CapabilityPacksHost({
      packsDir: tmpPacksDir,
      manifestProvider: async (id) => (id === 'sess-live-87878787' ? LIVE_MANIFEST : null),
      noteBodiesProvider: async (notePaths) => {
        const bodies: Record<string, string> = {};
        for (const p of notePaths) {
          const full = path.join(tmpVaultDir, p);
          if (fs.existsSync(full)) {
            bodies[p] = fs.readFileSync(full, 'utf8');
          }
        }
        return bodies;
      },
      broadcast: (channel, payload) => {
        broadcastEvents.push({ channel, payload });
      },
    });

    // ── STEP 1: Export session as pack.yaml ────────────────────────────────
    const exportRes = await host.exportSession('sess-live-87878787', {
      name: 'live-reviewer-pack',
      description: 'Live proven code reviewer bundle',
    });

    expect(exportRes.ok).toBe(true);
    expect(exportRes.pack.name).toBe('live-reviewer-pack');
    expect(exportRes.pack.expert).toBe('code-reviewer');
    expect(exportRes.pack.skills).toEqual(['github', 'git-workspace']);
    expect(exportRes.pack.connectors).toEqual(['cindy_vault_notes']);
    expect(exportRes.pack.pinnedNotes).toEqual(['Cindy/Research/Architecture.md']);
    expect(exportRes.pack.modelRoute).toBe('claude-3-7-sonnet');
    expect(exportRes.pack.permissions).toEqual({ bash: 'ask' });

    // Verify on disk
    expect(fs.existsSync(exportRes.file)).toBe(true);
    const savedContent = fs.readFileSync(exportRes.file, 'utf8');
    expect(savedContent).toContain('name: live-reviewer-pack');
    expect(savedContent).toContain('expert: code-reviewer');
    expect(broadcastEvents.length).toBeGreaterThanOrEqual(1);

    // ── STEP 2: Offline import into new task launch recipe ───────────────────
    const launchRecipe = await host.importToLaunchRecipe('live-reviewer-pack');
    expect(launchRecipe.expert).toBe('code-reviewer');
    expect(launchRecipe.skills).toEqual(['github', 'git-workspace']);
    expect(launchRecipe.pinnedNotes).toEqual(['Cindy/Research/Architecture.md']);
    expect(launchRecipe.model).toBe('claude-3-7-sonnet');
    expect(launchRecipe.permissionMode).toBe('normal');

    // ── STEP 3: Capability Graph Inspection & "Why is this on?" ─────────────
    const graph = buildCapabilityGraph(exportRes.pack);

    // Nodes exist
    expect(graph.nodes['expert:code-reviewer']).toBeDefined();
    expect(graph.nodes['skill:github']).toBeDefined();
    expect(graph.nodes['connector:cindy_vault_notes']).toBeDefined();
    expect(graph.nodes['tool:gh_pr_diff']).toBeDefined();
    expect(graph.nodes['tool:read_note']).toBeDefined();
    expect(graph.nodes['note:Cindy/Research/Architecture.md']).toBeDefined();

    // Edges exist
    expect(graph.outbound['expert:code-reviewer']).toContain('skill:github');
    expect(graph.outbound['expert:code-reviewer']).toContain('connector:cindy_vault_notes');
    expect(graph.outbound['skill:github']).toContain('tool:gh_pr_diff');
    expect(graph.outbound['connector:cindy_vault_notes']).toContain('tool:read_note');

    // Explain capability
    const explainTool = await host.explain({
      name: 'live-reviewer-pack',
      capabilityId: 'gh_pr_diff',
    });
    expect(explainTool.explanation).toContain('Skill: github');
    expect(explainTool.explanation).toContain('Expert (code-reviewer)');

    // ── STEP 4: Pre-turn Context Budget Estimation & Savings Suggestion ─────
    const budgetReport = await host.estimateBudget({
      name: 'live-reviewer-pack',
      maxContextTokens: 128000,
    });

    expect(budgetReport.totalEstimatedTokens).toBeGreaterThan(4000);
    expect(budgetReport.maxContextTokens).toBe(128000);
    expect(budgetReport.utilizationPercent).toBeGreaterThan(0);
    expect(budgetReport.breakdown.some((b) => b.kind === 'expert')).toBe(true);
    expect(budgetReport.breakdown.some((b) => b.kind === 'skill')).toBe(true);
    expect(budgetReport.breakdown.some((b) => b.kind === 'connector')).toBe(true);
    expect(budgetReport.breakdown.some((b) => b.kind === 'note')).toBe(true);

    // ── STEP 5: Live execution via cindy_vault_notes MCP server ───────────────
    const server = createVaultNotesMcpServer({
      getVaultDir: () => tmpVaultDir,
      getSessionContext: () => ({ sessionId: 'sess-live-87878787', agentKind: 'hermes' }),
      sessionMayUse: () => true,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    // 5a. Call export_capability_pack tool
    const exportToolRes = (await client.callTool({
      name: EXPORT_CAPABILITY_PACK_TOOL,
      arguments: {
        name: 'vault-agent-pack',
        description: 'Pack exported directly via MCP tool',
        expert: 'researcher',
        skills: ['web-search'],
        connectors: ['cindy_vault_notes'],
        pinnedNotes: ['Cindy/Research/Architecture.md'],
        modelRoute: 'deepseek-r1',
      },
    })) as { content: [{ type: 'text'; text: string }] };

    const exportToolParsed = JSON.parse(exportToolRes.content[0].text);
    expect(exportToolParsed.exported).toBe(true);
    expect(exportToolParsed.name).toBe('vault-agent-pack');
    expect(exportToolParsed.relPath).toBe(path.join('Cindy', 'Packs', 'vault-agent-pack.yaml'));
    expect(fs.existsSync(exportToolParsed.fullPath)).toBe(true);

    // 5b. Call estimate_context_budget tool
    const budgetToolRes = (await client.callTool({
      name: ESTIMATE_CONTEXT_BUDGET_TOOL,
      arguments: {
        expert: 'researcher',
        skills: ['web-search', 'unused-scraper'],
        connectors: ['cindy_vault_notes'],
        pinnedNotes: ['Cindy/Research/Architecture.md'],
        invokedTools: ['read_note', 'google_search'],
      },
    })) as { content: [{ type: 'text'; text: string }] };

    const budgetToolParsed = JSON.parse(budgetToolRes.content[0].text);
    expect(budgetToolParsed.totalEstimatedTokens).toBeGreaterThan(3000);
    expect(budgetToolParsed.suggestion).toBeDefined();

    await client.close();
    await server.close();
  });
});
