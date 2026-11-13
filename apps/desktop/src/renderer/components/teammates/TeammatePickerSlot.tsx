import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { findTeammateMentionTrigger } from '@cindy/maker-core/teammate-mention';

import { TeammatePickerPanel } from './TeammatePickerPanel';
import {
  loadTeammatePickerCandidates,
  rankTeammateCandidates,
  type TeammatePickerCandidate,
} from './teammatePickerRoster';
import { composerPlainText, composerTriggerText, replaceComposerTextRange } from '../turn-attachments/turnAttachmentDoc';

/**
 * ROADMAP 12.3b: the @agent: teammate picker.
 *
 * Same contract as the 8.4 TurnAttachmentSlot: the draft text is the only state.
 * Typing `@agent:` opens a popover above the composer (ownership hands over at the
 * colon — bare `@` stays with the file/agent panel); picking a row writes
 * `@agent:<roster-id> ` into the draft, visible and editable like any other character.
 * The teammate itself joins at send time (12.3a), never here.
 *
 * Keys are captured on `document` in the capture phase, so the panel behaves like
 * the other composer palettes without ChatInput knowing it exists.
 */
export interface TeammatePickerSlotProps {
  getDocument: () => JSONContent | null | undefined;
  subscribe: (onChange: () => void) => () => void;
  /** Write a rewritten document back to the draft (non-silent, so the editor refreshes). */
  saveDocument: (document: JSONContent) => void;
  /** Scopes imported project agents, same as the Agents page. */
  projectDir?: string | null;
  /** Injected candidates for tests and offline use. */
  candidates?: readonly TeammatePickerCandidate[];
  loadCandidates?: (projectDir: string | null) => Promise<readonly TeammatePickerCandidate[]>;
  limit?: number;
}

export function TeammatePickerSlot({
  getDocument,
  subscribe,
  saveDocument,
  projectDir = null,
  candidates,
  loadCandidates = loadTeammatePickerCandidates,
  limit = 12,
}: TeammatePickerSlotProps) {
  const [text, setText] = useState<string>(() => composerPlainText(getDocument()));
  const [triggerText, setTriggerText] = useState<string>(() => composerTriggerText(getDocument()));
  const [loadedCandidates, setLoadedCandidates] = useState<readonly TeammatePickerCandidate[]>(candidates ?? []);
  const [loading, setLoading] = useState(candidates === undefined);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // The parent recreates these inline on every render; hold them so the subscription
  // is installed once and survives.
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
    // The draft store notifies on save, but a cold-start mount can subscribe before the
    // owner-namespaced draft key settles (found live in the 12.3b proof). A light poll is the
    // safety net so the trigger is never missed; equal strings make setText a no-op.
    const poll = setInterval(read, 250);
    return () => {
      alive = false;
      off();
      clearInterval(poll);
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
    void loadCandidates(projectDir)
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
  }, [candidates, loadCandidates, projectDir]);

  // The trailing space after a finished token is what closes the panel, so the trigger
  // reads the untrimmed text (same rule as 8.4).
  const trigger = useMemo(() => findTeammateMentionTrigger(triggerText), [triggerText]);
  const open = trigger !== null && dismissedAt !== trigger.start;

  const ranked = useMemo(
    () => (trigger ? rankTeammateCandidates(loadedCandidates, trigger.term, limit) : []),
    [trigger, loadedCandidates, limit],
  );

  // A new query is a new list, so the highlight starts at the top.
  useEffect(() => {
    setFocusedIndex(0);
  }, [trigger?.start, trigger?.term]);

  // An emptied composer is a new draft: a dismissal must not outlive it.
  useEffect(() => {
    if (text.trim() === '') setDismissedAt(null);
  }, [text]);

  const select = useCallback((item: TeammatePickerCandidate) => {
    if (item.disabled) return;
    const currentDocument = getDocumentRef.current();
    const currentText = composerTriggerText(currentDocument);
    const currentTrigger = findTeammateMentionTrigger(currentText);
    if (!currentTrigger) return;
    const nextDocument = replaceComposerTextRange(
      currentDocument,
      currentTrigger.start,
      currentTrigger.end,
      `@agent:${item.id} `,
    );
    if (!nextDocument) return;
    saveDocumentRef.current(nextDocument);
    setFocusedIndex(0);
  }, []);

  useEffect(() => {
    if (!open || !trigger) return undefined;

    const moveFocus = (direction: 1 | -1) => {
      setFocusedIndex((index) => {
        const count = ranked.length;
        if (count === 0) return 0;
        for (let step = 1; step <= count; step += 1) {
          const next = (index + direction * step + count * step) % count;
          if (!ranked[next].disabled) return next;
        }
        return index;
      });
    };

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
        moveFocus(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        moveFocus(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = ranked[Math.min(focusedIndex, ranked.length - 1)];
        if (item.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        select(item);
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, trigger, ranked, focusedIndex, select]);

  if (!open || !trigger) return null;

  return (
    <div className="relative w-full" data-testid="teammate-picker-slot">
      <TeammatePickerPanel
        query={trigger.term}
        items={ranked}
        focusedIndex={Math.min(focusedIndex, Math.max(ranked.length - 1, 0))}
        onFocusedIndexChange={setFocusedIndex}
        onSelect={select}
        onClose={() => setDismissedAt(trigger.start)}
        loading={loading}
      />
    </div>
  );
}
