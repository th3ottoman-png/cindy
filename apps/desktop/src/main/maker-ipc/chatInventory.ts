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

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ChatInventoryHostDeps {
  getSessionRow: (sessionId: string) => Promise<InventorySessionInput | null>;
  listMessages: (sessionId: string) => Promise<InventoryMessageInput[]>;
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

      const messages = await this.deps.listMessages(sessionId);
      const inventory = aggregateChatInventory(session, messages || []);
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
