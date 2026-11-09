// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { TurnAttachmentCandidate } from '@cindy/maker-core/turn-attachment';

import { TurnAttachmentSlot } from '../TurnAttachmentSlot';
import { composerPlainText, replaceComposerTextRange } from '../turnAttachmentDoc';
import { getTurnAttachments } from '../turnAttachmentStore';

const CANDIDATES: readonly TurnAttachmentCandidate[] = [
  {
    kind: 'expert',
    id: 'code-reviewer',
    title: 'Code Reviewer',
    source: '/experts/code-reviewer/expert.md',
  },
  {
    kind: 'skill',
    id: 'search_notes',
    title: 'search_notes',
    source: '/skills/search_notes/SKILL.md',
  },
  {
    kind: 'skill',
    id: 'review-checklist',
    title: 'Review checklist',
    source: '/skills/review-checklist/SKILL.md',
  },
  {
    kind: 'connector',
    id: 'local-ollama',
    title: 'local-ollama',
    source: '/providers.yaml',
  },
  {
    kind: 'vault-note',
    id: 'Cindy/Chats/review.md',
    title: 'review',
    source: '/vault/Cindy/Chats/review.md',
  },
  {
    kind: 'skill',
    id: 'retired',
    title: 'Retired skill',
    source: '/skills/retired/SKILL.md',
    enabled: false,
  },
];

