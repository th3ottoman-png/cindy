// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpertSuggestion, ExpertSuggestionCandidate } from '@cindy/maker-core/intent-classifier';

import { ExpertSuggestionChip, ExpertSuggestionSlot } from '../ExpertSuggestionChip';

const ENTRIES: readonly ExpertSuggestionCandidate[] = [
  { slug: 'code-reviewer', name: 'Code Reviewer', tags: ['code', 'review'] },
  {
    slug: 'vault-researcher',
    name: 'Vault Researcher',
    tags: ['notes', 'vault', 'obsidian', 'search', 'memory', 'graph', 'capture'],
  },
];

const CODE_PROMPT = 'Please review this git diff and check for a regression bug';
const VAULT_PROMPT = 'Search my vault notes for backlinks about Cindy';

const SUGGESTION: ExpertSuggestion = {
  slug: 'code-reviewer',
  name: 'Code Reviewer',
  label: 'Code Review',
  score: 9,
  matched: ['git diff', 'review'],
};

type ExpertsApi = {
  list: () => Promise<unknown[]>;
  getPending: () => Promise<string | null>;
  setPending: (slug: string | null) => Promise<string | null>;
  onChanged: (cb: () => void) => () => void;
  onSessionEvent: (cb: (event: unknown) => void) => () => void;
};

