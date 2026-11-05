/**
 * "Ask <expert> about this" (ROADMAP 3.6b): prefill the New Task draft with the handoff text.
 *
 * Same "no pre-created session" pattern as the /issue and contacts prefills: the text goes into
 * the native New Maker draft and the caller navigates to /cc-agent/new. Nothing is sent; the
 * owner reads (and may edit) the message, then sends it, which binds the pending expert through
 * the normal first-turn path. The draft is switched to Hermes (the only agent experts start on)
 * and reset to a clean local chat, so it never inherits another task's folders or remote target.
 */

import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import {
  patchDraft,
  patchVendorPrefs,
  patchVendorPrefsPreservingModelChoice,
  resetDraftWorkspaceTargets,
  switchVendor,
} from '@/state/newMakerDraft';

export function prefillExpertHandoffDraft(prompt: string, model?: string): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(prompt),
    attachments: [],
  });
  resetDraftWorkspaceTargets();
  switchVendor('hermes');
  if (model?.trim()) {
    patchVendorPrefs('hermes', { model: model.trim() });
  }
}

/** The two access levels a Hermes task has: Ask (default) and Full access. */
const HERMES_PERMISSION_MODES = new Set(['default', 'bypassPermissions']);

/**
 * "Go ahead" (ROADMAP 3.10c): prefill a plain Hermes task (no expert) that carries out the
 * option the owner picked in a locked chat. Unlike the expert handoff it keeps the source
 * task's folder and access level, because this task is meant to do the work there. Nothing is
 * sent; the owner sees the folder and access level in the composer before sending.
 */
export function prefillGoAheadDraft(
  prompt: string,
  source: { workingDir: string | null; permissionMode: string | null },
): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(prompt),
    attachments: [],
  });
  resetDraftWorkspaceTargets();
  if (source.workingDir) patchDraft({ workingDir: source.workingDir });
  switchVendor('hermes');
  if (source.permissionMode && HERMES_PERMISSION_MODES.has(source.permissionMode)) {
    patchVendorPrefsPreservingModelChoice('hermes', { permissionMode: source.permissionMode });
  }
}
