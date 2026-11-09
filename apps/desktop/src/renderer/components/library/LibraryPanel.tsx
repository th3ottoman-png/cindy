import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, MessageSquare, Sparkles, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  libraryChatDate,
  libraryEntryToken,
  libraryKindSummary,
  searchLibrary,
  type LibraryEntry,
} from '@cindy/maker-core/library-index';

import { closeLibrary, useLibraryOpen } from './libraryStore';

/**
 * Library workspace (ROADMAP 8.5).
 *
 * One search over vault notes, auto-saved chat transcripts and generated
 * summaries, with a citation inspector. It is deliberately not a modal: there is
 * no backdrop and no focus trap, so a row can be dragged straight onto the
 * composer. Dropping writes an 8.4 `@vault-note:` token, which becomes a
 * turn-scoped attachment for the next message.
 */

const KIND_ICONS: Record<string, LucideIcon> = {
  note: FileText,
  chat: MessageSquare,
  summary: Sparkles,
  artifact: BookOpen,
};

const RESULT_LIMIT = 60;

type ScanState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; entries: LibraryEntry[]; vaultDir?: string; scannedAt?: string }
  | { status: 'error'; error: string };

function kindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? FileText;
}

function formatDate(ms: number | null): string {
  if (!ms) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function LibraryPanel() {
  const open = useLibraryOpen();
  const [state, setState] = useState<ScanState>({ status: 'idle' });
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const scan = useCallback(async () => {
    const api = window.electronAPI?.maker?.library;
    if (!api || typeof api.scan !== 'function') {
      setState({ status: 'error', error: 'Library scan is not available in this build.' });
      return;
    }
    setState({ status: 'loading' });
    try {
      const result = await api.scan();
      if (!result.ok) {
        setState({ status: 'error', error: result.error ?? 'The library could not be read.' });
        return;
      }
      setState({
        status: 'ready',
        entries: result.entries,
        vaultDir: result.vaultDir,
        scannedAt: result.scannedAt,
      });
    } catch (error) {
      setState({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // A fresh open starts clean: the scan is fresh anyway, and a stale query
    // would hide most of the vault the moment the panel appears.
    setQuery('');
    setKind(null);
    setSelected(null);
    void scan();
  }, [open, scan]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 30);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLibrary();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const entries = state.status === 'ready' ? state.entries : [];
  const summary = useMemo(() => libraryKindSummary(entries), [entries]);

  const results = useMemo(() => {
    const base = kind ? entries.filter((entry) => entry.kind === kind) : entries;
    return searchLibrary(base, query, RESULT_LIMIT);
  }, [entries, kind, query]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selected) ?? null,
    [entries, selected],
  );

  const copyToken = async (entry: LibraryEntry) => {
    const token = libraryEntryToken(entry);
    try {
      await navigator.clipboard.writeText(token);
      setCopied(token);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  if (!open) return null;

  return (
    <div
      data-testid="library-panel"
      role="dialog"
      aria-label="Library"
      className={cn(
        'fixed left-3 top-16 bottom-24 z-50 flex w-[540px] max-w-[calc(100vw-24px)] flex-col',
        'rounded-[12px] border bg-[var(--cmd-palette-bg)] border-[var(--cmd-palette-border)]',
      )}
      style={{ boxShadow: 'var(--shadow-menu)' }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--cmd-palette-border)] px-3 py-2">
        <BookOpen size={15} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
        <span className="flex-1 text-13 font-medium text-[var(--cmd-palette-item-text)]">
          Library
        </span>
        <span
          data-testid="library-count"
          className="text-12 text-[var(--cmd-palette-item-meta)]"
        >
          {state.status === 'ready' ? `${entries.length} items` : state.status}
        </span>
        <button
          type="button"
          aria-label="Close library"
          data-testid="library-close"
          className="rounded p-1 text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)]"
          onClick={closeLibrary}
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-3 py-2">
        <input
          ref={searchRef}
          data-testid="library-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search notes, chats and summaries"
          className={cn(
            'w-full rounded-md border bg-transparent px-2 py-1.5 text-13',
            'border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-text)]',
            'outline-none placeholder:text-[var(--text-placeholder)]',
          )}
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="library-kind-all"
            data-active={kind === null ? 'true' : undefined}
            onClick={() => setKind(null)}
            className={cn(
              'rounded border px-1.5 py-0.5 text-12',
              kind === null
                ? 'border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-text)]'
                : 'border-transparent text-[var(--cmd-palette-item-meta)]',
            )}
          >
            All <span className="pl-1">{entries.length}</span>
          </button>
          {summary.map((group) => (
            <button
              key={group.kind}
              type="button"
              data-testid="library-kind-chip"
              data-kind={group.kind}
              data-active={kind === group.kind ? 'true' : undefined}
              onClick={() => setKind(kind === group.kind ? null : group.kind)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-12',
                kind === group.kind
                  ? 'border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-text)]'
                  : 'border-transparent text-[var(--cmd-palette-item-meta)]',
              )}
            >
              {group.kind} <span className="pl-1">{group.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {state.status === 'loading' && (
          <div
            data-testid="library-loading"
            className="px-2 py-3 text-12 text-[var(--cmd-palette-item-meta)]"
          >
            Reading the vault...
          </div>
        )}
        {state.status === 'error' && (
          <div
            data-testid="library-error"
            className="px-2 py-3 text-12 text-[var(--destructive)]"
          >
            {state.error}
          </div>
        )}
        {state.status === 'ready' && results.length === 0 && (
          <div
            data-testid="library-empty"
            className="px-2 py-3 text-12 text-[var(--cmd-palette-empty)]"
          >
            Nothing matches. Try a note title, a tag or a word from the body.
          </div>
        )}
        {results.map((entry) => {
          const Icon = kindIcon(entry.kind);
          const isSelected = entry.path === selected;
          return (
            <div
              key={entry.path}
              data-testid="library-row"
              data-kind={entry.kind}
              data-path={entry.path}
              data-selected={isSelected ? 'true' : undefined}
              draggable
              onDragStart={(event) => {
                const token = libraryEntryToken(entry);
                event.dataTransfer.setData('text/plain', token);
                event.dataTransfer.setData(
                  'application/x-cindy-library',
                  JSON.stringify({ path: entry.path, kind: entry.kind, token }),
                );
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => setSelected(entry.path)}
              className={cn(
                'cursor-grab rounded-md px-2 py-1.5',
                isSelected
                  ? 'bg-[var(--cmd-palette-item-hover)]'
                  : 'hover:bg-[var(--cmd-palette-item-hover)]',
              )}
            >
              <div className="flex items-center gap-2">
                <Icon size={13} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
                <span className="min-w-0 flex-1 truncate text-13 text-[var(--cmd-palette-item-text)]">
                  {entry.title}
                </span>
                <span className="shrink-0 text-12 text-[var(--cmd-palette-item-meta)]">
                  {entry.kind}
                </span>
                <span className="shrink-0 text-12 text-[var(--cmd-palette-item-meta)]">
                  {entry.kind === 'chat' ? libraryChatDate(entry.path) ?? '' : formatDate(entry.updatedAt)}
                </span>
              </div>
              {entry.excerpt && (
                <div className="mt-0.5 line-clamp-2 pl-[21px] text-12 text-[var(--cmd-palette-item-meta)]">
                  {entry.excerpt}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--cmd-palette-border)] px-3 py-2">
        {selectedEntry ? (
          <div data-testid="library-inspector" data-path={selectedEntry.path}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-12 text-[var(--cmd-palette-item-text)]">
                {selectedEntry.path}
              </span>
              <button
                type="button"
                data-testid="library-copy-token"
                onClick={() => void copyToken(selectedEntry)}
                className="shrink-0 rounded border border-[var(--cmd-palette-border)] px-1.5 py-0.5 text-12 text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)]"
              >
                {copied === libraryEntryToken(selectedEntry) ? 'Copied' : 'Copy token'}
              </button>
            </div>
            <div className="mt-1 text-12 text-[var(--cmd-palette-item-meta)]">
              {selectedEntry.citations.length > 0
                ? `${selectedEntry.citations.length} citing session${selectedEntry.citations.length === 1 ? '' : 's'}`
                : 'No citing sessions'}
            </div>
            {selectedEntry.citations.length > 0 && (
              <ul data-testid="library-citations" className="mt-1 space-y-0.5">
                {selectedEntry.citations.map((path) => (
                  <li
                    key={path}
                    data-testid="library-citation"
                    className="truncate text-12 text-[var(--cmd-palette-item-text)]"
                  >
                    {libraryChatDate(path) ? `${libraryChatDate(path)} ` : ''}
                    {path}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="text-12 text-[var(--cmd-palette-item-meta)]">
            Drag a row onto the composer to attach it to one message.
          </div>
        )}
      </div>
    </div>
  );
}