function stubExpertsApi(overrides: Partial<ExpertsApi> = {}): ExpertsApi {
  const api: ExpertsApi = {
    list: () => Promise.resolve([]),
    getPending: () => new Promise<string | null>(() => {}),
    setPending: vi.fn(() => Promise.resolve('code-reviewer')),
    onChanged: () => () => {},
    onSessionEvent: () => () => {},
    ...overrides,
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { experts: api } };
  return api;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('ExpertSuggestionChip (presentational)', () => {
  it('renders the exact chip copy and both one-click actions', () => {
    const onSwitch = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ExpertSuggestionChip
        suggestion={SUGGESTION}
        onSwitch={onSwitch}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId('expert-suggestion-label').textContent).toBe(
      'Task resembles Code Review. Switch to Code Reviewer?',
    );
    expect(
      screen.getByTestId('expert-suggestion-chip').getAttribute('data-suggested-slug'),
    ).toBe('code-reviewer');
    expect(screen.getByRole('button', { name: 'Dismiss expert suggestion' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('expert-suggestion-switch'));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('expert-suggestion-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has zero modal lock-in (no dialog, no focus trap, no overlay)', () => {
    render(
      <ExpertSuggestionChip
        suggestion={SUGGESTION}
        onSwitch={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('expert-suggestion-chip').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('expert-suggestion-switch').getAttribute('type')).toBe('button');
  });
});

describe('ExpertSuggestionSlot (container)', () => {
  it('surfaces the Code Reviewer chip for a git / review prompt', () => {
    render(
      <ExpertSuggestionSlot
        getText={() => CODE_PROMPT}
        subscribe={() => () => {}}
        entries={ENTRIES}
        onSwitchExpert={vi.fn()}
      />,
    );
    expect(screen.getByTestId('expert-suggestion-chip').getAttribute('data-suggested-slug')).toBe(
      'code-reviewer',
    );
    expect(screen.getByTestId('expert-suggestion-label').textContent).toContain('Code Reviewer');
  });

  it('surfaces the Vault Researcher chip for a notes / backlink prompt', () => {
    render(
      <ExpertSuggestionSlot
        getText={() => VAULT_PROMPT}
        subscribe={() => () => {}}
        entries={ENTRIES}
        onSwitchExpert={vi.fn()}
      />,
    );
    expect(screen.getByTestId('expert-suggestion-chip').getAttribute('data-suggested-slug')).toBe(
      'vault-researcher',
    );
    expect(screen.getByTestId('expert-suggestion-label').textContent).toContain('Vault Research');
  });

  it('stays invisible for unrelated text and when no experts are installed', () => {
    const { unmount } = render(
      <ExpertSuggestionSlot
        getText={() => 'Tell me a joke about a rubber duck'}
        subscribe={() => () => {}}
        entries={ENTRIES}
        onSwitchExpert={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('expert-suggestion-chip')).toBeNull();
    unmount();

    render(
      <ExpertSuggestionSlot
        getText={() => CODE_PROMPT}
        subscribe={() => () => {}}
        entries={[]}
        onSwitchExpert={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('expert-suggestion-chip')).toBeNull();
  });

  it('Switch applies the expert without clearing the typed prompt', () => {
    const draft = { text: CODE_PROMPT };
    const onSwitchExpert = vi.fn();
    const getText = vi.fn(() => draft.text);
    render(
      <ExpertSuggestionSlot
        getText={getText}
        subscribe={() => () => {}}
        entries={ENTRIES}
        onSwitchExpert={onSwitchExpert}
      />,
    );

    fireEvent.click(screen.getByTestId('expert-suggestion-switch'));

    expect(onSwitchExpert).toHaveBeenCalledWith('code-reviewer');
    expect(draft.text).toBe(CODE_PROMPT);
    expect(screen.queryByTestId('expert-suggestion-chip')).toBeNull();
  });

  it('uses the pending-expert IPC when no switch handler is injected', () => {
    const api = stubExpertsApi();
    render(
      <ExpertSuggestionSlot
        getText={() => CODE_PROMPT}
        subscribe={() => () => {}}
        entries={ENTRIES}
      />,
    );
    fireEvent.click(screen.getByTestId('expert-suggestion-switch'));
    expect(api.setPending).toHaveBeenCalledWith('code-reviewer');
  });

  it('dismiss silences the chip for the current draft while typing continues', () => {
    let listener: (() => void) | null = null;
    const state = { text: CODE_PROMPT };
    const subscribe = (onChange: () => void) => {
      listener = onChange;
      return () => {
        listener = null;
      };
    };
    render(
      <ExpertSuggestionSlot
        getText={() => state.text}
        subscribe={subscribe}
        entries={ENTRIES}
        onSwitchExpert={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('expert-suggestion-dismiss'));
    expect(screen.queryByTestId('expert-suggestion-chip')).toBeNull();

    state.text = `${CODE_PROMPT} and check the tests`;
    act(() => listener?.());
    expect(screen.queryByTestId('expert-suggestion-chip')).toBeNull();
  });

  it('re-arms the suggestion after the draft is cleared', () => {
    let listener: (() => void) | null = null;
    const state = { text: CODE_PROMPT };
    const subscribe = (onChange: () => void) => {
      listener = onChange;
      return () => {
        listener = null;
      };
    };
    render(
      <ExpertSuggestionSlot
        getText={() => state.text}
        subscribe={subscribe}
        entries={ENTRIES}
        onSwitchExpert={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('expert-suggestion-dismiss'));
    expect(screen.queryByTestId('expert-suggestion-chip')).toBeNull();

    state.text = '';
    act(() => listener?.());
    state.text = VAULT_PROMPT;
    act(() => listener?.());

    expect(screen.getByTestId('expert-suggestion-chip').getAttribute('data-suggested-slug')).toBe(
      'vault-researcher',
    );
  });

  it('does not suggest the expert already picked for the draft', async () => {
    stubExpertsApi({
      onSessionEvent: (cb) => {
        cb({ type: 'pending', slug: 'code-reviewer' });
        return () => {};
      },
    });
    render(
      <ExpertSuggestionSlot
        getText={() => CODE_PROMPT}
        subscribe={() => () => {}}
        entries={ENTRIES}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('expert-suggestion-chip')).toBeNull());
  });

  it('loads installed experts from IPC and skips broken entries', async () => {
    stubExpertsApi({
      list: () =>
        Promise.resolve([
          { slug: 'code-reviewer', expert: { name: 'Code Reviewer', tags: ['code', 'review'] } },
          { slug: 'broken', error: 'invalid frontmatter' },
        ]),
    });
    render(
      <ExpertSuggestionSlot
        getText={() => CODE_PROMPT}
        subscribe={() => () => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('expert-suggestion-chip').getAttribute('data-suggested-slug')).toBe(
        'code-reviewer',
      ),
    );
  });

  it('subscribes once and cleans up on unmount', () => {
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const { unmount } = render(
      <ExpertSuggestionSlot
        getText={() => 'nothing to see here'}
        subscribe={subscribe}
        entries={ENTRIES}
        onSwitchExpert={vi.fn()}
      />,
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
