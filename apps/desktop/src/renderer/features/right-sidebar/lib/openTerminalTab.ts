/**
 * openTerminalTab — Programmatic entry to open or focus the embedded terminal tab
 * in the right sidebar for a session, ensuring the sidebar is visible.
 */

import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';
import { routeSidebarCommand } from './detachedSidebarRouting';

export async function openTerminalTab(sessionId: string): Promise<void> {
  const routeResult = await routeSidebarCommand({
    type: 'open-terminal',
    sessionId,
  });
  if (routeResult !== 'attached') {
    if (routeResult !== 'routed') return;
    requestRightSidebarVisibility('open', { sessionId });
    return;
  }
  await ensureHydrated(sessionId);
  requestRightSidebarVisibility('open', { sessionId });
  await addOrFocusSingletonTab(sessionId, 'terminal');
}
