import { describe, expect, it } from 'vitest';

import {
  buildLibraryIndex,
  classifyLibraryPath,
  groupLibraryByKind,
  libraryChatDate,
  libraryEntryToken,
  libraryExcerpt,
  libraryKindSummary,
  searchLibrary,
  type LibrarySourceEntry,
} from '../library-index';

const CHAT = `---
title: Vault researcher live test
---
We searched the backlink inspector note and updated memory/Project — Cindy.md with the result.
`;

const ENTRIES: readonly LibrarySourceEntry[] = [
  {
    path: 'Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md',
    title: 'Vault researcher live test',
    mtimeMs: 3000,
    body: CHAT,
  },
  {
    path: 'Cindy/Chats/2026-11-07-route-planning-aaaa1111.md',
    title: 'Route planning',
    mtimeMs: 2000,
    body: 'Nothing relevant here.',
  },
  {
    path: 'Cindy/Memory/2026-11-08-vault-researcher-live-test-d2e8c24b-summary.md',
    title: 'Summary of the live test',
    mtimeMs: 2500,
    body: 'A short summary.',
  },
  {
    path: 'memory/Project — Cindy.md',
    title: 'Project — Cindy',
    tags: ['project', 'cindy'],
    mtimeMs: 4000,
    body: '---\ntitle: Project\ntags: [project]\n---\n# Project\n\n## Backlink inspector\n\nSee Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md for details.',
  },
  {
    path: 'raw/reading list.md',
    title: 'Reading list',
    tags: ['reading'],
    mtimeMs: 1000,
    body: 'Books about backlinks.',
  },
];

describe('classifyLibraryPath', () => {
  it('sorts the two Cindy folders into chat and summary', () => {
    expect(classifyLibraryPath('Cindy/Chats/2026-11-08-x.md')).toBe('chat');
    expect(classifyLibraryPath('Cindy/Memory/2026-11-08-x-summary.md')).toBe('summary');
  });

  it('treats everything else as a note', () => {
    expect(classifyLibraryPath('memory/Project — Cindy.md')).toBe('note');
    expect(classifyLibraryPath('Inbox.md')).toBe('note');
  });

  it('normalises backslashes and leading slashes', () => {
    expect(classifyLibraryPath('/Cindy/Chats/x.md')).toBe('chat');
    expect(classifyLibraryPath('Cindy\\Chats\\x.md')).toBe('chat');
  });
});

describe('libraryExcerpt', () => {
  it('drops frontmatter and heading markers', () => {
    expect(libraryExcerpt('---\ntitle: X\n---\n# Head\n\nBody text.')).toBe('Head Body text.');
  });

  it('collapses whitespace and strips emphasis', () => {
    expect(libraryExcerpt('a  **b**\n\n c')).toBe('a b c');
  });

  it('bounds the length', () => {
    const excerpt = libraryExcerpt('x'.repeat(600));
    expect(excerpt.length).toBe(240);
    expect(excerpt.endsWith('...')).toBe(true);
  });

  it('handles an empty body', () => {
    expect(libraryExcerpt(undefined)).toBe('');
    expect(libraryExcerpt('')).toBe('');
  });
});

describe('libraryChatDate', () => {
  it('reads the date prefix of a transcript', () => {
    expect(libraryChatDate('Cindy/Chats/2026-11-08-slug-ab12cd34.md')).toBe('2026-11-08');
  });

  it('returns null when there is no date prefix', () => {
    expect(libraryChatDate('notes/idea.md')).toBeNull();
  });
});

