/**
 * openVaultGraphTab — Programmatic entry to open or focus the Vault Graph tab
 * in the right sidebar for a session, ensuring the sidebar is visible.
 */

import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openVaultGraphTab(sessionId: string): Promise<void> {
  await ensureHydrated(sessionId);
  await addOrFocusSingletonTab(sessionId, 'vault-graph');
  requestRightSidebarVisibility('open', { sessionId });
}
