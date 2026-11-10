import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VaultNotesHost } from '../vaultNotes';
import {
  createVaultNotesMcpServer,
  SYNC_WORKSPACE_GIT_TOOL,
} from '../../mcp-integrations/vaultNotesMcpServer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('ROADMAP 7.4 Git Workspace ↔ Vault Project Note Auto-Sync Live Proof', () => {
  const vaultDir = '/home/antigravity/Bishi-memory';
  const workspaceDir = '/home/antigravity/th3ottoman-png/cindy';
  const configFile = '/home/antigravity/.cindy-harness/vault.json';

  beforeEach(() => {
    fs.mkdirSync(path.join(vaultDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ vaultDir }), 'utf8');

    const projectNote = path.join(vaultDir, 'memory', 'Project — Cindy.md');
    if (!fs.existsSync(projectNote)) {
      fs.writeFileSync(
        projectNote,
        '# Project: Cindy (Autonomous Fork)\n\nDaily driver AI harness.\n',
        'utf8',
      );
    }
  });

  it('live-exercises git inspection and 1-click sync against real repository and vault', async () => {
    const host = new VaultNotesHost({ configFile });

    // 1. Inspect active git workspace
    const inspectRes = await host.inspectGitWorkspace(workspaceDir);
    expect(inspectRes.ok).toBe(true);
    expect(inspectRes.inspection).toBeDefined();
    expect(inspectRes.inspection?.projectName).toBe('cindy');
    expect(inspectRes.inspection?.branch).toBeDefined();
    expect(inspectRes.inspection?.recentCommits.length).toBeGreaterThan(0);
    // Verified exact match with memory/Project — Cindy.md
    expect(inspectRes.targetNotePath).toBe('memory/Project — Cindy.md');
    expect(inspectRes.matchType).toBe('exact');

    // 2. 1-Click Sync: append progress & commit log
    const syncRes = await host.applyGitWorkspaceSync({
      workspaceDir,
      summaryNote: 'Phase 7.4 live verification: automated commit & progress log sync.',
    });

    expect(syncRes.ok).toBe(true);
    expect(syncRes.path).toBe('memory/Project — Cindy.md');
    expect(syncRes.block).toContain('### Progress');
    expect(syncRes.block).toContain('Phase 7.4 live verification');

    // 3. Verify written content on disk
    const notePath = path.join(vaultDir, 'memory', 'Project — Cindy.md');
    const diskContent = fs.readFileSync(notePath, 'utf8');
    expect(diskContent).toContain('Phase 7.4 live verification: automated commit & progress log sync.');
    expect(diskContent).toContain(inspectRes.inspection!.recentCommits[0].hash);
  });

  it('live-exercises agent MCP tool sync_workspace_git_to_project_note', async () => {
    const host = new VaultNotesHost({ configFile });
    const server = createVaultNotesMcpServer({
      getSessionContext: () => ({ agentKind: 'hermes', sessionId: 'live-sess-git' }),
      getVaultDir: () => vaultDir,
      sessionMayUse: () => true,
      syncWorkspaceGit: (opts) => host.applyGitWorkspaceSync(opts),
    });

    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'mcp-live-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);

    try {
      const res = await client.callTool({
        name: SYNC_WORKSPACE_GIT_TOOL,
        arguments: {
          workspaceDir,
          summary: 'Agent tool live verification for ROADMAP 7.4',
        },
      });

      expect(res.isError).toBeFalsy();
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(body.synced).toBe(true);
      expect(body.path).toBe('memory/Project — Cindy.md');
      expect(body.block).toContain('Agent tool live verification for ROADMAP 7.4');
    } finally {
      await client.close();
    }
  });
});
