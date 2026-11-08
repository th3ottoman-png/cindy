import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Loader2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import {
  createCapabilityRegistry,
  groupCapabilitiesByKind,
  type CapabilityDescriptor,
} from '@cindy/maker-core/extensions';
import {
  filterQuickSwitcherItems,
  type QuickSwitcherItem,
} from '@/components/quick-switcher';

import { buildCapabilitySources } from './capabilitySources';

/**
 * ROADMAP 8.1 Capabilities hub. One search over every installed capability.
 *
 * Kinds are derived from the collected descriptors, never from a fixed list.
 * Filtering reuses the Cmd+K matcher so the two palettes rank the same way.
 * Every row shows its source file, trust and declared interface, which is the
 * provenance that AGENTS section 6.4 asks for.
 */
export interface CapabilitiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * All collected rows must be reachable from the unfiltered view, otherwise a
 * kind registered late in the source order would vanish from the default list.
 * The matcher still caps ranked results for a real query.
 */
const RESULT_LIMIT = 300;

export function CapabilitiesDialog({ open, onOpenChange }: CapabilitiesDialogProps) {
  const navigate = useNavigate();
  const [descriptors, setDescriptors] = useState<CapabilityDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuery('');
    setKindFilter(null);
    setSelectedIndex(0);
    setLoading(true);

    const registry = createCapabilityRegistry();
    for (const source of buildCapabilitySources()) registry.register(source);
    void registry.collect().then((rows) => {
      if (cancelled) return;
      setDescriptors(rows);
      setLoading(false);
    });

    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      handleClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, handleClose]);

  const descriptorById = useMemo(
    () => new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])),
    [descriptors],
  );

  const groups = useMemo(() => groupCapabilitiesByKind(descriptors), [descriptors]);

  const items = useMemo<QuickSwitcherItem[]>(() => {
    const scoped = kindFilter
      ? descriptors.filter((descriptor) => descriptor.kind === kindFilter)
      : descriptors;
    return scoped.map((descriptor) => ({
      id: descriptor.id,
      // The hub does not use Cmd+K prefixes. One neutral bucket keeps the
      // shared matcher reusable without widening its category union.
      category: 'action',
      title: descriptor.title,
      subtitle: [descriptor.subtitle, descriptor.source].filter(Boolean).join(' - '),
      badge: descriptor.kind,
      tags: [...(descriptor.tags ?? []), descriptor.declaredInterface, descriptor.trust],
      onSelect: () => {
        handleClose();
        if (descriptor.openPath) navigate(descriptor.openPath);
      },
    }));
  }, [descriptors, kindFilter, handleClose, navigate]);

  const filtered = useMemo(
    () => filterQuickSwitcherItems(items, query, RESULT_LIMIT),
    [items, query],
  );

  useEffect(() => setSelectedIndex(0), [query, kindFilter]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => (filtered.length ? (index + 1) % filtered.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) =>
        filtered.length ? (index - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (filtered[selectedIndex]) void filtered[selectedIndex].onSelect();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Capabilities"
      data-testid="capabilities-dialog"
      className="fixed inset-0 z-[101] flex items-start justify-center pt-[10vh] bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border-subtle,#333)] bg-[var(--background-secondary,#1e1e24)] text-[var(--text-primary,#fff)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border-subtle,#333)] bg-[var(--background-tertiary,#18181d)] px-4 py-3.5">
          <Boxes size={18} className="shrink-0 text-[var(--text-secondary,#888)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search capabilities"
            data-testid="capabilities-query"
            placeholder="Search experts, skills, plugins, connectors, vault notes, model routes..."
            className="flex-1 border-none bg-transparent text-base text-[var(--text-primary,#fff)] outline-none placeholder:text-[var(--text-placeholder)]"
          />
          {loading && (
            <Loader2
              size={16}
              className="shrink-0 animate-spin text-[var(--text-secondary,#888)]"
              data-testid="capabilities-loading"
            />
          )}
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close capabilities"
            className="shrink-0 rounded p-1 text-[var(--text-secondary,#888)] hover:bg-[var(--surface-hover,#24242c)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle,#2a2a30)] bg-[var(--background-primary,#141418)] px-4 py-2 text-xs">
          <span className="mr-1 text-[var(--text-placeholder,#777)]">Kinds</span>
          <button
            type="button"
            data-testid="capabilities-kind-chip"
            data-kind="all"
            onClick={() => setKindFilter(null)}
            className={`rounded border px-2 py-0.5 transition-colors ${
              kindFilter === null
                ? 'border-[var(--border-strong,#555)] bg-[var(--surface-active,#2c2d36)] text-[var(--text-primary,#fff)]'
                : 'border-[var(--border-subtle,#333)] text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]'
            }`}
          >
            All
          </button>
          {groups.map((group) => (
            <button
              key={group.kind}
              type="button"
              data-testid="capabilities-kind-chip"
              data-kind={group.kind}
              onClick={() => setKindFilter(kindFilter === group.kind ? null : group.kind)}
              className={`rounded border px-2 py-0.5 transition-colors ${
                kindFilter === group.kind
                  ? 'border-[var(--border-strong,#555)] bg-[var(--surface-active,#2c2d36)] text-[var(--text-primary,#fff)]'
                  : 'border-[var(--border-subtle,#333)] text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]'
              }`}
            >
              {group.kind} <span className="opacity-70">{group.items.length}</span>
            </button>
          ))}
        </div>

        <div ref={listRef} className="min-h-[240px] flex-1 space-y-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-[var(--text-placeholder,#777)]">
              {loading ? 'Reading local capability files...' : 'No matching capabilities.'}
            </div>
          ) : (
            filtered.map((item, index) => {
              const descriptor = descriptorById.get(item.id);
              if (!descriptor) return null;
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={item.id}
                  data-index={index}
                  data-testid="capability-row"
                  data-kind={descriptor.kind}
                  data-id={descriptor.id}
                  data-source={descriptor.source}
                  onClick={() => void item.onSelect()}
                  className={`cursor-pointer rounded-lg px-3 py-2.5 transition-colors ${
                    isSelected
                      ? 'bg-[var(--surface-active,#2c2d36)] text-[var(--text-primary,#fff)]'
                      : 'text-[var(--text-secondary,#bbb)] hover:bg-[var(--surface-hover,#24242c)]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--text-primary,#fff)]">
                      {descriptor.title}
                    </span>
                    <span className="shrink-0 rounded border border-[var(--border-subtle,#333)] px-1.5 py-0.5 font-mono text-[10px] uppercase text-[var(--text-secondary,#999)]">
                      {descriptor.kind}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-placeholder,#777)]">
                      {descriptor.trust}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-placeholder,#777)]">
                      {descriptor.enabled ? 'on' : 'off'}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs text-[var(--text-placeholder,#777)]">
                    {descriptor.subtitle ? `${descriptor.subtitle} - ` : ''}
                    {descriptor.source}
                    {descriptor.sourceLine ? `:${descriptor.sourceLine}` : ''}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-secondary,#999)]">
                    <span className="font-mono">{descriptor.declaredInterface}</span>
                    {descriptor.detail && <span className="truncate">{descriptor.detail}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border-subtle,#333)] bg-[var(--background-tertiary,#18181d)] px-4 py-2 font-mono text-[11px] text-[var(--text-placeholder,#777)]">
          <span data-testid="capabilities-count">
            {descriptors.length} capabilities / {groups.length} kinds
          </span>
          <span>Local only. No outbound calls. ESC to close.</span>
        </div>
      </div>
    </div>
  );
}