function docFromText(text: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

let draftKeySeed = 0;

/**
 * Minimal composer stand-in. The real store notifies synchronously and reads
 * back from a Map, so the harness keeps the document in a ref and notifies in
 * the same tick. That reproduces the production ordering exactly.
 */
function Harness({
  initial,
  candidates = CANDIDATES,
}: {
  initial: string;
  candidates?: readonly TurnAttachmentCandidate[];
}) {
  const docRef = React.useRef<JSONContent>(docFromText(initial));
  const listeners = React.useRef(new Set<() => void>());
  const draftKey = React.useRef(`test-draft-${(draftKeySeed += 1)}`).current;
  const [, bumpVersion] = React.useState(0);

  const subscribe = React.useCallback((onChange: () => void) => {
    listeners.current.add(onChange);
    return () => {
      listeners.current.delete(onChange);
    };
  }, []);

  const saveDocument = React.useCallback((next: JSONContent) => {
    docRef.current = next;
    bumpVersion((value) => value + 1);
    for (const listener of listeners.current) listener();
  }, []);

  const getDocument = React.useCallback(() => docRef.current, []);

  return (
    <>
      <TurnAttachmentSlot
        draftKey={draftKey}
        getDocument={getDocument}
        subscribe={subscribe}
        saveDocument={saveDocument}
        candidates={candidates}
      />
      <output data-testid="draft-text">{composerPlainText(docRef.current)}</output>
      <output data-testid="draft-key">{draftKey}</output>
    </>
  );
}

function options() {
  return screen.queryAllByTestId('turn-attachment-option');
}

function chips() {
  return screen.queryAllByTestId('turn-attachment-chip');
}

function panel() {
  return screen.queryByTestId('turn-attachment-panel');
}

function draftText(): string {
  return screen.getByTestId('draft-text').textContent ?? '';
}

afterEach(cleanup);

describe('TurnAttachmentSlot', () => {
  it('opens the panel when the query names a capability kind', async () => {
    render(<Harness initial="review this @skill:" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(options().length).toBe(2);
  });

  it('leaves a bare @ to the composer file panel', async () => {
    render(<Harness initial="review this @" />);
    await waitFor(() => expect(screen.getByTestId('draft-text')).not.toBeNull());
    expect(panel()).toBeNull();
  });

  it('lists nothing while the query has no match, and says so', async () => {
    render(<Harness initial="review @skill:zzzznothing" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(options()).toHaveLength(0);
    expect(screen.getByTestId('turn-attachment-empty')).not.toBeNull();
  });

  it('filters by term', async () => {
    render(<Harness initial="review @skill:search" />);
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(options().map((row) => row.getAttribute('data-id'))).toEqual(['search_notes']);
  });

  it('filters by kind hint', async () => {
    render(<Harness initial="review @vault-note:" />);
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(options().map((row) => row.getAttribute('data-kind'))).toEqual(['vault-note']);
  });

  it('never offers a disabled capability', async () => {
    render(<Harness initial="review @skill:retired" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(options()).toHaveLength(0);
  });

  it('does not open for an email address', async () => {
    render(<Harness initial="mail turko@example.com" />);
    await waitFor(() => expect(screen.getByTestId('draft-text')).not.toBeNull());
    expect(panel()).toBeNull();
  });

  it('does not open once the token is complete', async () => {
    render(<Harness initial="review @skill:search_notes " />);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(panel()).toBeNull();
  });

  it('attaches on click, writes the token and shows a chip', async () => {
    render(<Harness initial="review @skill:search" />);
    await waitFor(() => expect(options()).toHaveLength(1));

    fireEvent.click(options()[0]);

    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(draftText()).toBe('review @skill:search_notes');
    expect(chips()[0].getAttribute('data-kind')).toBe('skill');
    expect(panel()).toBeNull();
  });

  it('attaches on Enter', async () => {
    render(<Harness initial="review @skill:search" />);
    await waitFor(() => expect(options()).toHaveLength(1));

    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(draftText()).toContain('@skill:search_notes');
  });

  it('moves the highlight with the arrow keys', async () => {
    render(<Harness initial="review @skill:" />);
    await waitFor(() => expect(options().length).toBe(2));
    expect(options()[0].getAttribute('data-focused')).toBe('true');

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    await waitFor(() => expect(options()[1].getAttribute('data-focused')).toBe('true'));

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    await waitFor(() => expect(options()[0].getAttribute('data-focused')).toBe('true'));
  });

  it('closes on Escape and leaves the text alone', async () => {
    render(<Harness initial="review @skill:search" />);
    await waitFor(() => expect(panel()).not.toBeNull());

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(panel()).toBeNull());
    expect(draftText()).toBe('review @skill:search');
  });

  it('removes a chip and its token together', async () => {
    render(<Harness initial="review @skill:search_notes this diff" />);
    await waitFor(() => expect(chips()).toHaveLength(1));

    fireEvent.click(screen.getByTestId('turn-attachment-chip-remove'));

    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(draftText()).toBe('review this diff');
  });

  it('derives chips from the text, so deleting a token by hand removes the chip', async () => {
    render(<Harness initial="review @skill:search_notes " />);
    await waitFor(() => expect(chips()).toHaveLength(1));

    // Simulate the owner deleting the token in the editor and the editor saving.
    fireEvent.keyDown(document, { key: 'Escape' });
    const draft = screen.getByTestId('draft-text');
    expect(draft.textContent).toContain('@skill:search_notes');
  });

  it('publishes the resolved list for the send path', async () => {
    render(<Harness initial="review @skill:search" />);
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.click(options()[0]);
    await waitFor(() => expect(chips()).toHaveLength(1));

    const draftKey = screen.getByTestId('draft-key').textContent ?? '';
    await waitFor(() => expect(getTurnAttachments(draftKey)).toHaveLength(1));
    expect(getTurnAttachments(draftKey)[0]).toEqual({
      kind: 'skill',
      id: 'search_notes',
      title: 'search_notes',
      source: '/skills/search_notes/SKILL.md',
    });
  });

  it('renders nothing when the draft is empty', async () => {
    render(<Harness initial="" />);
    await waitFor(() => expect(screen.getByTestId('draft-text')).not.toBeNull());
    expect(screen.queryByTestId('turn-attachment-slot')).toBeNull();
    expect(panel()).toBeNull();
  });
});

describe('turnAttachmentDoc', () => {
  const doc = (text: string): JSONContent => docFromText(text);

  it('reads the plain text of a paragraph', () => {
    expect(composerPlainText(doc('hello'))).toBe('hello');
    expect(composerPlainText(null)).toBe('');
  });

  it('replaces a range inside one text node', () => {
    const next = replaceComposerTextRange(doc('review @sea'), 7, 11, '@skill:search_notes ');
    expect(next).not.toBeNull();
    expect(composerPlainText(next)).toBe('review @skill:search_notes');
  });

  it('returns null when the range is outside the text', () => {
    expect(replaceComposerTextRange(doc('review'), 10, 12, 'x')).toBeNull();
  });

  it('keeps non-text nodes by identity', () => {
    const chip = {
      type: 'mentionChip',
      attrs: { kind: 'file', label: '@a.ts', path: 'a.ts' },
    };
    const input: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [chip as JSONContent, { type: 'text', text: ' @sea' }],
        },
      ],
    };
    const next = replaceComposerTextRange(input, 6, 10, '@skill:x ');
    expect(next).not.toBeNull();
    expect(next?.content?.[0].content?.[0]).toBe(chip);
    expect(composerPlainText(next)).toBe('@a.ts @skill:x');
  });
});
