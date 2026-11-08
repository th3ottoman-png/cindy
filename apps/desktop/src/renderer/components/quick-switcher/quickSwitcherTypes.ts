import type React from 'react';

export type QuickSwitcherCategory = 'session' | 'expert' | 'note' | 'action';

export interface QuickSwitcherItem {
  id: string;
  category: QuickSwitcherCategory;
  title: string;
  subtitle?: string;
  badge?: string;
  tags?: string[];
  icon?: React.ReactNode;
  /** Score assigned during filtering (higher = better rank) */
  score?: number;
  onSelect: () => void | Promise<void>;
}

export type QuickSwitcherPrefix = '>' | '@' | '#' | '/';

export interface ParsedQuickSwitcherQuery {
  rawQuery: string;
  prefix: QuickSwitcherPrefix | null;
  searchTerm: string;
}