describe('buildLibraryIndex', () => {
  const index = buildLibraryIndex(ENTRIES);

  it('keeps every entry with its kind and identity', () => {
    expect(index).toHaveLength(ENTRIES.length);
    expect(index.map((entry) => entry.kind)).toEqual(['chat', 'chat', 'summary', 'note', 'note']);
    expect(index[0].id).toBe(ENTRIES[0].path);
  });

  it('records the modified time and tags', () => {
    const project = index.find((entry) => entry.path === 'memory/Project — Cindy.md');
    expect(project?.updatedAt).toBe(4000);
    expect(project?.tags).toEqual(['project', 'cindy']);
  });

  it('computes citations from chat transcript bodies', () => {
    const project = index.find((entry) => entry.path === 'memory/Project — Cindy.md');
    expect(project?.citations).toEqual([
      'Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md',
    ]);
  });

  it('cites a note when a transcript names its path', () => {
    const project = index.find((entry) => entry.path === 'memory/Project — Cindy.md');
    expect(project?.citations).toHaveLength(1);
    const reading = index.find((entry) => entry.path === 'raw/reading list.md');
    expect(reading?.citations).toEqual([]);
  });

  it('cites a note when a transcript names only its title', () => {
    const built = buildLibraryIndex([
      {
        path: 'Cindy/Chats/2026-11-06-title-only.md',
        title: 'Title only',
        body: 'Reviewed Project — Cindy today.',
      },
      { path: 'memory/Project — Cindy.md', title: 'Project — Cindy', body: 'x' },
    ]);
    const project = built.find((entry) => entry.kind === 'note');
    expect(project?.citations).toEqual(['Cindy/Chats/2026-11-06-title-only.md']);
  });

  it('never cites a chat transcript from another chat', () => {
    for (const entry of index.filter((item) => item.kind === 'chat')) {
      expect(entry.citations).toEqual([]);
    }
  });

  it('cites a summary when the transcript mentions it', () => {
    const summary = index.find((entry) => entry.kind === 'summary');
    expect(summary?.citations).toEqual([]);
  });

  it('falls back to the path when the title is blank', () => {
    const built = buildLibraryIndex([{ path: 'raw/blank.md', title: '   ' }]);
    expect(built[0].title).toBe('raw/blank.md');
  });
});

describe('searchLibrary', () => {
  const index = buildLibraryIndex(ENTRIES);

  it('returns everything newest first for an empty query', () => {
    const results = searchLibrary(index, '');
    expect(results.map((entry) => entry.path)).toEqual([
      'memory/Project — Cindy.md',
      'Cindy/Chats/2026-11-08-vault-researcher-live-test-d2e8c24b.md',
      'Cindy/Memory/2026-11-08-vault-researcher-live-test-d2e8c24b-summary.md',
      'Cindy/Chats/2026-11-07-route-planning-aaaa1111.md',
      'raw/reading list.md',
    ]);
  });

  it('matches a title prefix first', () => {
    expect(searchLibrary(index, 'project')[0].path).toBe('memory/Project — Cindy.md');
  });

  it('matches a tag', () => {
    const results = searchLibrary(index, 'reading');
    expect(results.map((entry) => entry.path)).toContain('raw/reading list.md');
  });

  it('matches the excerpt body', () => {
    const results = searchLibrary(index, 'backlinks');
    expect(results.map((entry) => entry.path)).toContain('raw/reading list.md');
  });

  it('matches the path', () => {
    const results = searchLibrary(index, 'route-planning');
    expect(results[0].path).toBe('Cindy/Chats/2026-11-07-route-planning-aaaa1111.md');
  });

  it('returns nothing for an unmatched term', () => {
    expect(searchLibrary(index, 'zzzznothing')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchLibrary(index, '', 2)).toHaveLength(2);
  });
});

describe('grouping and summary', () => {
  const index = buildLibraryIndex(ENTRIES);

  it('groups in first-seen order', () => {
    expect(groupLibraryByKind(index).map((group) => group.kind)).toEqual([
      'chat',
      'summary',
      'note',
    ]);
  });

  it('counts per kind in display order', () => {
    expect(libraryKindSummary(index)).toEqual([
      { kind: 'note', count: 2 },
      { kind: 'chat', count: 2 },
      { kind: 'summary', count: 1 },
    ]);
  });

  it('accepts a brand new kind with no central edit', () => {
    const built = buildLibraryIndex([{ path: 'Cindy/Chats/x.md', title: 'x' }]);
    expect(built[0].kind).toBe('chat');
    expect(libraryKindSummary(built)).toEqual([{ kind: 'chat', count: 1 }]);
  });
});

describe('libraryEntryToken', () => {
  it('writes an 8.4 vault-note token', () => {
    expect(libraryEntryToken({ path: 'memory/Project — Cindy.md' })).toBe(
      '@vault-note:memory/Project-—-Cindy.md',
    );
  });

  it('keeps slashes so the path stays readable', () => {
    expect(libraryEntryToken({ path: 'Cindy/Chats/a.md' })).toBe('@vault-note:Cindy/Chats/a.md');
  });
});
