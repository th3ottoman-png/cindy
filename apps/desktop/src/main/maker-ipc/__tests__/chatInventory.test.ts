import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatInventoryHost, registerChatInventoryHandlers } from '../chatInventory';
import { MAKER_INVOKE } from '../channels';
import type { IpcHandlerRegistry } from '../ipcHandlerRegistry';

describe('ChatInventoryHost and IPC', () => {
  let host: ChatInventoryHost;
  let getSessionRow: ReturnType<typeof vi.fn>;
  let listMessages: ReturnType<typeof vi.fn>;
  let assertTrusted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getSessionRow = vi.fn(async (sessionId: string) => {
      if (sessionId === 'session-1') {
        return {
          id: 'session-1',
          contextWindow: 128_000,
          model: 'hermes-3',
        };
      }
      return null;
    });

    listMessages = vi.fn(async (sessionId: string) => {
      if (sessionId === 'session-1') {
        return [
          { role: 'user', content: 'Please review @skill:code-review' },
          {
            role: 'assistant',
            toolCalls: [
              { name: 'read_file', input: { path: 'packages/core/src/index.ts' } },
              { name: 'mcp__cindy_vault_notes__read_note', input: { path: 'Inbox.md' } },
            ],
            tokens: { prompt: 1200, completion: 400, total: 1600 },
          },
        ];
      }
      return [];
    });

    assertTrusted = vi.fn();

    host = new ChatInventoryHost({
      getSessionRow,
      listMessages,
    });
  });

  it('fails gracefully when session does not exist', async () => {
    const res = await host.getInventory('non-existent');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Session not found');
  });

  it('aggregates live inventory for valid session', async () => {
    const res = await host.getInventory('session-1');
    expect(res.ok).toBe(true);
    expect(res.inventory).toBeDefined();

    const inv = res.inventory!;
    expect(inv.sessionId).toBe('session-1');
    expect(inv.skills).toEqual(['code-review']);
    expect(inv.connectors).toEqual(['cindy']);
    expect(inv.tools).toHaveLength(2);
    expect(inv.files).toHaveLength(2);
    expect(inv.files.map((f) => f.path)).toContain('packages/core/src/index.ts');
    expect(inv.files.map((f) => f.path)).toContain('Inbox.md');
    expect(inv.tokens.totalTokens).toBe(1600);
    expect(inv.tokens.contextWindow).toBe(128_000);
    expect(inv.summary.totalToolCalls).toBe(2);
  });

  it('registers IPC handlers properly', async () => {
    const handlers = new Map<string, Function>();
    const fakeRegistry: IpcHandlerRegistry = {
      handle: vi.fn((channel, handler) => {
        handlers.set(channel, handler);
      }),
    };

    registerChatInventoryHandlers(fakeRegistry, {
      getHost: () => host,
      assertTrusted,
    });

    expect(handlers.has(MAKER_INVOKE.CHAT_INVENTORY_GET)).toBe(true);

    const getHandler = handlers.get(MAKER_INVOKE.CHAT_INVENTORY_GET)!;
    const res = await getHandler({}, { sessionId: 'session-1' });
    expect(assertTrusted).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.inventory.sessionId).toBe('session-1');
  });

  it('totals tokens from stored agentMeta.turnUsageDetails when rows carry no token fields (Hermes)', async () => {
    // Shape seen live (2026-11-12, e7d82825): usage rides on the assistant row's agent_meta,
    // the same source the session header's "N tok" uses. Stored as an object or as JSON text.
    const storedHost = new ChatInventoryHost({
      getSessionRow: async () => ({ id: 's-h', contextWindow: 100_000 }),
      listMessages: async () =>
        [
          { role: 'user', content: JSON.stringify({ text: 'plan it' }), agentMeta: null },
          {
            role: 'assistant',
            content: JSON.stringify({ text: 'step one' }),
            agentMeta: { turnUsageDetails: { inputTokens: 20_000, outputTokens: 1_000, cacheReadTokens: 9_000, cacheCreateTokens: 1_000 } },
          },
          {
            role: 'assistant',
            content: JSON.stringify({ text: 'step two' }),
            agentMeta: JSON.stringify({ turnUsageDetails: { inputTokens: 5_000, outputTokens: 4_000, cacheReadTokens: 0, cacheCreateTokens: 0 } }),
          },
          { role: 'tool_use', content: JSON.stringify({ toolName: 'read_file', input: { path: 'a.md' } }), agentMeta: { turnUsageDetails: { inputTokens: 999 } } },
        ] as never,
    });
    const res = await storedHost.getInventory('s-h');
    expect(res.ok).toBe(true);
    expect(res.inventory?.tokens).toEqual({
      promptTokens: 35_000,
      completionTokens: 5_000,
      totalTokens: 40_000,
      contextWindow: 100_000,
      utilizationPercent: 40,
    });
  });
});
