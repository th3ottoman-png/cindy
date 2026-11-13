// @vitest-environment jsdom
/**
 * ROADMAP 12.3b: the @agent: composer picker. Ownership hands over at the colon
 * (bare @ stays with the file panel); picking a row writes the visible token.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TeammatePickerSlot } from '../TeammatePickerSlot';
import {
  rankTeammateCandidates,
  toTeammatePickerCandidate,
  type TeammatePickerCandidate,
} from '../teammatePickerRoster';
import { composerPlainText } from '../../turn-attachments/turnAttachmentDoc';
import type { RosterRow } from '@/features/agents/agentsRosterModel';

const HISTORIAN: TeammatePickerCandidate = {
  id: 'imported:claude-user:academic-historian.md',
  name: 'Academic Historian',
  description: 'Researches history',
  program: 'hermes',
  source: 'claude-user',
  path: '/Users/owner/.claude/agents/academic-historian.md',
  disabled: false,
};
const GEOGRAPHER: TeammatePickerCandidate = {
  id: 'expert:geographer',
  name: 'Geographer',
  description: 'Maps and trade routes',
  program: 'hermes',
  source: 'mine',
  path: '/Users/owner/.cindy-harness/experts/geographer/expert.md',
  disabled: false,
};
const CLAUDE_ONLY: TeammatePickerCandidate = {
  id: 'expert:code-reviewer',
  name: 'Code Reviewer',
  description: 'Reviews code',
  program: 'claude-code',
  source: 'mine',
  path: '/Users/owner/.cindy-harness/experts/code-reviewer/expert.md',
  disabled: true,
  disabledReason: 'Configured for claude-code; teammates run on Hermes.',
};
const CANDIDATES = [HISTORIAN, GEOGRAPHER, CLAUDE_ONLY];

function docFromText(text: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

function Harness({ initial, candidates = CANDIDATES }: { initial: string; candidates?: readonly TeammatePickerCandidate[] }) {
  const docRef = React.useRef<JSONContent>(docFromText(initial));
  const listeners = React.useRef(new Set<() => void>());
  const [, bumpVersion] = React.useState(0);

  const subscribe = React.useCallback((onChange: () => void) => {
    listeners.current.add(onChange);
    return () => { listeners.current.delete(onChange); };
  }, []);
  const saveDocument = React.useCallback((next: JSONContent) => {
    docRef.current = next;
    bumpVersion((value) => value + 1);
    for (const listener of listeners.current) listener();
  }, []);
  const getDocument = React.useCallback(() => docRef.current, []);

  return (
    <>
      <TeammatePickerSlot
        getDocument={getDocument}
        subscribe={subscribe}
        saveDocument={saveDocument}
        candidates={candidates}
      />
      <output data-testid="draft-text">{composerPlainText(docRef.current)}</output>
    </>
  );
}

function panel() {
  return screen.queryByTestId('teammate-picker-panel');
}
function options() {
  return screen.queryAllByTestId('teammate-picker-option');
}
function draftText(): string {
  return screen.getByTestId('draft-text').textContent ?? '';
}

afterEach(cleanup);

describe('toTeammatePickerCandidate (fail-closed Hermes runnability)', () => {
  const base: RosterRow = {
    id: 'expert:geographer',
    kind: 'expert',
    slug: 'geographer',
    name: 'Geographer',
    description: 'Maps',
    program: 'hermes',
    source: 'mine',
    path: '/experts/geographer/expert.md',
    prompt: '',
  };

  it('keeps a Hermes expert pickable', () => {
    expect(toTeammatePickerCandidate(base)).toMatchObject({ id: 'expert:geographer', disabled: false });
  });

  it('disables a non-Hermes expert and names the program', () => {
    const candidate = toTeammatePickerCandidate({ ...base, program: 'claude-code' });
    expect(candidate.disabled).toBe(true);
    expect(candidate.disabledReason).toContain('claude-code');
  });

  it('disables a broken expert with its error', () => {
    const candidate = toTeammatePickerCandidate({ ...base, error: 'bad frontmatter' });
    expect(candidate.disabled).toBe(true);
    expect(candidate.disabledReason).toContain('bad frontmatter');
  });

  it('disables an imported agent whose runsOn lacks hermes, naming blocking tools', () => {
    const candidate = toTeammatePickerCandidate({
      ...base,
      id: 'imported:claude-user:x.md',
      kind: 'imported',
      program: 'claude-code',
      source: 'claude-user',
      runsOn: ['claude-code'],
      blockedTools: ['WebSearch'],
    });
    expect(candidate.disabled).toBe(true);
    expect(candidate.disabledReason).toContain('WebSearch');
  });

  it('keeps an imported agent that runs on hermes pickable', () => {
    const candidate = toTeammatePickerCandidate({
      ...base,
      id: 'imported:claude-user:x.md',
      kind: 'imported',
      program: 'hermes + claude-code',
      source: 'claude-user',
      runsOn: ['hermes', 'claude-code'],
    });
    expect(candidate.disabled).toBe(false);
  });
});

describe('rankTeammateCandidates', () => {
  it('returns everything for an empty term, capped by the limit', () => {
    expect(rankTeammateCandidates(CANDIDATES, '', 2)).toHaveLength(2);
    expect(rankTeammateCandidates(CANDIDATES, '', 12)).toHaveLength(3);
  });

  it('matches on name and id, best first', () => {
    expect(rankTeammateCandidates(CANDIDATES, 'geo', 12)[0].id).toBe('expert:geographer');
    expect(rankTeammateCandidates(CANDIDATES, 'historian', 12)[0].id).toBe(HISTORIAN.id);
    expect(rankTeammateCandidates(CANDIDATES, 'academic-historian', 12)[0].id).toBe(HISTORIAN.id);
  });

  it('returns nothing for a term that matches no row', () => {
    expect(rankTeammateCandidates(CANDIDATES, 'zzz-no-match', 12)).toEqual([]);
  });
});

describe('TeammatePickerSlot', () => {
  it('stays closed for bare @ and other kinds (file/attachment panels own those)', async () => {
    render(<Harness initial="look at @hist" />);
    await waitFor(() => expect(screen.getByTestId('draft-text')).toBeTruthy());
    expect(panel()).toBeNull();
    cleanup();
    render(<Harness initial="@skill:sea" />);
    await waitFor(() => expect(screen.getByTestId('draft-text')).toBeTruthy());
    expect(panel()).toBeNull();
  });

  it('opens at the colon and lists roster rows with program/source badges', async () => {
    render(<Harness initial="bring in @agent:" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(options()).toHaveLength(3);
    const geo = options().find((option) => option.getAttribute('data-id') === 'expert:geographer');
    expect(geo?.textContent).toContain('Geographer');
    expect(geo?.textContent).toContain('hermes');
    expect(geo?.textContent).toContain('mine');
    expect(geo?.getAttribute('data-disabled')).toBeNull();
    const blocked = options().find((option) => option.getAttribute('data-id') === 'expert:code-reviewer');
    expect(blocked?.getAttribute('data-disabled')).toBe('true');
  });

  it('filters as the owner types', async () => {
    render(<Harness initial="@agent:geo" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(options()).toHaveLength(1);
    expect(options()[0].getAttribute('data-id')).toBe('expert:geographer');
  });

  it('Enter inserts the token with a trailing space and closes the panel', async () => {
    render(<Harness initial="ask @agent:geo" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(panel()).toBeNull());
    expect(draftText()).toBe('ask @agent:expert:geographer');
  });

  it('clicking a row inserts its token', async () => {
    render(<Harness initial="@agent:" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    const geo = options().find((option) => option.getAttribute('data-id') === 'expert:geographer')!;
    fireEvent.click(geo);
    await waitFor(() => expect(panel()).toBeNull());
    expect(draftText()).toBe('@agent:expert:geographer');
  });

  it('never inserts a disabled row', async () => {
    render(<Harness initial="@agent:code" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(options()).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.click(options()[0]);
    expect(draftText()).toBe('@agent:code');
    expect(panel()).not.toBeNull();
  });

  it('Escape closes the panel until the query changes', async () => {
    render(<Harness initial="@agent:" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(panel()).toBeNull());
    expect(draftText()).toBe('@agent:');
  });

  it('arrow keys skip disabled rows', async () => {
    render(<Harness initial="@agent:" />);
    await waitFor(() => expect(panel()).not.toBeNull());
    // Name order: Academic Historian, Code Reviewer (disabled), Geographer.
    // One Down skips the disabled row and lands on Geographer.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(panel()).toBeNull());
    expect(draftText()).toBe('@agent:expert:geographer');
  });

  it('a finished token (trailing space) does not reopen the panel', async () => {
    render(<Harness initial="@agent:expert:geographer do it" />);
    await waitFor(() => expect(screen.getByTestId('draft-text')).toBeTruthy());
    expect(panel()).toBeNull();
  });
});
