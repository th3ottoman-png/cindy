import { useCallback, useEffect, useRef, useState } from 'react';
import {
  nextTurnSuggestionKey,
  suggestNextTurn,
  type NextTurnSuggestion,
} from '@cindy/maker-core/next-turn-suggestion';

import {
  getDraft,
  plainTextToTiptapDoc,
  saveDraft,
  type ComposerDraft,
} from '@/lib/composerDraftStore';
import { makerChatStore } from '@/lib/makerChatStore';
import { composerPlainText } from '@/components/turn-attachments/turnAttachmentDoc';

/**
 * ROADMAP 9.1 — interactive next-turn suggestion pill.
 * ---------------------------------------------------------------------------
 * One short phrase below the composer, taken from the agent's own closing line.
 * It is a sibling of the composer, not a modal: no focus trap, no keyboard
 * capture, Enter still sends whatever the owner typed. Clicking the pill writes
 * the phrase into the draft; the ✕ hides it for that message. Nothing is ever
 * sent automatically, and nothing here changes the chat loop.
 *
 * `NextTurnSuggestionPillView` is the pure presentation half.
 * `NextTurnSuggestionPill` is the thin container: it reads the session snapshot
 * once a second (the store notifies on every token delta, and a suggestion only
 * matters at turn end), then writes the chosen phrase into the draft store.
 */

/** The subset of the session snapshot this feature needs. */
export interface NextTurnSnapshot {
  isStreaming: boolean;
  messages: readonly {
    clientId?: string;
    role: string;
    content?: string;
    toolName?: string;
  }[];
  pendingPermission?: unknown;
  pendingAskUser?: unknown;
}

interface DraftIo {
  getDraft: (key: string) => ComposerDraft | undefined;
  saveDraft: (key: string, draft: ComposerDraft) => void;
}

const DEFAULT_DRAFT_IO: DraftIo = {
  getDraft,
  saveDraft: (key, draft) => saveDraft(key, draft),
};

export interface NextTurnSuggestionPillProps {
  sessionId: string;
  /** Draft key the composer is bound to (`composerDraftKey` in the session view). */
  draftKey: string;
  disabled?: boolean;
  /** Tests only. Defaults to `makerChatStore.getSnapshot`. */
  readSnapshot?: (sessionId: string) => NextTurnSnapshot;
  /** Tests only. Defaults to the real draft store. */
  draftIo?: DraftIo;
  /** Tests only. Poll interval; production uses 1000 ms. */
  pollMs?: number;
}

export function NextTurnSuggestionPillView({
  suggestion,
  onInsert,
  onDismiss,
  className,
}: {
  suggestion: NextTurnSuggestion;
  onInsert: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      data-testid="next-turn-suggestion"
      data-reason={suggestion.reason}
      data-text={suggestion.text}
      role="status"
      aria-label={`Next turn suggestion: ${suggestion.text}`}
      className={className ?? 'mt-1 flex w-full items-center gap-1.5 px-1 text-12'}
    >
      <span aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]">
        ✦
      </span>
      <button
        type="button"
        data-testid="next-turn-suggestion-insert"
        title={suggestion.sourceLine}
        onClick={onInsert}
        className="min-w-0 flex-1 truncate rounded-md border border-[var(--border-default)] bg-[var(--surface-hover)] px-2 py-0.5 text-left text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        {suggestion.label}
      </button>
      <button
        type="button"
        aria-label="Dismiss next-turn suggestion"
        data-testid="next-turn-suggestion-dismiss"
        onClick={onDismiss}
        className="shrink-0 px-1 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The final message, and only when it is plain assistant text. A tool bubble, a
 * pending permission card or a streaming turn means the agent has not finished
 * speaking, so there is nothing to suggest. Older assistant messages are never
 * used: a suggestion must belong to the turn that just ended.
 */
export function lastAssistantText(snapshot: NextTurnSnapshot): {
  clientId: string;
  content: string;
} | null {
  if (snapshot.isStreaming) return null;
  if (snapshot.pendingPermission || snapshot.pendingAskUser) return null;
  const messages = snapshot.messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.toolName) return null;
  const content = last.content ?? '';
  if (content.trim() === '') return null;
  return { clientId: last.clientId ?? `assistant-${messages.length - 1}`, content };
}

export function NextTurnSuggestionPill({
  sessionId,
  draftKey,
  disabled = false,
  readSnapshot,
  draftIo,
  pollMs = 1_000,
}: NextTurnSuggestionPillProps) {
  const [state, setState] = useState<{
    identity: string;
    suggestion: NextTurnSuggestion;
  } | null>(null);
  // Dismissal is scoped to one message, not to the session: a later turn brings
  // a fresh suggestion even if this one was rejected.
  const dismissedRef = useRef<string | null>(null);
  const io = draftIo ?? DEFAULT_DRAFT_IO;

  useEffect(() => {
    if (!sessionId || disabled) {
      setState(null);
      return undefined;
    }
    const read = readSnapshot ?? ((id: string) => makerChatStore.getSnapshot(id));
    const tick = () => {
      const latest = lastAssistantText(read(sessionId));
      const next = latest ? suggestNextTurn(latest.content) : null;
      if (!latest || !next) {
        setState((prev) => (prev === null ? prev : null));
        return;
      }
      const identity = `${latest.clientId}:${nextTurnSuggestionKey(next)}`;
      if (dismissedRef.current === identity) {
        setState((prev) => (prev === null ? prev : null));
        return;
      }
      setState((prev) => (prev?.identity === identity ? prev : { identity, suggestion: next }));
    };
    tick();
    const id = window.setInterval(tick, pollMs);
    return () => window.clearInterval(id);
  }, [disabled, pollMs, readSnapshot, sessionId]);

  const insert = useCallback(() => {
    if (!state) return;
    const existing = io.getDraft(draftKey);
    const current = composerPlainText(existing?.text).trimEnd();
    const nextText = current === '' ? state.suggestion.text : `${current}\n${state.suggestion.text}`;
    io.saveDraft(draftKey, {
      ...existing,
      text: plainTextToTiptapDoc(nextText),
      attachments: existing?.attachments ?? [],
      browserComments: existing?.browserComments ?? [],
      focusAtEnd: true,
    });
    dismissedRef.current = state.identity;
    setState(null);
  }, [draftKey, io, state]);

  const dismiss = useCallback(() => {
    if (!state) return;
    dismissedRef.current = state.identity;
    setState(null);
  }, [state]);

  if (!state) return null;
  return (
    <NextTurnSuggestionPillView
      suggestion={state.suggestion}
      onInsert={insert}
      onDismiss={dismiss}
    />
  );
}
