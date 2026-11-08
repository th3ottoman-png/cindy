/**
 * ExpertSuggestionChip — ROADMAP 7.2 "Smart Intent Expert Suggester".
 * ---------------------------------------------------------------------------
 * A non-intrusive, one-click chip shown above the new-task composer. It is a
 * plain sibling of the composer: no modal, no focus trap, no keyboard capture.
 * Enter still submits the draft. The chip can be ignored completely.
 *
 * `ExpertSuggestionChip` is the pure presentational half (no store, no IPC).
 * `ExpertSuggestionSlot` is the thin container: it reads composer text, loads
 * installed experts, tracks the already-picked expert and handles dismissal.
 * Switching uses the existing `maker.experts.setPending` IPC, which broadcasts
 * an `EXPERTS_SESSION_EVENT` so HermesExpertPicker updates its badge too.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExpertEntry } from '@cindy/maker-core/experts';
import {
  suggestExpertForPrompt,
  type ExpertSuggestion,
  type ExpertSuggestionCandidate,
} from '@cindy/maker-core/intent-classifier';

export interface ExpertSuggestionChipProps {
  suggestion: ExpertSuggestion;
  onSwitch: () => void;
  onDismiss: () => void;
}

export function ExpertSuggestionChip({
  suggestion,
  onSwitch,
  onDismiss,
}: ExpertSuggestionChipProps) {
  return (
    <div
      data-testid="expert-suggestion-chip"
      data-suggested-slug={suggestion.slug}
      role="status"
      aria-label={`Expert suggestion: ${suggestion.name}`}
      className="mb-2 flex w-full items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--surface-hover)] px-2.5 py-1.5 text-12"
    >
      <span aria-hidden="true">✨</span>
      <span
        data-testid="expert-suggestion-label"
        className="min-w-0 flex-1 truncate text-[var(--text-secondary)]"
      >
        Task resembles {suggestion.label}. Switch to {suggestion.name}?
      </span>
      <button
        type="button"
        data-testid="expert-suggestion-switch"
        className="shrink-0 rounded-md border border-[var(--border-default)] px-2 py-0.5 font-medium text-[var(--text-primary)] transition-opacity hover:opacity-70"
        onClick={onSwitch}
      >
        Switch
      </button>
      <button
        type="button"
        aria-label="Dismiss expert suggestion"
        data-testid="expert-suggestion-dismiss"
        className="shrink-0 px-1 text-[var(--text-secondary)] transition-opacity hover:opacity-70"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}

interface DismissedSuggestion {
  slug: string;
  text: string;
}

export interface ExpertSuggestionSlotProps {
  /** Current composer text. The slot never writes to the draft. */
  getText: () => string;
  /** Subscribe to composer text changes. Returns an unsubscribe function. */
  subscribe: (onChange: () => void) => () => void;
  /** Injected expert list (tests / offline). Defaults to the IPC expert list. */
  entries?: readonly ExpertSuggestionCandidate[];
  /** Injected switch action (tests). Defaults to the pending-expert IPC. */
  onSwitchExpert?: (slug: string) => void;
}

function expertsApi(): typeof window.electronAPI.maker.experts | null {
  try {
    return window.electronAPI?.maker?.experts ?? null;
  } catch {
    return null;
  }
}

function loadInstalledExperts(): Promise<readonly ExpertSuggestionCandidate[]> {
  const api = expertsApi();
  if (!api || typeof api.list !== 'function') return Promise.resolve([]);
  return api
    .list()
    .then((list: readonly ExpertEntry[]) =>
      list
        .filter((entry) => !entry.error)
        .map((entry) => ({
          slug: entry.slug,
          name: entry.expert?.name ?? entry.slug,
          tags: entry.expert?.tags ?? [],
        })),
    )
    .catch((): readonly ExpertSuggestionCandidate[] => []);
}

export function ExpertSuggestionSlot({
  getText,
  subscribe,
  entries,
  onSwitchExpert,
}: ExpertSuggestionSlotProps) {
  const [text, setText] = useState<string>(() => getText());
  const [loadedEntries, setLoadedEntries] = useState<readonly ExpertSuggestionCandidate[]>(
    entries ?? [],
  );
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<DismissedSuggestion | null>(null);

  // Hold the latest props so the composer subscription is installed once and
  // survives the inline arrow functions the parent recreates on every render.
  const getTextRef = useRef(getText);
  getTextRef.current = getText;
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  useEffect(() => {
    let alive = true;
    const read = () => {
      if (alive) setText(getTextRef.current());
    };
    read();
    const off = subscribeRef.current(read);
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (entries) {
      setLoadedEntries(entries);
      return undefined;
    }
    let alive = true;
    const refresh = () => {
      void loadInstalledExperts().then((list) => {
        if (alive) setLoadedEntries(list);
      });
    };
    refresh();
    const off = expertsApi()?.onChanged?.(refresh);
    return () => {
      alive = false;
      off?.();
    };
  }, [entries]);

  useEffect(() => {
    const api = expertsApi();
    if (!api) return undefined;
    let alive = true;
    if (typeof api.getPending === 'function') {
      void api
        .getPending()
        .then((slug) => {
          if (alive) setPendingSlug(slug ?? null);
        })
        .catch(() => undefined);
    }
    const off = api.onSessionEvent?.((rawEvent) => {
      const event = rawEvent as { type?: string; slug?: string | null };
      if (event?.type === 'pending') setPendingSlug(event.slug ?? null);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // A cleared composer is a new draft, so a previous dismissal no longer applies.
  useEffect(() => {
    if (text.trim() === '') setDismissed(null);
  }, [text]);

  const suggestion = useMemo(
    () => suggestExpertForPrompt(text, loadedEntries, { excludeSlug: pendingSlug }),
    [text, loadedEntries, pendingSlug],
  );

  // Dismissal covers the current draft: typing on keeps it quiet, rewriting or
  // clearing the prompt lets a fresh suggestion surface.
  const isDismissed = useMemo(() => {
    if (!dismissed || !suggestion) return false;
    return dismissed.slug === suggestion.slug && text.trim().startsWith(dismissed.text);
  }, [dismissed, suggestion, text]);

  const silenceForCurrentDraft = () => {
    if (!suggestion) return;
    setDismissed({ slug: suggestion.slug, text: text.trim() });
  };

  const handleSwitch = () => {
    if (!suggestion) return;
    const slug = suggestion.slug;
    silenceForCurrentDraft();
    if (onSwitchExpert) {
      onSwitchExpert(slug);
      return;
    }
    const api = expertsApi();
    if (api && typeof api.setPending === 'function') {
      void api.setPending(slug).catch(() => undefined);
    }
  };

  if (!suggestion || isDismissed) return null;
  return (
    <ExpertSuggestionChip
      suggestion={suggestion}
      onSwitch={handleSwitch}
      onDismiss={silenceForCurrentDraft}
    />
  );
}
