/**
 * Response style + thinking display (ROADMAP 10.2).
 *
 * Two owner preferences that only change *rendering*:
 *   - `responseStyle`   `concise` = today's one-line tool rows, `detailed` = tool rows open with
 *                       their raw command and output.
 *   - `thinkingDisplay` `collapsed` (default) / `expanded` / `hidden` for models that stream
 *                       reasoning.
 *
 * Nothing here touches the transcript: the store keeps every thinking block and every tool result,
 * so `hidden` is a view, not a deletion. Persisted in `localStorage` per owner (the desktop is
 * single-user), and published through `useSyncExternalStore` so a chat that is already on screen
 * re-renders the moment the preference changes — no reload, no remount.
 */

import { useSyncExternalStore } from 'react';

export type ResponseStyle = 'concise' | 'detailed';
export type ThinkingDisplay = 'collapsed' | 'expanded' | 'hidden';

export interface ResponsePreferences {
  responseStyle: ResponseStyle;
  thinkingDisplay: ThinkingDisplay;
  /** ROADMAP 13.6: keep each message's clock time visible instead of hover-only. */
  showTimestamps: boolean;
}

export const RESPONSE_PREFERENCES_KEY = 'cindy.responsePreferences.v1';

export const DEFAULT_RESPONSE_PREFERENCES: ResponsePreferences = {
  responseStyle: 'concise',
  thinkingDisplay: 'collapsed',
  showTimestamps: false,
};

const STYLES: readonly ResponseStyle[] = ['concise', 'detailed'];
const DISPLAYS: readonly ThinkingDisplay[] = ['collapsed', 'expanded', 'hidden'];

/** Never throws and never invents a third state: an unknown value falls back to the default. */
export function parseResponsePreferences(raw: unknown): ResponsePreferences {
  if (typeof raw === 'string') {
    try {
      return parseResponsePreferences(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_RESPONSE_PREFERENCES };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_RESPONSE_PREFERENCES };
  const value = raw as Record<string, unknown>;
  const responseStyle = STYLES.includes(value.responseStyle as ResponseStyle)
    ? (value.responseStyle as ResponseStyle)
    : DEFAULT_RESPONSE_PREFERENCES.responseStyle;
  const thinkingDisplay = DISPLAYS.includes(value.thinkingDisplay as ThinkingDisplay)
    ? (value.thinkingDisplay as ThinkingDisplay)
    : DEFAULT_RESPONSE_PREFERENCES.thinkingDisplay;
  // Only an explicit true turns it on, so a stored v1 value without the field stays off.
  return { responseStyle, thinkingDisplay, showTimestamps: value.showTimestamps === true };
}

/** What a tool row should do under a style. `concise` keeps the row closed, as it ships today. */
export function toolRowDefaultExpanded(style: ResponseStyle): boolean {
  return style === 'detailed';
}

/**
 * How a thinking block renders. `hidden` still keeps the text in the store — the caller renders
 * nothing, it does not drop the message.
 */
export function resolveThinkingVisibility(mode: ThinkingDisplay): 'hidden' | 'collapsed' | 'expanded' {
  if (mode === 'hidden') return 'hidden';
  return mode === 'expanded' ? 'expanded' : 'collapsed';
}

type Listener = () => void;

let current: ResponsePreferences | null = null;
const listeners = new Set<Listener>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // private mode / disabled storage: the preference still works for this run
  }
}

function load(): ResponsePreferences {
  const store = storage();
  return parseResponsePreferences(store?.getItem(RESPONSE_PREFERENCES_KEY) ?? null);
}

/** Current preferences. Safe during SSR and in tests without a DOM. */
export function readResponsePreferences(): ResponsePreferences {
  if (!current) current = load();
  return current;
}

export function writeResponsePreferences(patch: Partial<ResponsePreferences>): ResponsePreferences {
  const next = parseResponsePreferences({ ...readResponsePreferences(), ...patch });
  current = next;
  const store = storage();
  try {
    store?.setItem(RESPONSE_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode: keep the in-memory value rather than losing the change outright.
  }
  for (const listener of [...listeners]) listener();
  return next;
}

export function subscribeResponsePreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the cached value (and re-read storage on the next access). */
export function resetResponsePreferencesForTests(): void {
  current = null;
  listeners.clear();
}

export function useResponsePreferences(): ResponsePreferences {
  return useSyncExternalStore(subscribeResponsePreferences, readResponsePreferences, readResponsePreferences);
}
