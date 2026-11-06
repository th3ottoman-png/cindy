/**
 * openWorktreeManagerTab — Programmatic entry to open or focus the Worktree Manager
 * tab in the right sidebar for a session, ensuring the sidebar is visible.
 */

import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openWorktreeManagerTab(sessionId: string): Promise<void> {
  await ensureHydrated(sessionId);
  await addOrFocusSingletonTab(sessionId, 'worktree-manager');
  requestRightSidebarVisibility('open', { sessionId });
}
