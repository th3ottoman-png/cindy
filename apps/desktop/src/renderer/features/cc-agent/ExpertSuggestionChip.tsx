/**
 * ExpertSuggestionChip — ROADMAP 7.2 "Smart Intent Expert Suggester",
 * extended by ROADMAP 8.3 "Capability diff on the 7.2 chip".
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
 *
 * 8.3: the slot also diffs the current expert's declared capability set against
 * the suggested one and hands the chip one line of plain English, so a switch
 * is never blind. The diff is pure (`@cindy/maker-core/capability-diff`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExpertEntry } from '@cindy/maker-core/experts';
import {
  suggestExpertForPrompt,
  type ExpertSuggestion,
  type ExpertSuggestionCandidate,
} from '@cindy/maker-core/intent-classifier';
import {
  diffCapabilitySets,
  expertCapabilityDescriptors,
  type ExpertCapabilityFacts,
} from '@cindy/maker-core/capability-diff';

/** An installed expert with everything the diff needs. Structural superset of the 7.2 candidate. */
export type ExpertSuggestionEntry = ExpertCapabilityFacts & ExpertSuggestionCandidate;

export interface ExpertSuggestionChipProps {
  suggestion: ExpertSuggestion;
  /** Ready-to-render 8.3 diff line, e.g. "Switching adds 3 tools, keeps model." */
  diffSummary?: string | null;
  onSwitch: () => void;
  onDismiss: () => void;
}

export function ExpertSuggestionChip({
  suggestion,
  diffSummary,
  onSwitch,
  onDismiss,
}: ExpertSuggestionChipProps) {
  return (
    <div
      data-testid="expert-suggestion-chip"
      data-suggested-slug={suggestion.slug}
      data-diff-summary={diffSummary ?? ''}
      role="status"
      aria-label={`Expert suggestion: ${suggestion.name}`}
      className="mb-2 flex w-full flex-col gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-hover)] px-2.5 py-1.5 text-12"
    >
      <div className="flex w-full items-center gap-2">
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
      {diffSummary ? (
        <div
          data-testid="expert-suggestion-diff"
          className="w-full truncate pl-6 text-[var(--text-tertiary)]"
        >
          {diffSummary}
        </div>
      ) : null}
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
  entries?: readonly ExpertSuggestionEntry[];
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

function loadInstalledExperts(): Promise<readonly ExpertSuggestionEntry[]> {
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
          // 8.3: the declared surface the diff compares. All optional, so an
          // expert file that declares nothing still yields a valid empty set.
          dir: entry.dir,
          model: entry.expert?.model,
          tools: entry.expert?.tools ?? [],
          toolsets: entry.expert?.toolsets ?? [],
          skills: entry.expert?.skills ?? [],
          skillFiles: entry.expert?.skillFiles ?? [],
          toolsFile: entry.expert?.toolsFile,
        })),
    )
    .catch((): readonly ExpertSuggestionEntry[] => []);
}

export function ExpertSuggestionSlot({
  getText,
  subscribe,
  entries,
  onSwitchExpert,
}: ExpertSuggestionSlotProps) {
  const [text, setText] = useState<string>(() => getText());
  const [loadedEntries, setLoadedEntries] = useState<readonly ExpertSuggestionEntry[]>(
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

  // 8.3: what switching would change, computed from the two experts' own files.
  // Pure, so it costs nothing and never blocks the composer.
  const diffSummary = useMemo(() => {
    if (!suggestion) return null;
    const bySlug = new Map<string, ExpertSuggestionEntry>(
      loadedEntries.map((entry) => [entry.slug, entry]),
    );
    const before = expertCapabilityDescriptors(
      pendingSlug ? bySlug.get(pendingSlug) ?? null : null,
    );
    const after = expertCapabilityDescriptors(bySlug.get(suggestion.slug) ?? null);
    const diff = diffCapabilitySets(before, after);
    return diff.phrases.length > 0 ? `Switching ${diff.summary}.` : 'No capability changes.';
  }, [suggestion, loadedEntries, pendingSlug]);

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
      diffSummary={diffSummary}
      onSwitch={handleSwitch}
      onDismiss={silenceForCurrentDraft}
    />
  );
}
