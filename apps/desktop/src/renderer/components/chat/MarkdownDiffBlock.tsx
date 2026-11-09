/**
 * MarkdownDiffBlock
 * ---------------------------------------------------------------------------
 * Renders unified diff blocks and file patches in chat messages as an
 * interactive visual diff review card:
 *  - Header bar with file path, addition/deletion stats (+N -M)
 *  - Interactive view mode toggle: Unified vs Split (Side-by-Side)
 *  - Collapsible body with expand/collapse chevron
 *  - Fullscreen inspection modal with backdrop blur
 *  - Gutter with line numbers, dedicated +/- symbol column, and GitHub-standard
 *    red/green highlighting
 *  - 1-click diff copy to clipboard with confirmation
 *
 * Visual contract is intentionally aligned with DiffView and theme tokens
 * (--diff-add-bg, --diff-del-bg, --diff-add-fg, --diff-del-fg, --diff-line-num).
 */

import { useState, useMemo, useCallback } from 'react';
import {
  FileCode,
  Columns2,
  Rows3,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  parseUnifiedDiff,
  type ParsedDiffCard,
  type UnifiedDiffLine,
  type SplitDiffRow,
} from '@cindy/maker-core/inline-diff-card';

export interface MarkdownDiffBlockProps {
  /** The raw text contents of a ```diff or ```patch fenced code block. */
  raw: string;
}

export type DiffCardViewMode = 'unified' | 'split';

