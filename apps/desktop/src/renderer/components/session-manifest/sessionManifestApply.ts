import {
  toSessionLaunchRecipe,
  type SessionLaunchRecipe,
  type SessionManifest,
} from '@cindy/maker-core/session-manifest';

import {
  patchVendorPrefs,
  patchVendorPrefsPreservingModelChoice,
  resetDraftWorkspaceTargets,
  switchVendor,
  type VendorPrefs,
} from '@/state/newMakerDraft';

import { setPendingManifestPins } from './sessionManifestPins';

/** The two access levels a Hermes task has (same guard as 3.10c). */
const HERMES_PERMISSION_MODES = new Set(['default', 'bypassPermissions']);

/**
 * Reproduces a session manifest into the New Task draft through existing
 * stores and IPC. Nothing is sent and no session row is created. The owner
 * sees the expert, model and access level in the composer before sending.
 */
export function applySessionManifestToDraft(
  manifest: SessionManifest,
  sourceSessionId: string,
): SessionLaunchRecipe {
  const recipe = toSessionLaunchRecipe(manifest);
  resetDraftWorkspaceTargets();
  switchVendor('hermes');
  if (recipe.model.trim()) {
    patchVendorPrefs('hermes', { model: recipe.model });
  }
  if (recipe.permissionMode && HERMES_PERMISSION_MODES.has(recipe.permissionMode)) {
    patchVendorPrefsPreservingModelChoice('hermes', {
      permissionMode: recipe.permissionMode as VendorPrefs['permissionMode'],
    });
  }
  void window.electronAPI?.maker?.experts?.setPending(recipe.expertSlug);
  setPendingManifestPins(sourceSessionId, recipe.pinnedNotes);
  return recipe;
}
