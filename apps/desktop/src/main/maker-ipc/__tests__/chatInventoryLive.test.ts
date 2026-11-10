import { describe, expect, it } from 'vitest';

import {
  aggregateChatInventory,
  type InventoryMessageInput,
  type InventorySessionInput,
} from '@cindy/maker-core/chat-inventory';

import { ChatInventoryHost } from '../chatInventory';

/**
 * Live proof test for ROADMAP 8.8 (Chat Inventory & Session Audit Panel).
 *
 * Verifies live session resource aggregation across active skills, tools invoked,
 * files touched, MCP connectors accessed, and token usage breakdown.
 */
describe('ROADMAP 8.8 Live Proof — Chat Inventory & Session Audit', () => {
  it('aggregates live multi-turn session resources into an audited inventory', async () => {
    const sessionId = 'live-audit-session-123';
    const sessionRow: InventorySessionInput = {
      id: sessionId,
      contextWindow: 128_000,
      model: 'google/gemma-4-26b-a4b-qat',
      expertSlug: 'code-reviewer',
    };

    const messages: InventoryMessageInput[] = [
      {
        role: 'user',
        content: 'Please inspect the project architecture using @skill:code-reviewer and check our notes.',
      },
      {
        role: 'assistant',
        toolCalls: [
          {
            name: 'read_file',
            input: { filePath: 'packages/core/src/index.ts' },
          },
          {
            name: 'mcp__cindy_vault_notes__search_notes',
            input: { query: 'Project — Cindy' },
          },
        ],
        tokens: { prompt: 2400, completion: 600, total: 3000 },
      },
      {
        role: 'user',
        content: 'Now write the new inventory configuration file.',
      },
      {
        role: 'assistant',
        toolCalls: [
          {
            name: 'write_to_file',
            input: {
              targetFile: 'packages/core/src/session/inventory-config.ts',
              codeContent: 'export const INVENTORY_ENABLED = true;\n',
            },
          },
          {
            name: 'bash',
            input: { command: 'pnpm test' },
          },
        ],
        tokens: { prompt: 3500, completion: 1100, total: 4600 },
      },
    ];

    const host = new ChatInventoryHost({
      getSessionRow: async (id) => (id === sessionId ? sessionRow : null),
      listMessages: async (id) => (id === sessionId ? messages : []),
    });

    const result = await host.getInventory(sessionId);
    expect(result.ok).toBe(true);
    expect(result.inventory).toBeDefined();

    const inv = result.inventory!;

    // 1. Session identity & summary counts
    expect(inv.sessionId).toBe(sessionId);
    expect(inv.summary.totalMessages).toBe(4);
    expect(inv.summary.turnCount).toBe(2);
    expect(inv.summary.totalToolCalls).toBe(4);
    expect(inv.summary.totalFilesTouched).toBe(2);

    // 2. Tools invoked
    expect(inv.tools).toHaveLength(4);
    const readFile = inv.tools.find((t) => t.name === 'read_file');
    expect(readFile).toEqual({
      name: 'read_file',
      count: 1,
      category: 'file',
      serverName: undefined,
    });
    const writeTool = inv.tools.find((t) => t.name === 'write_to_file');
    expect(writeTool?.category).toBe('file');
    const mcpTool = inv.tools.find((t) => t.name === 'mcp__cindy_vault_notes__search_notes');
    expect(mcpTool?.category).toBe('mcp');
    expect(mcpTool?.serverName).toBe('cindy');
    const bashTool = inv.tools.find((t) => t.name === 'bash');
    expect(bashTool?.category).toBe('command');

    // 3. Files touched
    expect(inv.files).toHaveLength(2);
    const createdFile = inv.files.find((f) => f.path === 'packages/core/src/session/inventory-config.ts');
    expect(createdFile?.action).toBe('created');
    const readF = inv.files.find((f) => f.path === 'packages/core/src/index.ts');
    expect(readF?.action).toBe('read');

    // 4. Active skills and connectors
    expect(inv.skills).toEqual(['code-reviewer']);
    expect(inv.connectors).toEqual(['cindy']);

    // 5. Token breakdown & context utilization
    expect(inv.tokens.promptTokens).toBe(5900); // 2400 + 3500
    expect(inv.tokens.completionTokens).toBe(1700); // 600 + 1100
    expect(inv.tokens.totalTokens).toBe(7600);
    expect(inv.tokens.contextWindow).toBe(128_000);
    expect(inv.tokens.utilizationPercent).toBe(6); // 7600 / 128000 ≈ 5.9% -> 6%
  });
});
