import { Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { TeammatePickerCandidate } from './teammatePickerRoster';

/**
 * Presentational half of the ROADMAP 12.3b teammate picker. Same popover contract as
 * the 8.4 attachment panel: no overlay, no focus trap, no keyboard capture of its own —
 * TeammatePickerSlot owns the draft and forwards the keys it intercepts.
 */
export interface TeammatePickerPanelProps {
  query: string;
  items: readonly TeammatePickerCandidate[];
  focusedIndex: number;
  onFocusedIndexChange: (index: number) => void;
  onSelect: (item: TeammatePickerCandidate) => void;
  onClose: () => void;
  loading?: boolean;
}

export function TeammatePickerPanel({
  query,
  items,
  focusedIndex,
  onFocusedIndexChange,
  onSelect,
  onClose,
  loading = false,
}: TeammatePickerPanelProps) {
  return (
    <div
      data-testid="teammate-picker-panel"
      data-query={query}
      role="listbox"
      aria-label="Bring in a teammate"
      className={cn(
        'absolute left-0 bottom-full z-50 mb-2 w-[420px] overflow-hidden',
        'rounded-[12px] border p-[6px]',
        'bg-[var(--cmd-palette-bg)] border-[var(--cmd-palette-border)]',
      )}
      style={{ boxShadow: 'var(--shadow-menu)' }}
    >
      <div
        className={cn(
          'flex items-center justify-between px-[8px] py-[6px] text-12',
          'text-[var(--cmd-palette-item-meta)]',
        )}
      >
        <span>Bring in a teammate — stays until removed from the manifest</span>
        <span className="truncate pl-2">{query ? `@agent:${query}` : '@agent:'}</span>
      </div>

      {loading && items.length === 0 && (
        <div
          data-testid="teammate-picker-loading"
          className="px-[8px] py-[10px] text-12 text-[var(--cmd-palette-item-meta)]"
        >
          Reading the agent roster...
        </div>
      )}

      {!loading && items.length === 0 && (
        <div
          data-testid="teammate-picker-empty"
          className="px-[8px] py-[10px] text-12 text-[var(--cmd-palette-empty)]"
        >
          No roster agent matches. Agents live in ~/.cindy-harness/experts and the imported directories.
        </div>
      )}

      {items.map((item, index) => {
        const focused = index === focusedIndex;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={focused}
            aria-disabled={item.disabled || undefined}
            data-testid="teammate-picker-option"
            data-id={item.id}
            data-disabled={item.disabled ? 'true' : undefined}
            data-focused={focused ? 'true' : undefined}
            title={item.disabled ? item.disabledReason : [item.description, item.path].filter(Boolean).join('\n')}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onFocusedIndexChange(index)}
            onClick={() => onSelect(item)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-[8px] py-[6px] text-left',
              focused ? 'bg-[var(--cmd-palette-item-hover)]' : 'bg-transparent',
              item.disabled && 'opacity-50',
            )}
          >
            <Users size={14} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
            <span className="min-w-0 flex-1 truncate text-13 text-[var(--cmd-palette-item-text)]">
              {item.name}
            </span>
            <span className="shrink-0 rounded border border-[var(--cmd-palette-border)] px-1 text-11 text-[var(--cmd-palette-item-meta)]">
              {item.program}
            </span>
            <span className="max-w-[120px] shrink-0 truncate text-12 text-[var(--cmd-palette-item-meta)]">
              {item.source}
            </span>
          </button>
        );
      })}

      <div
        className={cn(
          'mt-1 border-t px-[8px] py-[6px] text-12',
          'border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-meta)]',
        )}
      >
        <button
          type="button"
          data-testid="teammate-picker-close"
          className="underline-offset-2 hover:underline"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          Esc to close
        </button>
        <span className="pl-2">Enter to insert the @agent: token. The teammate joins when you send.</span>
      </div>
    </div>
  );
}
