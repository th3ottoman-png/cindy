/**
 * openChatInventoryTab — Programmatic entry to open or focus the Chat Inventory tab
 * in the right sidebar for a session, ensuring the sidebar is visible.
 */

import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openChatInventoryTab(sessionId: string): Promise<void> {
  await ensureHydrated(sessionId);
  await addOrFocusSingletonTab(sessionId, 'chat-inventory');
  requestRightSidebarVisibility('open', { sessionId });
}
