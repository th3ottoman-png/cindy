import type {
  ParsedQuickSwitcherQuery,
  QuickSwitcherCategory,
  QuickSwitcherItem,
  QuickSwitcherPrefix,
} from './quickSwitcherTypes';

const PREFIX_CATEGORY_MAP: Record<QuickSwitcherPrefix, QuickSwitcherCategory> = {
  '>': 'action',
  '@': 'expert',
  '#': 'note',
  '/': 'session',
};

export function parseQuickSwitcherQuery(query: string): ParsedQuickSwitcherQuery {
  const trimmed = query.trimStart();
  if (!trimmed) {
    return { rawQuery: query, prefix: null, searchTerm: '' };
  }

  const firstChar = trimmed[0];
  if (firstChar === '>' || firstChar === '@' || firstChar === '#' || firstChar === '/') {
    return {
      rawQuery: query,
      prefix: firstChar as QuickSwitcherPrefix,
      searchTerm: trimmed.slice(1).trim(),
    };
  }

  return {
    rawQuery: query,
    prefix: null,
    searchTerm: query.trim(),
  };
}

function calculateScore(
  item: QuickSwitcherItem,
  termLower: string,
): number {
  const titleLower = item.title.toLowerCase();

  // 1. Exact match
  if (titleLower === termLower) {
    return 120;
  }

  // 2. Title starts with search term
  if (titleLower.startsWith(termLower)) {
    return 100;
  }

  // 3. Word boundary match in title
  const wordBoundaryRegex = new RegExp(`(?:^|[\\s/_-])${escapeRegex(termLower)}`, 'i');
  if (wordBoundaryRegex.test(item.title)) {
    return 80;
  }

  // 4. Substring anywhere in title
  if (titleLower.includes(termLower)) {
    return 60;
  }

  // 5. Tag match
  if (item.tags && item.tags.some((tag) => tag.toLowerCase().includes(termLower))) {
    return 50;
  }

  // 6. Subtitle match
  if (item.subtitle && item.subtitle.toLowerCase().includes(termLower)) {
    return 40;
  }

  // 7. Badge match
  if (item.badge && item.badge.toLowerCase().includes(termLower)) {
    return 30;
  }

  return 0;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function filterQuickSwitcherItems(
  items: QuickSwitcherItem[],
  query: string,
  limit = 50,
): QuickSwitcherItem[] {
  const { prefix, searchTerm } = parseQuickSwitcherQuery(query);

  // 1. Filter by category if prefix is active
  let candidates = items;
  if (prefix) {
    const requiredCategory = PREFIX_CATEGORY_MAP[prefix];
    candidates = items.filter((item) => item.category === requiredCategory);
  }

  // 2. If no search term, return category candidates directly
  if (!searchTerm) {
    return candidates.slice(0, limit);
  }

  const termLower = searchTerm.toLowerCase();

  // 3. Calculate score for each candidate
  const scoredItems: { item: QuickSwitcherItem; score: number; index: number }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const score = calculateScore(item, termLower);
    if (score > 0) {
      scoredItems.push({
        item: { ...item, score },
        score,
        index: i,
      });
    }
  }

  // 4. Sort: highest score first, stable on original index
  scoredItems.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });

  return scoredItems.slice(0, limit).map((s) => s.item);
}
