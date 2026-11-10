import { describe, expect, it } from 'vitest';

import {
  aggregateChatInventory,
  type InventoryMessageInput,
  type InventorySessionInput,
} from '../chat-inventory';

describe('chat-inventory', () => {
  const session: InventorySessionInput = {
    id: 'test-session-1',
    contextWindow: 100_000,
    model: 'hermes-3-llama-3.1-8b',
  };

  it('aggregates empty session cleanly', () => {
    const inv = aggregateChatInventory(session, []);
    expect(inv.sessionId).toBe('test-session-1');
    expect(inv.tools).toEqual([]);
    expect(inv.files).toEqual([]);
    expect(inv.skills).toEqual([]);
    expect(inv.connectors).toEqual([]);
    expect(inv.tokens.totalTokens).toBe(0);
    expect(inv.tokens.contextWindow).toBe(100_000);
    expect(inv.tokens.utilizationPercent).toBe(0);
    expect(inv.summary.totalMessages).toBe(0);
    expect(inv.summary.turnCount).toBe(0);
  });

  it('aggregates tools and categorizes them with server names', () => {
    const messages: InventoryMessageInput[] = [
      { role: 'user', content: 'Run commands' },
      {
        role: 'assistant',
        toolCalls: [
          { name: 'read_file', input: { path: 'src/main.ts' } },
          { name: 'read_file', input: { path: 'src/config.ts' } },
          { name: 'bash', input: { command: 'pnpm test' } },
          { name: 'mcp__cindy_vault_notes__search_notes', input: { query: 'test' } },
        ],
      },
    ];

    const inv = aggregateChatInventory(session, messages);
    expect(inv.tools).toHaveLength(3);

    const readFile = inv.tools.find((t) => t.name === 'read_file');
    expect(readFile).toEqual({
      name: 'read_file',
      count: 2,
      category: 'file',
      serverName: undefined,
    });

    const bash = inv.tools.find((t) => t.name === 'bash');
    expect(bash?.category).toBe('command');

    const mcpTool = inv.tools.find((t) => t.name === 'mcp__cindy_vault_notes__search_notes');
    expect(mcpTool?.category).toBe('mcp');
    expect(mcpTool?.serverName).toBe('cindy');
    expect(inv.connectors).toContain('cindy');
    expect(inv.summary.totalToolCalls).toBe(4);
  });

  it('extracts touched files and assigns correct action priority', () => {
    const messages: InventoryMessageInput[] = [
      {
        role: 'assistant',
        toolCalls: [
          { name: 'read_file', input: { filePath: 'packages/core/src/index.ts' } },
          { name: 'replace_file_content', input: { targetFile: 'packages/core/src/index.ts', replacementContent: 'new code' } },
          { name: 'write_to_file', input: { targetFile: 'packages/core/src/new-file.ts', codeContent: 'hello' } },
        ],
      },
    ];

    const inv = aggregateChatInventory(session, messages);
    expect(inv.files).toHaveLength(2);

    const indexFile = inv.files.find((f) => f.path === 'packages/core/src/index.ts');
    expect(indexFile?.action).toBe('modified');
    expect(indexFile?.count).toBe(2);

    const newFile = inv.files.find((f) => f.path === 'packages/core/src/new-file.ts');
    expect(newFile?.action).toBe('created');
  });

  it('detects attached skills and computes token metrics', () => {
    const messages: InventoryMessageInput[] = [
      {
        role: 'user',
        content: 'Please use @skill:github-pr and @skill:code-review to analyze this.',
        tokens: { prompt: 2500, completion: 500, total: 3000 },
      },
      {
        role: 'assistant',
        content: 'Reviewing...',
        usage: { input_tokens: 1500, output_tokens: 1000 },
      },
    ];

    const inv = aggregateChatInventory(session, messages);
    expect(inv.skills).toEqual(['code-review', 'github-pr']);
    expect(inv.tokens.promptTokens).toBe(4000);
    expect(inv.tokens.completionTokens).toBe(1500);
    expect(inv.tokens.totalTokens).toBe(5500);
    expect(inv.tokens.utilizationPercent).toBe(6);
  });
});
