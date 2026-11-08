import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Search,
  MessageSquare,
  Bot,
  FileText,
  Zap,
  Tag,
  ArrowRight,
  Command,
  Loader2,
} from 'lucide-react';
import type { NavigateFunction } from 'react-router-dom';
import { useQuickSwitcherData } from './useQuickSwitcherData';
import { filterQuickSwitcherItems, parseQuickSwitcherQuery } from './quickSwitcherMatcher';
import type { QuickSwitcherCategory, QuickSwitcherItem } from './quickSwitcherTypes';

export interface QuickSwitcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeSessionId: string | null;
  navigate: NavigateFunction;
}

export function QuickSwitcherDialog({
  open,
  onOpenChange,
  activeSessionId,
  navigate,
}: QuickSwitcherDialogProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const { items, loading } = useQuickSwitcherData({
    isOpen: open,
    onClose: handleClose,
    activeSessionId,
    navigate,
  });

  // Filter items based on user query
  const filteredItems = useMemo(() => {
    return filterQuickSwitcherItems(items, query);
  }, [items, query]);

  // Keep selection in bounds
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Window-level escape handler
  useEffect(() => {
    if (!open) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
    };
  }, [open, handleClose]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredItems.length > 0 ? (prev + 1) % filteredItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredItems.length > 0 ? (prev - 1 + filteredItems.length) % filteredItems.length : 0,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        void filteredItems[selectedIndex].onSelect();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  };

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    if (activeEl) {
      activeEl.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!open) return null;

  const { prefix } = parseQuickSwitcherQuery(query);

  const renderCategoryIcon = (category: QuickSwitcherCategory) => {
    switch (category) {
      case 'session':
        return <MessageSquare size={16} className="text-blue-400 shrink-0" />;
      case 'expert':
        return <Bot size={16} className="text-purple-400 shrink-0" />;
      case 'note':
        return <FileText size={16} className="text-emerald-400 shrink-0" />;
      case 'action':
        return <Zap size={16} className="text-amber-400 shrink-0" />;
    }
  };

  const getCategoryBadgeClass = (category: QuickSwitcherCategory) => {
    switch (category) {
      case 'session':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      case 'expert':
        return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
      case 'note':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'action':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick Switcher"
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-2xl bg-[var(--background-secondary,#1e1e24)] border border-[var(--border-subtle,#333)] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[72vh] text-[var(--text-primary,#fff)] transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Header */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--border-subtle,#333)] bg-[var(--background-tertiary,#18181d)]">
          <Search size={18} className="text-[var(--text-secondary,#888)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search sessions, experts, vault notes, or type > for actions..."
            className="flex-1 bg-transparent border-none outline-none text-base text-[var(--text-primary,#fff)] placeholder-[var(--text-muted,#777)]"
          />
          {loading && <Loader2 size={16} className="animate-spin text-blue-400 shrink-0" />}
          <div className="flex items-center gap-1.5 shrink-0 text-xs text-[var(--text-muted,#777)]">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface-hover,#2a2a32)] border border-[var(--border-subtle,#444)] text-[10px] font-mono">
              ESC
            </kbd>
          </div>
        </div>

        {/* Filter Indicator / Shortcut Pills */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border-subtle,#2a2a30)]/60 bg-[var(--background-primary,#141418)]/40 text-xs">
          <span className="text-[var(--text-muted,#777)] font-medium">Filter:</span>
          <button
            type="button"
            onClick={() => {
              setQuery((q) => (q.startsWith('>') ? q.slice(1).trim() : `> ${q.replace(/^[>@#/]\s*/, '')}`));
              inputRef.current?.focus();
            }}
            className={`px-2 py-0.5 rounded border transition-colors ${
              prefix === '>'
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 font-semibold'
                : 'bg-[var(--surface-subtle,#222)] text-[var(--text-secondary,#aaa)] border-[var(--border-subtle,#333)] hover:text-white'
            }`}
          >
            &gt; Actions
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery((q) => (q.startsWith('@') ? q.slice(1).trim() : `@${q.replace(/^[>@#/]\s*/, '')}`));
              inputRef.current?.focus();
            }}
            className={`px-2 py-0.5 rounded border transition-colors ${
              prefix === '@'
                ? 'bg-purple-500/20 text-purple-300 border-purple-500/40 font-semibold'
                : 'bg-[var(--surface-subtle,#222)] text-[var(--text-secondary,#aaa)] border-[var(--border-subtle,#333)] hover:text-white'
            }`}
          >
            @ Experts
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery((q) => (q.startsWith('#') ? q.slice(1).trim() : `#${q.replace(/^[>@#/]\s*/, '')}`));
              inputRef.current?.focus();
            }}
            className={`px-2 py-0.5 rounded border transition-colors ${
              prefix === '#'
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-semibold'
                : 'bg-[var(--surface-subtle,#222)] text-[var(--text-secondary,#aaa)] border-[var(--border-subtle,#333)] hover:text-white'
            }`}
          >
            # Notes
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery((q) => (q.startsWith('/') ? q.slice(1).trim() : `/${q.replace(/^[>@#/]\s*/, '')}`));
              inputRef.current?.focus();
            }}
            className={`px-2 py-0.5 rounded border transition-colors ${
              prefix === '/'
                ? 'bg-blue-500/20 text-blue-300 border-blue-500/40 font-semibold'
                : 'bg-[var(--surface-subtle,#222)] text-[var(--text-secondary,#aaa)] border-[var(--border-subtle,#333)] hover:text-white'
            }`}
          >
            / Sessions
          </button>
        </div>

        {/* Results List */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-2 space-y-1 min-h-[220px]">
          {filteredItems.length === 0 ? (
            <div className="py-12 text-center text-sm text-[var(--text-muted,#777)]">
              No matching sessions, experts, notes, or actions found.
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  data-index={idx}
                  onClick={() => void item.onSelect()}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-[var(--surface-active,#2c2d36)] text-white shadow-sm'
                      : 'hover:bg-[var(--surface-hover,#24242c)] text-[var(--text-secondary,#bbb)]'
                  }`}
                >
                  <div className="shrink-0">{renderCategoryIcon(item.category)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate text-white">{item.title}</span>
                      {item.badge && (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-mono border ${getCategoryBadgeClass(
                            item.category,
                          )}`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </div>
                    {item.subtitle && (
                      <div className="text-xs text-[var(--text-muted,#888)] truncate mt-0.5">
                        {item.subtitle}
                      </div>
                    )}
                    {item.tags && item.tags.length > 0 && (
                      <div className="flex items-center gap-1.5 mt-1 overflow-hidden">
                        {item.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-0.5 text-[10px] text-[var(--text-secondary,#999)] bg-[var(--surface-subtle,#1b1b20)] px-1.5 py-0.5 rounded"
                          >
                            <Tag size={9} />
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <div className="shrink-0 text-xs text-[var(--text-muted,#777)] flex items-center gap-1 font-mono">
                      <span>Select</span>
                      <ArrowRight size={13} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border-subtle,#333)] bg-[var(--background-tertiary,#18181d)] text-[11px] text-[var(--text-muted,#777)] font-mono">
          <div className="flex items-center gap-3">
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>esc close</span>
          </div>
          <div>{filteredItems.length} result{filteredItems.length === 1 ? '' : 's'}</div>
        </div>
      </div>
    </div>
  );
}
