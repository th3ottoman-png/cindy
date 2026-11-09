import { Boxes, FileText, Plug, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  TurnAttachment,
  TurnAttachmentCandidate,
} from '@cindy/maker-core/turn-attachment';

/**
 * Presentational half of ROADMAP 8.4. No store, no IPC, no side effects.
 *
 * The panel is a plain popover anchored above the composer, not a modal: it has
 * no overlay, no focus trap and no keyboard capture of its own. `TurnAttachmentSlot`
 * owns the draft and forwards the keys it intercepts.
 */

/** Kind to icon. Data, not a switch, so a new kind falls back instead of crashing. */
const KIND_ICONS: Record<string, LucideIcon> = {
  expert: Sparkles,
  skill: FileText,
  'mcp-server': Boxes,
  connector: Plug,
  'vault-note': FileText,
};

function kindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? FileText;
}

/** Short, stable provenance: the last path segment, or the whole source. */
function sourceTail(source: string): string {
  const trimmed = source.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export interface TurnAttachmentPanelProps {
  query: string;
  items: readonly TurnAttachmentCandidate[];
  focusedIndex: number;
  onFocusedIndexChange: (index: number) => void;
  onSelect: (item: TurnAttachmentCandidate) => void;
  onClose: () => void;
  loading?: boolean;
}

export function TurnAttachmentPanel({
  query,
  items,
  focusedIndex,
  onFocusedIndexChange,
  onSelect,
  onClose,
  loading = false,
}: TurnAttachmentPanelProps) {
  return (
    <div
      data-testid="turn-attachment-panel"
      data-query={query}
      role="listbox"
      aria-label="Attach a capability to this message"
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
        <span>Attach for this message only</span>
        <span className="truncate pl-2">{query ? `@${query}` : '@'}</span>
      </div>

      {loading && items.length === 0 && (
        <div
          data-testid="turn-attachment-loading"
          className="px-[8px] py-[10px] text-12 text-[var(--cmd-palette-item-meta)]"
        >
          Reading local capabilities...
        </div>
      )}

      {!loading && items.length === 0 && (
        <div
          data-testid="turn-attachment-empty"
          className="px-[8px] py-[10px] text-12 text-[var(--cmd-palette-empty)]"
        >
          No capability matches. Try @skill, @expert, @connector or @vault-note.
        </div>
      )}

      {items.map((item, index) => {
        const Icon = kindIcon(item.kind);
        const focused = index === focusedIndex;
        return (
          <button
            key={`${item.kind}:${item.id}`}
            type="button"
            role="option"
            aria-selected={focused}
            data-testid="turn-attachment-option"
            data-kind={item.kind}
            data-id={item.id}
            data-focused={focused ? 'true' : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onFocusedIndexChange(index)}
            onClick={() => onSelect(item)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-[8px] py-[6px] text-left',
              focused
                ? 'bg-[var(--cmd-palette-item-hover)]'
                : 'bg-transparent',
            )}
          >
            <Icon size={14} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
            <span className="min-w-0 flex-1 truncate text-13 text-[var(--cmd-palette-item-text)]">
              {item.title}
            </span>
            <span className="shrink-0 text-12 text-[var(--cmd-palette-item-meta)]">
              {item.kind}
            </span>
            <span className="max-w-[120px] shrink-0 truncate text-12 text-[var(--cmd-palette-item-meta)]">
              {sourceTail(item.source)}
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
          data-testid="turn-attachment-close"
          className="underline-offset-2 hover:underline"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          Esc to close
        </button>
        <span className="pl-2">Enter to attach. Nothing is enabled for the session.</span>
      </div>
    </div>
  );
}

export interface TurnAttachmentChipsProps {
  items: readonly TurnAttachment[];
  onRemove: (item: TurnAttachment) => void;
}

export function TurnAttachmentChips({ items, onRemove }: TurnAttachmentChipsProps) {
  if (items.length === 0) return null;
  return (
    <div
      data-testid="turn-attachment-chips"
      className="mb-2 flex flex-wrap items-center gap-1.5"
    >
      {items.map((item) => {
        const Icon = kindIcon(item.kind);
        return (
          <span
            key={`${item.kind}:${item.id}`}
            data-testid="turn-attachment-chip"
            data-kind={item.kind}
            data-id={item.id}
            data-source={item.source}
            className={cn(
              'inline-flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-0.5 text-12',
              'border-[var(--border-default)] bg-[var(--surface-hover)] text-[var(--text-secondary)]',
            )}
          >
            <Icon size={12} className="shrink-0" />
            <span className="truncate">{item.title}</span>
            <button
              type="button"
              aria-label={`Remove ${item.kind} ${item.title}`}
              data-testid="turn-attachment-chip-remove"
              className="shrink-0 text-[var(--text-secondary)] transition-opacity hover:opacity-70"
              onClick={() => onRemove(item)}
            >
              ✕
            </button>
          </span>
        );
      })}
    </div>
  );
}
