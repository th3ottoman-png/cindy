/**
 * openArtifactsTab — Programmatic entry to open or focus the Artifacts side-drawer tab
 * in the right sidebar for a session, ensuring the sidebar is visible.
 */

import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openArtifactsTab(sessionId: string): Promise<void> {
  await ensureHydrated(sessionId);
  await addOrFocusSingletonTab(sessionId, 'artifacts');
  requestRightSidebarVisibility('open', { sessionId });
}
