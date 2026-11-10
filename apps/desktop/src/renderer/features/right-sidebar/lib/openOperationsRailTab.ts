/**
 * openOperationsRailTab — Programmatic entry to open or focus the Operations Rail tab
 * in the right sidebar for a session, ensuring the sidebar is visible.
 */

import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openOperationsRailTab(sessionId: string): Promise<void> {
  await ensureHydrated(sessionId);
  await addOrFocusSingletonTab(sessionId, 'operations-rail');
  requestRightSidebarVisibility('open', { sessionId });
}
