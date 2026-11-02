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
import { resetDraftWorkspaceTargets, switchVendor } from '@/state/newMakerDraft';

export function prefillExpertHandoffDraft(prompt: string): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(prompt),
    attachments: [],
  });
  resetDraftWorkspaceTargets();
  switchVendor('hermes');
}
