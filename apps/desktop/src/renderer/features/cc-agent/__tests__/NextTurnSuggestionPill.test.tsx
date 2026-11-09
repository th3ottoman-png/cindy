// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ComposerDraft } from '@/lib/composerDraftStore';
import { plainTextToTiptapDoc } from '@/lib/composerDraftStore';
import { composerPlainText } from '@/components/turn-attachments/turnAttachmentDoc';
import {
  lastAssistantText,
  NextTurnSuggestionPill,
  NextTurnSuggestionPillView,
  type NextTurnSnapshot,
} from '../NextTurnSuggestionPill';

afterEach(() => {
  cleanup();
});

const NEXT_ACTION = [
  'Phase 8.4 is committed as `63a32c673d`.',
  '',
  '**Next action (1 min):** say `go 8.1` for the Library workspace.',
].join('\n');

function snapshot(overrides: Partial<NextTurnSnapshot> = {}): NextTurnSnapshot {
  return {
    isStreaming: false,
    messages: [{ clientId: 'm1', role: 'assistant', content: NEXT_ACTION }],
    ...overrides,
  };
}

function harness(initial?: NextTurnSnapshot) {
  let current = initial ?? snapshot();
  const drafts = new Map<string, ComposerDraft>();
  const saved: ComposerDraft[] = [];
  const io = {
    getDraft: (key: string) => drafts.get(key),
    saveDraft: (key: string, draft: ComposerDraft) => {
      drafts.set(key, draft);
      saved.push(draft);
    },
  };
  const ui = (props: { disabled?: boolean } = {}) => (
    <NextTurnSuggestionPill
      sessionId="session-1"
      draftKey="session-1"
      readSnapshot={() => current}
      draftIo={io}
      pollMs={20}
      {...props}
    />
  );
  return {
    ui,
    drafts,
    saved,
    setSnapshot: (next: NextTurnSnapshot) => {
      current = next;
    },
  };
}

