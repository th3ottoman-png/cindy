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
      showTimestamps: false,
    });
    expect(parseResponsePreferences('{"thinkingDisplay":"hidden"}')).toEqual({
      responseStyle: 'concise',
      thinkingDisplay: 'hidden',
      showTimestamps: false,
    });
  });
});

describe('persistence', () => {
  it('survives a restart: the value is read back from storage, not from the cache', () => {
    writeResponsePreferences({ responseStyle: 'detailed', thinkingDisplay: 'expanded' });
    expect(JSON.parse(window.localStorage.getItem(RESPONSE_PREFERENCES_KEY) ?? 'null')).toEqual({
      responseStyle: 'detailed',
      thinkingDisplay: 'expanded',
      showTimestamps: false,
    });
    // A restart loses the module cache but keeps localStorage.
    resetResponsePreferencesForTests();
    expect(readResponsePreferences()).toEqual({ responseStyle: 'detailed', thinkingDisplay: 'expanded', showTimestamps: false });
  });

  it('merges a partial change instead of resetting the other value', () => {
    writeResponsePreferences({ thinkingDisplay: 'hidden' });
    writeResponsePreferences({ responseStyle: 'detailed' });
    expect(readResponsePreferences()).toEqual({ responseStyle: 'detailed', thinkingDisplay: 'hidden', showTimestamps: false });
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

describe('showTimestamps (ROADMAP 13.6)', () => {
  it('defaults to off, including for a stored v1 value without the field', () => {
    expect(DEFAULT_RESPONSE_PREFERENCES.showTimestamps).toBe(false);
    expect(parseResponsePreferences({ responseStyle: 'detailed', thinkingDisplay: 'expanded' }).showTimestamps).toBe(false);
    expect(parseResponsePreferences(null).showTimestamps).toBe(false);
  });

  it('only an explicit true turns it on', () => {
    expect(parseResponsePreferences({ showTimestamps: true }).showTimestamps).toBe(true);
    for (const value of ['true', 1, 'yes', null]) {
      expect(parseResponsePreferences({ showTimestamps: value }).showTimestamps).toBe(false);
    }
  });

  it('round-trips through storage without disturbing the other preferences', () => {
    writeResponsePreferences({ responseStyle: 'detailed' });
    writeResponsePreferences({ showTimestamps: true });
    const stored = JSON.parse(window.localStorage.getItem(RESPONSE_PREFERENCES_KEY) ?? '{}');
    expect(stored).toEqual({ responseStyle: 'detailed', thinkingDisplay: 'collapsed', showTimestamps: true });
    resetResponsePreferencesForTests();
    expect(readResponsePreferences()).toEqual({ responseStyle: 'detailed', thinkingDisplay: 'collapsed', showTimestamps: true });
  });

  it('reaches an already-mounted consumer without a remount', () => {
    function StampProbe() {
      return <span data-testid="stamps">{String(useResponsePreferences().showTimestamps)}</span>;
    }
    render(<StampProbe />);
    expect(screen.getByTestId('stamps').textContent).toBe('false');
    act(() => { writeResponsePreferences({ showTimestamps: true }); });
    expect(screen.getByTestId('stamps').textContent).toBe('true');
  });
});
