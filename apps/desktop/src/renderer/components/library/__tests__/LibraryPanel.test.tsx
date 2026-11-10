// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from '@cindy/maker-core/library-index';

import { LibraryPanel } from '../LibraryPanel';
import { closeLibrary, openLibrary } from '../libraryStore';

const ENTRIES: LibraryEntry[] = [
  {
    kind: 'note',
    id: 'memory/Project — Cindy.md',
    title: 'Project — Cindy',
    path: 'memory/Project — Cindy.md',
    updatedAt: 4000,
    tags: ['project'],
    excerpt: 'Roadmap and status for the Cindy fork.',
    citations: ['Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md'],
  },
  {
    kind: 'chat',
    id: 'Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md',
    title: 'Vault researcher live test',
    path: 'Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md',
    updatedAt: 3000,
    tags: [],
    excerpt: 'We updated the project note.',
    citations: [],
  },
  {
    kind: 'summary',
    id: 'Cindy/Memory/2026-11-08-summary.md',
    title: 'Summary of the live test',
    path: 'Cindy/Memory/2026-11-08-summary.md',
    updatedAt: 2500,
    tags: [],
    excerpt: 'A short summary.',
    citations: [],
  },
];

function installScan(entries: LibraryEntry[] = ENTRIES) {
  const scan = vi.fn(async () => ({
    ok: true,
    entries,
    vaultDir: '/vault',
    scannedAt: '2026-11-09T00:00:00.000Z',
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { library: { scan } },
  };
  return scan;
}

function rows() {
  return screen.queryAllByTestId('library-row');
}

beforeEach(() => {
  installScan();
});

afterEach(() => {
  cleanup();
  closeLibrary();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function openPanel() {
  render(<LibraryPanel />);
  act(() => openLibrary());
  await waitFor(() => expect(rows().length).toBe(3));
}

describe('LibraryPanel', () => {
  it('renders nothing while closed', () => {
    render(<LibraryPanel />);
    expect(screen.queryByTestId('library-panel')).toBeNull();
  });

  it('lists notes, chats and summaries in one view', async () => {
    await openPanel();
    expect(rows().map((row) => row.getAttribute('data-kind'))).toEqual([
      'note',
      'chat',
      'summary',
    ]);
    expect(screen.getByTestId('library-count').textContent).toContain('3 items');
  });

  it('shows a per-kind chip for each kind present', async () => {
    await openPanel();
    const chips = screen.getAllByTestId('library-kind-chip');
    expect(chips.map((chip) => chip.getAttribute('data-kind'))).toEqual([
      'note',
      'chat',
      'summary',
    ]);
  });

  it('filters by kind', async () => {
    await openPanel();
    const chatChip = screen
      .getAllByTestId('library-kind-chip')
      .find((chip) => chip.getAttribute('data-kind') === 'chat');
    fireEvent.click(chatChip!);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].getAttribute('data-kind')).toBe('chat');
  });

  it('searches across titles, tags and excerpts', async () => {
    await openPanel();
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'summary' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].getAttribute('data-kind')).toBe('summary');

    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'roadmap' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].getAttribute('data-kind')).toBe('note');
  });

  it('says so when nothing matches', async () => {
    await openPanel();
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'zzzznothing' } });
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByTestId('library-empty')).not.toBeNull();
  });

  it('names citing sessions for the selected note', async () => {
    await openPanel();
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(screen.getByTestId('library-inspector')).not.toBeNull());
    const citations = screen.getAllByTestId('library-citation');
    expect(citations).toHaveLength(1);
    expect(citations[0].textContent).toContain('2026-11-08');
    expect(citations[0].textContent).toContain(
      'Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md',
    );
  });

  it('says when a note has no citing sessions', async () => {
    await openPanel();
    const chatRow = rows().find((row) => row.getAttribute('data-kind') === 'chat');
    fireEvent.click(chatRow!);
    await waitFor(() =>
      expect(screen.getByTestId('library-inspector').textContent).toContain(
        'No citing sessions',
      ),
    );
  });

  it('puts an 8.4 token on the drag payload', async () => {
    await openPanel();
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      getData: (type: string) => data[type] ?? '',
      effectAllowed: 'none',
    };
    fireEvent.dragStart(rows()[0], { dataTransfer });
    expect(data['text/plain']).toBe('@vault-note:memory/Project-—-Cindy.md');
    expect(JSON.parse(data['application/x-cindy-library'])).toMatchObject({
      kind: 'note',
      path: 'memory/Project — Cindy.md',
    });
  });

  it('closes on the close button and on Escape', async () => {
    await openPanel();
    fireEvent.click(screen.getByTestId('library-close'));
    await waitFor(() => expect(screen.queryByTestId('library-panel')).toBeNull());

    act(() => openLibrary());
    await waitFor(() => expect(screen.queryByTestId('library-panel')).not.toBeNull());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('library-panel')).toBeNull());
  });

  it('reports a failed scan instead of showing an empty list', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: { library: { scan: async () => ({ ok: false, entries: [], error: 'no vault' }) } },
    };
    render(<LibraryPanel />);
    act(() => openLibrary());
    await waitFor(() => expect(screen.getByTestId('library-error').textContent).toContain('no vault'));
    expect(rows()).toHaveLength(0);
  });

  it('renders artifacts alongside notes, chats and summaries (ROADMAP 8.5b)', async () => {
    const entriesWithArtifact: LibraryEntry[] = [
      ...ENTRIES,
      {
        kind: 'artifact',
        id: 'Cindy/Artifacts/diag.md',
        title: 'System Architecture',
        path: 'Cindy/Artifacts/diag.md',
        updatedAt: 3500,
        tags: ['diagram'],
        excerpt: 'Client-server pipeline.',
        citations: [],
      },
    ];
    installScan(entriesWithArtifact);
    render(<LibraryPanel />);
    act(() => openLibrary());
    await waitFor(() => expect(rows()).toHaveLength(4));

    const chips = screen.getAllByTestId('library-kind-chip');
    expect(chips.map((c) => c.getAttribute('data-kind'))).toEqual([
      'note',
      'chat',
      'summary',
      'artifact',
    ]);

    const artifactChip = chips.find((c) => c.getAttribute('data-kind') === 'artifact');
    expect(artifactChip?.textContent).toContain('artifact 1');

    fireEvent.click(artifactChip!);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].getAttribute('data-kind')).toBe('artifact');
    expect(rows()[0].textContent).toContain('System Architecture');
  });
});
