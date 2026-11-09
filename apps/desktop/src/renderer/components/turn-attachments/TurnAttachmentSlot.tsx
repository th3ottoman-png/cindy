import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import {
  attachmentToken,
  attachmentTokenId,
  findAttachmentTrigger,
  parseTurnAttachmentTokens,
  rankAttachmentCandidates,
  resolveTurnAttachments,
  type TurnAttachment,
  type TurnAttachmentCandidate,
} from '@cindy/maker-core/turn-attachment';

import { TurnAttachmentChips, TurnAttachmentPanel } from './TurnAttachmentPanel';
import { loadAttachableCandidates } from './turnAttachmentCandidates';
import { composerPlainText, composerTriggerText, replaceComposerTextRange } from './turnAttachmentDoc';
import { setTurnAttachments } from './turnAttachmentStore';

/**
 * ROADMAP 8.4, turn-scoped `@` attach.
 *
 * The draft text is the only state. Typing `@` opens a popover above the
 * composer; picking a row writes `@kind:id ` into the draft, which is visible,
 * editable and deletable like any other character. The chips are derived from
 * those tokens, so deleting a token by hand removes the chip and nothing can
 * drift out of sync.
 *
 * Nothing here changes the session: no expert is set, no skill is enabled, no
 * model or permission is touched. `handleSend` reads the resolved list once and
 * turns it into a single preamble line for that message.
 *
 * Keys are captured on `document` in the capture phase, so the panel behaves
 * like the other composer palettes without ChatInput knowing it exists.
 */
export interface TurnAttachmentSlotProps {
  draftKey: string;
  getDocument: () => JSONContent | null | undefined;
  subscribe: (onChange: () => void) => () => void;
  /** Write a rewritten document back to the draft (non-silent, so the editor refreshes). */
  saveDocument: (document: JSONContent) => void;
  /** Injected candidates for tests and offline use. */
  candidates?: readonly TurnAttachmentCandidate[];
  loadCandidates?: () => Promise<readonly TurnAttachmentCandidate[]>;
  limit?: number;
}

export function TurnAttachmentSlot({
  draftKey,
  getDocument,
  subscribe,
  saveDocument,
  candidates,
  loadCandidates = loadAttachableCandidates,
  limit = 12,
}: TurnAttachmentSlotProps) {
  const [text, setText] = useState<string>(() => composerPlainText(getDocument()));
  const [triggerText, setTriggerText] = useState<string>(() =>
    composerTriggerText(getDocument()),
  );
  const [loadedCandidates, setLoadedCandidates] = useState<readonly TurnAttachmentCandidate[]>(
    candidates ?? [],
  );
  const [loading, setLoading] = useState(candidates === undefined);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // The parent recreates these inline on every render. Hold them so the
  // subscription is installed once and survives.
  const getDocumentRef = useRef(getDocument);
  getDocumentRef.current = getDocument;
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const saveDocumentRef = useRef(saveDocument);
  saveDocumentRef.current = saveDocument;

  useEffect(() => {
    let alive = true;
    const read = () => {
      if (!alive) return;
      const doc = getDocumentRef.current();
      setText(composerPlainText(doc));
      setTriggerText(composerTriggerText(doc));
    };
    read();
    const off = subscribeRef.current(read);
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (candidates) {
      setLoadedCandidates(candidates);
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    void loadCandidates()
      .then((list) => {
        if (alive) setLoadedCandidates(list);
      })
      .catch(() => {
        if (alive) setLoadedCandidates([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [candidates, loadCandidates]);

  const tokens = useMemo(() => parseTurnAttachmentTokens(text), [text]);

  // The trailing space after a finished token is what closes the panel, so the
  // trigger reads the untrimmed text. A bare `@` stays with the composer's own
  // file panel; only a capability-shaped query hands ownership over here.
  const trigger = useMemo(() => findAttachmentTrigger(triggerText), [triggerText]);

  const open =
    trigger !== null && trigger.kindHint !== null && dismissedAt !== trigger.start;

  const ranked = useMemo(
    () => (trigger ? rankAttachmentCandidates(loadedCandidates, trigger, limit) : []),
    [trigger, loadedCandidates, limit],
  );

  const attached = useMemo(
    () => resolveTurnAttachments(tokens, loadedCandidates),
    [tokens, loadedCandidates],
  );

  // Publish the resolved list for the send path. Cleared as soon as the draft
  // no longer carries the tokens.
  useEffect(() => {
    setTurnAttachments(draftKey, attached);
  }, [draftKey, attached]);

  // A new query is a new list, so the highlight starts at the top.
  useEffect(() => {
    setFocusedIndex(0);
  }, [trigger?.start, trigger?.term]);

  // An emptied composer is a new draft: a dismissal must not outlive it.
  useEffect(() => {
    if (text.trim() === '') setDismissedAt(null);
  }, [text]);

  const select = useCallback((item: TurnAttachmentCandidate) => {
    const currentDocument = getDocumentRef.current();
    const currentText = composerPlainText(currentDocument);
    const currentTrigger = findAttachmentTrigger(currentText);
    if (!currentTrigger) return;

    const nextDocument = replaceComposerTextRange(
      currentDocument,
      currentTrigger.start,
      currentTrigger.end,
      `${attachmentToken(item)} `,
    );
    if (!nextDocument) return;
    saveDocumentRef.current(nextDocument);
    setFocusedIndex(0);
  }, []);

  const remove = useCallback((item: TurnAttachment) => {
    const currentDocument = getDocumentRef.current();
    const currentText = composerPlainText(currentDocument);
    const token = parseTurnAttachmentTokens(currentText).find(
      (candidate) =>
        candidate.kind === item.kind && candidate.id === attachmentTokenId(item.id),
    );
    if (!token) return;

    // Take the separating space with it so the prose closes up.
    let start = token.start;
    let end = token.end;
    if (currentText[end] === ' ') end += 1;
    else if (start > 0 && currentText[start - 1] === ' ') start -= 1;

    const nextDocument = replaceComposerTextRange(currentDocument, start, end, '');
    if (!nextDocument) return;
    saveDocumentRef.current(nextDocument);
  }, []);

  useEffect(() => {
    if (!open || !trigger) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(trigger.start);
        return;
      }
      if (ranked.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setFocusedIndex((index) => (index + 1) % ranked.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setFocusedIndex((index) => (index - 1 + ranked.length) % ranked.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        select(ranked[Math.min(focusedIndex, ranked.length - 1)]);
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, trigger, ranked, focusedIndex, select]);

  if (!text && attached.length === 0) return null;

  return (
    <div className="relative w-full" data-testid="turn-attachment-slot">
      {open && trigger && (
        <TurnAttachmentPanel
          query={trigger.query}
          items={ranked}
          focusedIndex={Math.min(focusedIndex, Math.max(ranked.length - 1, 0))}
          onFocusedIndexChange={setFocusedIndex}
          onSelect={select}
          onClose={() => setDismissedAt(trigger.start)}
          loading={loading}
        />
      )}
      <TurnAttachmentChips items={attached} onRemove={remove} />
    </div>
  );
}
