import { describe, expect, it, vi } from 'vitest';
import {
  filterQuickSwitcherItems,
  parseQuickSwitcherQuery,
} from '../quickSwitcherMatcher';
import type { QuickSwitcherItem } from '../quickSwitcherTypes';

describe('quickSwitcherMatcher', () => {
  describe('parseQuickSwitcherQuery', () => {
    it('parses empty query', () => {
      expect(parseQuickSwitcherQuery('')).toEqual({
        rawQuery: '',
        prefix: null,
        searchTerm: '',
      });
      expect(parseQuickSwitcherQuery('   ')).toEqual({
        rawQuery: '   ',
        prefix: null,
        searchTerm: '',
      });
    });

    it('parses queries with prefixes', () => {
      expect(parseQuickSwitcherQuery('> New Task')).toEqual({
        rawQuery: '> New Task',
        prefix: '>',
        searchTerm: 'New Task',
      });
      expect(parseQuickSwitcherQuery('@code-reviewer')).toEqual({
        rawQuery: '@code-reviewer',
        prefix: '@',
        searchTerm: 'code-reviewer',
      });
      expect(parseQuickSwitcherQuery('#project')).toEqual({
        rawQuery: '#project',
        prefix: '#',
        searchTerm: 'project',
      });
      expect(parseQuickSwitcherQuery('/research')).toEqual({
        rawQuery: '/research',
        prefix: '/',
        searchTerm: 'research',
      });
    });

    it('parses query with prefix alone without search term', () => {
      expect(parseQuickSwitcherQuery('>')).toEqual({
        rawQuery: '>',
        prefix: '>',
        searchTerm: '',
      });
      expect(parseQuickSwitcherQuery('@ ')).toEqual({
        rawQuery: '@ ',
        prefix: '@',
        searchTerm: '',
      });
    });

    it('parses standard query without prefix', () => {
      expect(parseQuickSwitcherQuery('cindy project')).toEqual({
        rawQuery: 'cindy project',
        prefix: null,
        searchTerm: 'cindy project',
      });
    });
  });

  describe('filterQuickSwitcherItems', () => {
    const dummySelect = vi.fn();
    const mockItems: QuickSwitcherItem[] = [
      {
        id: 's-1',
        category: 'session',
        title: 'Project Cindy Architecture Review',
        subtitle: 'Updated 2m ago · hermes-default',
        onSelect: dummySelect,
      },
      {
        id: 's-2',
        category: 'session',
        title: 'Fix Login Flow Issues',
        subtitle: 'Updated 1h ago · deepseek-flash',
        onSelect: dummySelect,
      },
      {
        id: 'e-1',
        category: 'expert',
        title: 'Code Reviewer',
        subtitle: 'Expert for reviewing git diffs and code quality',
        tags: ['review', 'git'],
        onSelect: dummySelect,
      },
      {
        id: 'e-2',
        category: 'expert',
        title: 'Vault Researcher',
        subtitle: 'Expert for searching Obsidian notes and synthesizing memory',
        tags: ['notes', 'vault'],
        onSelect: dummySelect,
      },
      {
        id: 'n-1',
        category: 'note',
        title: 'Project — Cindy.md',
        subtitle: 'memory/Project — Cindy.md',
        tags: ['project', 'cindy'],
        onSelect: dummySelect,
      },
      {
        id: 'n-2',
        category: 'note',
        title: 'Inbox.md',
        subtitle: 'Inbox.md',
        onSelect: dummySelect,
      },
      {
        id: 'a-1',
        category: 'action',
        title: 'New Task',
        subtitle: 'Start a new conversation',
        onSelect: dummySelect,
      },
      {
        id: 'a-2',
        category: 'action',
        title: 'Open Notes Vault Graph',
        subtitle: 'Explore notes and backlinks in right sidebar',
        onSelect: dummySelect,
      },
    ];

    it('returns all items when query is empty, up to limit', () => {
      const res = filterQuickSwitcherItems(mockItems, '');
      expect(res).toHaveLength(mockItems.length);
      expect(res[0].id).toBe('s-1');

      const limited = filterQuickSwitcherItems(mockItems, '', 3);
      expect(limited).toHaveLength(3);
    });

    it('filters strictly by prefix when prefix alone is provided', () => {
      const actions = filterQuickSwitcherItems(mockItems, '>');
      expect(actions.every((item) => item.category === 'action')).toBe(true);
      expect(actions).toHaveLength(2);

      const experts = filterQuickSwitcherItems(mockItems, '@');
      expect(experts.every((item) => item.category === 'expert')).toBe(true);
      expect(experts).toHaveLength(2);

      const notes = filterQuickSwitcherItems(mockItems, '#');
      expect(notes.every((item) => item.category === 'note')).toBe(true);
      expect(notes).toHaveLength(2);

      const sessions = filterQuickSwitcherItems(mockItems, '/');
      expect(sessions.every((item) => item.category === 'session')).toBe(true);
      expect(sessions).toHaveLength(2);
    });

    it('filters by prefix and search term combined', () => {
      const res = filterQuickSwitcherItems(mockItems, '> graph');
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('a-2');
      expect(res[0].title).toBe('Open Notes Vault Graph');
    });

    it('ranks prefix matches higher than substring matches', () => {
      const res = filterQuickSwitcherItems(mockItems, 'project');
      expect(res.length).toBeGreaterThanOrEqual(2);
      // 'Project Cindy...' starts with project -> score 100
      expect(res[0].title).toContain('Project');
    });

    it('matches tags when title does not match', () => {
      const res = filterQuickSwitcherItems(mockItems, 'review');
      expect(res.some((item) => item.id === 'e-1')).toBe(true);
    });

    it('matches subtitles when title does not match', () => {
      const res = filterQuickSwitcherItems(mockItems, 'Obsidian');
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('e-2');
    });

    it('returns empty array when nothing matches', () => {
      const res = filterQuickSwitcherItems(mockItems, 'nonexistentqueryXYZ');
      expect(res).toEqual([]);
    });
  });
});
