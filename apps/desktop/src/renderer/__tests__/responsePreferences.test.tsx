// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RESPONSE_PREFERENCES,
  RESPONSE_PREFERENCES_KEY,
  parseResponsePreferences,
  readResponsePreferences,
  resetResponsePreferencesForTests,
  resolveThinkingVisibility,
  subscribeResponsePreferences,
  toolRowDefaultExpanded,
  useResponsePreferences,
  writeResponsePreferences,
} from '@/lib/responsePreferences';

function Probe() {
  const preferences = useResponsePreferences();
  return (
    <div>
      <span data-testid="style">{preferences.responseStyle}</span>
      <span data-testid="thinking">{preferences.thinkingDisplay}</span>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetResponsePreferencesForTests();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetResponsePreferencesForTests();
});

describe('parseResponsePreferences', () => {
  it('falls back to the shipped defaults for anything it did not write', () => {
    for (const raw of [null, undefined, '', '{', '[]', 42, [], {}, { responseStyle: 'loud' }, { thinkingDisplay: 'shown' }]) {
      expect(parseResponsePreferences(raw)).toEqual(DEFAULT_RESPONSE_PREFERENCES);
    }
  });

  it('keeps each value independently valid', () => {
    expect(parseResponsePreferences({ responseStyle: 'detailed', thinkingDisplay: 'nope' })).toEqual({
      responseStyle: 'detailed',
      thinkingDisplay: 'collapsed',
    });
    expect(parseResponsePreferences('{"thinkingDisplay":"hidden"}')).toEqual({
      responseStyle: 'concise',
      thinkingDisplay: 'hidden',
    });
  });
});

describe('persistence', () => {
  it('survives a restart: the value is read back from storage, not from the cache', () => {
    writeResponsePreferences({ responseStyle: 'detailed', thinkingDisplay: 'expanded' });
    expect(JSON.parse(window.localStorage.getItem(RESPONSE_PREFERENCES_KEY) ?? 'null')).toEqual({
      responseStyle: 'detailed',
      thinkingDisplay: 'expanded',
    });
    // A restart loses the module cache but keeps localStorage.
    resetResponsePreferencesForTests();
    expect(readResponsePreferences()).toEqual({ responseStyle: 'detailed', thinkingDisplay: 'expanded' });
  });

  it('merges a partial change instead of resetting the other value', () => {
    writeResponsePreferences({ thinkingDisplay: 'hidden' });
    writeResponsePreferences({ responseStyle: 'detailed' });
    expect(readResponsePreferences()).toEqual({ responseStyle: 'detailed', thinkingDisplay: 'hidden' });
  });
});

describe('applies to a transcript already on screen', () => {
  it('re-renders a mounted consumer the moment the preference changes', () => {
    render(<Probe />);
    expect(screen.getByTestId('style').textContent).toBe('concise');
    // No remount, no reload: the same tree updates through useSyncExternalStore.
    act(() => {
      writeResponsePreferences({ responseStyle: 'detailed', thinkingDisplay: 'hidden' });
    });
    expect(screen.getByTestId('style').textContent).toBe('detailed');
    expect(screen.getByTestId('thinking').textContent).toBe('hidden');
  });

  it('notifies every subscriber and stops after unsubscribe', () => {
    let calls = 0;
    const off = subscribeResponsePreferences(() => {
      calls += 1;
    });
    writeResponsePreferences({ responseStyle: 'detailed' });
    expect(calls).toBe(1);
    off();
    writeResponsePreferences({ responseStyle: 'concise' });
    expect(calls).toBe(1);
  });
});

describe('rendering rules', () => {
  it('opens tool rows only in detailed', () => {
    expect(toolRowDefaultExpanded('concise')).toBe(false);
    expect(toolRowDefaultExpanded('detailed')).toBe(true);
  });

  it('maps the three thinking modes, and hidden is only a view', () => {
    expect(resolveThinkingVisibility('collapsed')).toBe('collapsed');
    expect(resolveThinkingVisibility('expanded')).toBe('expanded');
    expect(resolveThinkingVisibility('hidden')).toBe('hidden');
    // Switching back must recover it: the preference is the only thing that changed.
    writeResponsePreferences({ thinkingDisplay: 'hidden' });
    writeResponsePreferences({ thinkingDisplay: 'collapsed' });
    expect(resolveThinkingVisibility(readResponsePreferences().thinkingDisplay)).toBe('collapsed');
  });
});