describe('NextTurnSuggestionPillView', () => {
  it('renders the pill with its label, the sparkle and a dismiss control', () => {
    render(
      <NextTurnSuggestionPillView
        suggestion={{ text: 'go 8.1', label: 'go 8.1', reason: 'next-action', sourceLine: 'x' }}
        onInsert={() => {}}
        onDismiss={() => {}}
      />,
    );
    const pill = screen.getByTestId('next-turn-suggestion');
    expect(pill.getAttribute('data-text')).toBe('go 8.1');
    expect(screen.getByTestId('next-turn-suggestion-insert').textContent).toBe('go 8.1');
    expect(screen.getByTestId('next-turn-suggestion-dismiss')).not.toBeNull();
  });

  it('is not a dialog, an overlay or a focus trap', () => {
    const { container } = render(
      <NextTurnSuggestionPillView
        suggestion={{ text: 'go 8.1', label: 'go 8.1', reason: 'next-action', sourceLine: 'x' }}
        onInsert={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-modal]')).toBeNull();
    expect(container.querySelector('.fixed')).toBeNull();
  });
});

describe('lastAssistantText', () => {
  it('ignores a streaming turn', () => {
    expect(lastAssistantText(snapshot({ isStreaming: true }))).toBeNull();
  });

  it('ignores a pending permission or question card', () => {
    expect(lastAssistantText(snapshot({ pendingPermission: { id: 'p' } }))).toBeNull();
    expect(lastAssistantText(snapshot({ pendingAskUser: { id: 'q' } }))).toBeNull();
  });

  it('ignores a trailing user or tool message', () => {
    expect(
      lastAssistantText(
        snapshot({ messages: [{ clientId: 'u1', role: 'user', content: 'hi' }] }),
      ),
    ).toBeNull();
    expect(
      lastAssistantText(
        snapshot({
          messages: [
            { clientId: 'a1', role: 'assistant', content: NEXT_ACTION },
            { clientId: 't1', role: 'tool_use', content: '', toolName: 'Read' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('returns the newest assistant message', () => {
    const found = lastAssistantText(
      snapshot({
        messages: [
          { clientId: 'a1', role: 'assistant', content: 'older' },
          { clientId: 'u2', role: 'user', content: 'next' },
          { clientId: 'a2', role: 'assistant', content: NEXT_ACTION },
        ],
      }),
    );
    expect(found?.clientId).toBe('a2');
    expect(found?.content).toBe(NEXT_ACTION);
  });
});

describe('NextTurnSuggestionPill', () => {
  it('shows the extracted continuation from the closing line', async () => {
    const h = harness();
    render(h.ui());
    await waitFor(() => expect(screen.getByTestId('next-turn-suggestion')).not.toBeNull());
    expect(screen.getByTestId('next-turn-suggestion').getAttribute('data-reason')).toBe(
      'next-action',
    );
    expect(screen.getByTestId('next-turn-suggestion-insert').textContent).toBe('go 8.1');
  });

  it('writes the phrase into an empty draft on click', async () => {
    const h = harness();
    render(h.ui());
    await waitFor(() => expect(screen.getByTestId('next-turn-suggestion-insert')).not.toBeNull());
    fireEvent.click(screen.getByTestId('next-turn-suggestion-insert'));
    const saved = h.drafts.get('session-1');
    expect(saved).toBeDefined();
    expect(composerPlainText(saved?.text)).toBe('go 8.1');
    expect(saved?.focusAtEnd).toBe(true);
    // One click, then the pill goes away until the next turn.
    await waitFor(() => expect(screen.queryByTestId('next-turn-suggestion')).toBeNull());
  });

  it('appends to an existing draft on a new line', async () => {
    const h = harness();
    h.drafts.set('session-1', { text: plainTextToTiptapDoc('review this'), attachments: [] });
    render(h.ui());
    await waitFor(() => expect(screen.getByTestId('next-turn-suggestion-insert')).not.toBeNull());
    fireEvent.click(screen.getByTestId('next-turn-suggestion-insert'));
    expect(composerPlainText(h.drafts.get('session-1')?.text)).toBe('review this\ngo 8.1');
  });

  it('stays hidden after dismiss while the same message is current', async () => {
    const h = harness();
    render(h.ui());
    await waitFor(() => expect(screen.getByTestId('next-turn-suggestion-dismiss')).not.toBeNull());
    fireEvent.click(screen.getByTestId('next-turn-suggestion-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('next-turn-suggestion')).toBeNull());
    // Several poll ticks with the same message must not resurrect it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByTestId('next-turn-suggestion')).toBeNull();
    expect(h.saved).toHaveLength(0);
  });

  it('re-arms on the next assistant message after a dismissal', async () => {
    const h = harness();
    render(h.ui());
    await waitFor(() => expect(screen.getByTestId('next-turn-suggestion-dismiss')).not.toBeNull());
    fireEvent.click(screen.getByTestId('next-turn-suggestion-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('next-turn-suggestion')).toBeNull());

    h.setSnapshot(
      snapshot({
        messages: [
          { clientId: 'm1', role: 'assistant', content: NEXT_ACTION },
          { clientId: 'm2', role: 'assistant', content: 'Next action: `go 8.2`' },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('next-turn-suggestion-insert').textContent).toBe('go 8.2'),
    );
  });

  it('renders nothing while streaming', async () => {
    const h = harness(snapshot({ isStreaming: true }));
    render(h.ui());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByTestId('next-turn-suggestion')).toBeNull();
  });

  it('renders nothing when the agent offered no continuation', async () => {
    const h = harness(
      snapshot({
        messages: [
          { clientId: 'm1', role: 'assistant', content: 'Gates are green. Tree is clean.' },
        ],
      }),
    );
    render(h.ui());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByTestId('next-turn-suggestion')).toBeNull();
  });

  it('renders nothing when disabled', async () => {
    const h = harness();
    render(h.ui({ disabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByTestId('next-turn-suggestion')).toBeNull();
  });

  it('stops polling after unmount', async () => {
    const read = vi.fn(() => snapshot());
    const { unmount } = render(
      <NextTurnSuggestionPill
        sessionId="session-1"
        draftKey="session-1"
        readSnapshot={read}
        pollMs={10}
      />,
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    unmount();
    const callsAtUnmount = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(read.mock.calls.length).toBe(callsAtUnmount);
  });
});
