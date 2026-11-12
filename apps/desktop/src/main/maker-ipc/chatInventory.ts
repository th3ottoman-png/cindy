/**
 * Chat Inventory host (ROADMAP 8.8).
 *
 * Exposes audited live session resources (tools invoked, files touched,
 * active skills, connectors accessed, and token usage) via `@cindy/maker-core/chat-inventory`.
 *
 * Local only. No telemetry, no external network calls.
 */

import {
  aggregateChatInventory,
  type ChatInventory,
  type InventoryMessageInput,
  type InventorySessionInput,
} from '@cindy/maker-core/chat-inventory';

import { normalizeTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ChatInventoryHostDeps {
  getSessionRow: (sessionId: string) => Promise<InventorySessionInput | null>;
  listMessages: (sessionId: string) => Promise<InventoryMessageInput[]>;
}

/**
 * Session token totals from stored assistant rows' `agentMeta.turnUsageDetails` — the same source
 * the session header's usage uses. Prompt = input + cache read + cache write; completion = output.
 * Returns null when no row carries usage, so a caller's own totals are never overwritten by zeros.
 */
export function storedTokenTotals(
  messages: readonly unknown[],
): { promptTokens: number; completionTokens: number } | null {
  let promptTokens = 0;
  let completionTokens = 0;
  let found = false;
  for (const row of messages) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { role?: unknown; agentMeta?: unknown };
    if (r.role !== 'assistant') continue;
    let meta = r.agentMeta;
    if (typeof meta === 'string') {
      try {
        meta = JSON.parse(meta) as unknown;
      } catch {
        continue;
      }
    }
    if (!meta || typeof meta !== 'object') continue;
    const usage = normalizeTurnUsageDetails((meta as { turnUsageDetails?: unknown }).turnUsageDetails);
    if (!usage) continue;
    found = true;
    promptTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
    completionTokens += usage.outputTokens;
  }
  return found ? { promptTokens, completionTokens } : null;
}

export class ChatInventoryHost {
  constructor(private readonly deps: ChatInventoryHostDeps) {}

  async getInventory(sessionId: string): Promise<{ ok: boolean; inventory?: ChatInventory; error?: string }> {
    if (!sessionId || !sessionId.trim()) {
      return { ok: false, error: 'No sessionId specified' };
    }

    try {
      const session = await this.deps.getSessionRow(sessionId);
      if (!session) {
        return { ok: false, error: `Session not found: ${sessionId}` };
      }

      const messages = (await this.deps.listMessages(sessionId)) || [];
      // Stored rows carry no per-message `tokens`; fill session totals from their usage meta.
      const stored = session.promptTokens || session.completionTokens ? null : storedTokenTotals(messages);
      const inventory = aggregateChatInventory(stored ? { ...session, ...stored } : session, messages);
      return { ok: true, inventory };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function registerChatInventoryHandlers(
  registry: IpcHandlerRegistry,
  deps: {
    getHost: () => ChatInventoryHost;
    assertTrusted: (event: unknown) => void;
  },
): void {
  registry.handle(MAKER_INVOKE.CHAT_INVENTORY_GET, async (event: unknown, rawArgs: unknown) => {
    deps.assertTrusted(event);
    const args = rawArgs as { sessionId: string } | undefined;
    return deps.getHost().getInventory(args?.sessionId ?? '');
  });
}