export function MarkdownDiffBlock({ raw }: MarkdownDiffBlockProps) {
  const [viewMode, setViewMode] = useState<DiffCardViewMode>('unified');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const parsed: ParsedDiffCard = useMemo(() => parseUnifiedDiff(raw), [raw]);
  const lines = parsed.lines;
  const splitRows = parsed.splitRows;

  const maxLineNum = lines.length > 0
    ? Math.max(
        ...lines.map((l) => Math.max(l.newLineNumber ?? 0, l.oldLineNumber ?? 0, 1)),
      )
    : 0;
  const gutterWidth = String(maxLineNum).length;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }, [raw]);

  const displayName = parsed.filePath || parsed.fileName || 'diff';

  const renderUnifiedRows = (
    <pre className="m-0 w-max min-w-full p-0 text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5] font-mono">
      {lines.map((line, i) => (
        <div
          key={`${line.type}-${line.newLineNumber ?? line.oldLineNumber ?? i}-${i}`}
          className={cn(
            'flex min-h-[20px]',
            line.type === 'del' && 'bg-[var(--diff-del-bg)]',
            line.type === 'add' && 'bg-[var(--diff-add-bg)]',
            line.type === 'header' && 'bg-[var(--surface-elevated)]/60 text-[var(--text-tertiary)] italic',
          )}
        >
          {/* Line-number gutter */}
          <span
            className="shrink-0 select-none px-2 text-right text-[var(--diff-line-num)]"
            style={{ minWidth: `${gutterWidth + 3}ch` }}
          >
            {line.newLineNumber ?? line.oldLineNumber ?? (line.type === 'header' ? '⋯' : i + 1)}
          </span>
          {/* Symbol column (+ / - / space) */}
          <span
            className={cn(
              'shrink-0 w-4 select-none text-center',
              line.type === 'del' && 'text-[var(--diff-del-fg)]',
              line.type === 'add' && 'text-[var(--diff-add-fg)]',
              line.type === 'header' && 'text-[var(--text-tertiary)]',
            )}
          >
            {line.type === 'del' ? '-' : line.type === 'add' ? '+' : ' '}
          </span>
          {/* Content column */}
          <span
            className={cn(
              'flex-1 whitespace-pre pr-3',
              line.type === 'del' && 'text-[var(--diff-del-fg)]',
              line.type === 'add' && 'text-[var(--diff-add-fg)]',
            )}
          >
            {line.text}
          </span>
        </div>
      ))}
    </pre>
  );

  const renderSplitRows = (
    <div className="w-max min-w-full font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]">
      {splitRows.map((row, idx) => {
        if (row.isHeader) {
          return (
            <div
              key={`header-${idx}`}
              className="flex min-h-[20px] w-full items-center bg-[var(--surface-elevated)]/60 px-3 py-0.5 text-xs text-[var(--text-tertiary)] italic border-y border-[var(--border-subtle)]"
            >
              <span>{row.headerText}</span>
            </div>
          );
        }

        return (
          <div key={`split-${idx}`} className="flex min-h-[20px] w-full">
            {/* Left side (Original / Deletion) */}
            <div
              className={cn(
                'flex flex-1 min-w-[50%] border-r border-[var(--border-subtle)]',
                row.left?.type === 'del' && 'bg-[var(--diff-del-bg)]',
              )}
            >
              <span
                className="shrink-0 select-none px-2 text-right text-[var(--diff-line-num)] border-r border-[var(--border-subtle)]/40"
                style={{ minWidth: `${gutterWidth + 2}ch` }}
              >
                {row.left?.lineNumber ?? ''}
              </span>
              <span className="w-4 shrink-0 select-none text-center text-[var(--diff-del-fg)]">
                {row.left?.type === 'del' ? '-' : ' '}
              </span>
              <span
                className={cn(
                  'flex-1 whitespace-pre pr-2',
                  row.left?.type === 'del' && 'text-[var(--diff-del-fg)]',
                )}
              >
                {row.left?.text ?? ''}
              </span>
            </div>

            {/* Right side (Modified / Addition) */}
            <div
              className={cn(
                'flex flex-1 min-w-[50%]',
                row.right?.type === 'add' && 'bg-[var(--diff-add-bg)]',
              )}
            >
              <span
                className="shrink-0 select-none px-2 text-right text-[var(--diff-line-num)] border-r border-[var(--border-subtle)]/40"
                style={{ minWidth: `${gutterWidth + 2}ch` }}
              >
                {row.right?.lineNumber ?? ''}
              </span>
              <span className="w-4 shrink-0 select-none text-center text-[var(--diff-add-fg)]">
                {row.right?.type === 'add' ? '+' : ' '}
              </span>
              <span
                className={cn(
                  'flex-1 whitespace-pre pr-2',
                  row.right?.type === 'add' && 'text-[var(--diff-add-fg)]',
                )}
              >
                {row.right?.text ?? ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <div
        data-testid="interactive-diff-card"
        className={cn(
          'diff-card-root my-3 rounded-[12px] overflow-hidden',
          'border border-[var(--msg-code-block-border)]',
          'bg-[var(--msg-code-block-bg)] shadow-xs',
        )}
      >
        {/* Card Header Bar */}
        <div
          data-testid="diff-card-header"
          className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--msg-code-block-border)] bg-[var(--surface-elevated)]/40 select-none text-xs"
        >
          {/* File path & badge */}
          <div className="flex items-center gap-2 min-w-0 mr-2">
            <button
              type="button"
              onClick={() => setIsCollapsed((prev) => !prev)}
              aria-label={isCollapsed ? 'Expand diff' : 'Collapse diff'}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors p-0.5 rounded cursor-pointer"
            >
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            <FileCode size={14} className="shrink-0 text-[var(--text-tertiary)]" />
            <span
              title={parsed.filePath}
              className="font-mono text-xs font-medium text-[var(--text-primary)] truncate"
            >
              {displayName}
            </span>

            {/* Addition & deletion statistics */}
            <div className="flex items-center gap-1.5 shrink-0 ml-1 font-mono text-[11px]">
              {parsed.additions > 0 && (
                <span
                  data-testid="diff-stat-additions"
                  className="px-1.5 py-0.2 rounded-full font-semibold text-[var(--diff-add-fg)] bg-[var(--diff-add-bg)]"
                >
                  +{parsed.additions}
                </span>
              )}
              {parsed.deletions > 0 && (
                <span
                  data-testid="diff-stat-deletions"
                  className="px-1.5 py-0.2 rounded-full font-semibold text-[var(--diff-del-fg)] bg-[var(--diff-del-bg)]"
                >
                  -{parsed.deletions}
                </span>
              )}
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Unified vs Split Mode Selector */}
            <div className="flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-0.5 mr-1">
              <button
                type="button"
                data-testid="diff-mode-unified"
                onClick={() => setViewMode('unified')}
                aria-pressed={viewMode === 'unified'}
                title="Unified view"
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer',
                  viewMode === 'unified'
                    ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                )}
              >
                <Rows3 size={12} />
                <span className="hidden sm:inline">Unified</span>
              </button>
              <button
                type="button"
                data-testid="diff-mode-split"
                onClick={() => setViewMode('split')}
                aria-pressed={viewMode === 'split'}
                title="Split (side-by-side) view"
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer',
                  viewMode === 'split'
                    ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                )}
              >
                <Columns2 size={12} />
                <span className="hidden sm:inline">Split</span>
              </button>
            </div>

            {/* Copy diff button */}
            <button
              type="button"
              data-testid="diff-card-copy"
              onClick={handleCopy}
              title={copied ? 'Copied to clipboard' : 'Copy diff'}
              aria-label={copied ? 'Copied' : 'Copy diff'}
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
            >
              {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            </button>

            {/* Fullscreen inspection toggle */}
            <button
              type="button"
              data-testid="diff-card-fullscreen"
              onClick={() => setIsFullscreen(true)}
              title="Inspect full screen"
              aria-label="Inspect full screen"
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
            >
              <Maximize2 size={13} />
            </button>
          </div>
        </div>

        {/* Diff Content Body (Collapsible) */}
        {!isCollapsed && (
          <div
            data-testid="diff-card-content"
            className="diff-hscroll overflow-x-auto"
          >
            {viewMode === 'unified' ? renderUnifiedRows : renderSplitRows}
          </div>
        )}
      </div>

      {/* Fullscreen Inspection Modal Dialog */}
      {isFullscreen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Inspect diff: ${displayName}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-6"
        >
          <div className="relative flex flex-col w-full max-w-6xl h-[85vh] rounded-xl border border-[var(--border-default)] bg-[var(--surface)] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-default)] bg-[var(--surface-elevated)]/60">
              <div className="flex items-center gap-2 min-w-0">
                <FileCode size={16} className="text-[var(--text-tertiary)] shrink-0" />
                <span className="font-mono text-sm font-semibold text-[var(--text-primary)] truncate">
                  {displayName}
                </span>
                <div className="flex items-center gap-1.5 ml-2 font-mono text-xs">
                  {parsed.additions > 0 && (
                    <span className="px-2 py-0.5 rounded-full font-semibold text-[var(--diff-add-fg)] bg-[var(--diff-add-bg)]">
                      +{parsed.additions}
                    </span>
                  )}
                  {parsed.deletions > 0 && (
                    <span className="px-2 py-0.5 rounded-full font-semibold text-[var(--diff-del-fg)] bg-[var(--diff-del-bg)]">
                      -{parsed.deletions}
                    </span>
                  )}
                </div>
              </div>

              {/* Modal Controls */}
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-0.5 mr-1">
                  <button
                    type="button"
                    onClick={() => setViewMode('unified')}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1 rounded text-xs font-medium cursor-pointer',
                      viewMode === 'unified'
                        ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-xs'
                        : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                    )}
                  >
                    <Rows3 size={13} />
                    <span>Unified</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('split')}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1 rounded text-xs font-medium cursor-pointer',
                      viewMode === 'split'
                        ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-xs'
                        : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                    )}
                  >
                    <Columns2 size={13} />
                    <span>Split</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleCopy}
                  title="Copy diff"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                >
                  {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>

                <button
                  type="button"
                  data-testid="diff-fullscreen-close"
                  onClick={() => setIsFullscreen(false)}
                  title="Close inspection (Esc)"
                  aria-label="Close"
                  className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer ml-1"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="diff-hscroll flex-1 overflow-auto bg-[var(--msg-code-block-bg)] p-2">
              {viewMode === 'unified' ? renderUnifiedRows : renderSplitRows}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
