import type { TurnAttachment } from '@cindy/maker-core/turn-attachment';

/**
 * Draft-scoped lookup of resolved turn attachments (ROADMAP 8.4).
 *
 * The draft text is the source of truth: `TurnAttachmentSlot` re-derives this
 * list from the tokens on every composer change. This module exists only so the
 * send path, which lives in a different component, can read the resolved source
 * paths without re-reading every capability source.
 *
 * It is a cache, not session state. Nothing here enables, disables or writes a
 * capability. Entries are dropped as soon as the draft no longer contains them.
 */
const attachmentsByDraft = new Map<string, TurnAttachment[]>();

export function setTurnAttachments(
  draftKey: string,
  items: readonly TurnAttachment[],
): void {
  if (items.length === 0) {
    attachmentsByDraft.delete(draftKey);
    return;
  }
  attachmentsByDraft.set(draftKey, [...items]);
}

export function getTurnAttachments(draftKey: string): TurnAttachment[] {
  return attachmentsByDraft.get(draftKey) ?? [];
}

export function clearTurnAttachments(draftKey: string): void {
  attachmentsByDraft.delete(draftKey);
}
