import { useCallback, useEffect, useMemo, useState } from 'react';
import { Network, RefreshCw, Search, Tag, FileText, ArrowUpRight, ArrowDownLeft, AlertCircle, ExternalLink } from 'lucide-react';
import type { VaultGraph, VaultGraphNode } from '@cindy/maker-core/vault-graph';
import type { TabKindBodyProps } from '../../types';

export function VaultGraphTabBody({}: TabKindBodyProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null);

  const loadGraph = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      if (typeof window.electronAPI?.maker?.vault?.getGraph !== 'function') {
        setError('Vault graph API not available');
        setLoading(false);
        return;
      }
      const res = await window.electronAPI.maker.vault.getGraph(force);
      if (!res.ok || !res.graph) {
        if (res.error === 'no-vault') {
          setError('No notes vault configured. Configure a vault directory in Settings -> Notes Vault.');
        } else {
          setError(res.error ?? 'Failed to load vault graph');
        }
        setGraph(null);
      } else {
        setGraph(res.graph);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGraph();
    const unsub = window.electronAPI?.maker?.vault?.onChanged?.(() => {
      loadGraph(true);
    });
    return () => {
      unsub?.();
    };
  }, [loadGraph]);

  // Sorted list of top tags
  const tagsList = useMemo(() => {
    if (!graph?.tags) return [];
    return Object.entries(graph.tags)
      .map(([name, paths]) => ({ name, count: paths.length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [graph]);

  // Filtered notes based on tag and search query
  const filteredNotes = useMemo(() => {
    if (!graph?.nodes) return [];
    let list = Object.values(graph.nodes);

    if (selectedTag) {
      const taggedPaths = new Set(graph.tags[selectedTag] ?? []);
      list = list.filter((n) => taggedPaths.has(n.path));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (n) =>
          n.path.toLowerCase().includes(q) ||
          n.title.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }, [graph, selectedTag, searchQuery]);

  const activeNode: VaultGraphNode | null = useMemo(() => {
    if (!selectedNotePath || !graph?.nodes) return null;
    return graph.nodes[selectedNotePath] ?? null;
  }, [selectedNotePath, graph]);

  const activeBacklinks: string[] = useMemo(() => {
    if (!selectedNotePath || !graph?.backlinks) return [];
    return graph.backlinks[selectedNotePath] ?? [];
  }, [selectedNotePath, graph]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground text-xs select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-1.5 font-medium">
          <Network size={14} className="text-primary" />
          <span>Vault Graph & Tags</span>
          {graph && (
            <span className="ml-1 rounded-full bg-secondary/80 px-1.5 py-0.2 text-[10px] text-muted-foreground font-mono">
              {graph.totalNotes} notes
            </span>
          )}
        </div>
        <button
          onClick={() => loadGraph(true)}
          disabled={loading}
          className="rounded p-1 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title="Refresh Graph"
          aria-label="Refresh Graph"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="m-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-600 dark:text-amber-400">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div className="flex-1 text-[11px] leading-relaxed">{error}</div>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && !graph && (
        <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
          <RefreshCw size={16} className="animate-spin mr-2" />
          <span>Indexing vault notes...</span>
        </div>
      )}

      {graph && (
        <>
          {/* Search bar */}
          <div className="border-b border-border/40 px-3 py-2">
            <div className="relative flex items-center">
              <Search size={12} className="absolute left-2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Filter by note title, path, or tag..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded bg-secondary/50 py-1 pl-6 pr-2 text-xs text-foreground placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Tags Cloud / Pill Explorer */}
          {tagsList.length > 0 && (
            <div className="border-b border-border/40 px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1 font-medium">
                  <Tag size={11} /> Tags ({tagsList.length})
                </span>
                {selectedTag && (
                  <button
                    onClick={() => setSelectedTag(null)}
                    className="text-[10px] text-primary hover:underline"
                  >
                    Clear tag
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pr-1">
                <button
                  onClick={() => setSelectedTag(null)}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    !selectedTag
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                  }`}
                >
                  All ({graph.totalNotes})
                </button>
                {tagsList.map(({ name, count }) => (
                  <button
                    key={name}
                    onClick={() => setSelectedTag(selectedTag === name ? null : name)}
                    className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                      selectedTag === name
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                    }`}
                  >
                    #{name} <span className="opacity-70 font-mono">({count})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Main Panes: Notes List & Connections Detail */}
          <div className="flex flex-1 min-h-0 flex-col">
            {/* Notes List */}
            <div className="flex-1 overflow-y-auto border-b border-border/40">
              <div className="p-2 space-y-0.5">
                {filteredNotes.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground text-[11px]">
                    No matching notes found.
                  </div>
                ) : (
                  filteredNotes.map((note) => {
                    const isSelected = selectedNotePath === note.path;
                    const backlinkCount = graph.backlinks[note.path]?.length ?? 0;
                    return (
                      <div
                        key={note.path}
                        onClick={() => setSelectedNotePath(isSelected ? null : note.path)}
                        className={`group flex items-start justify-between rounded px-2 py-1.5 cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-primary/10 border border-primary/30 text-primary'
                            : 'hover:bg-secondary/60 text-foreground'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <FileText size={12} className="shrink-0 text-muted-foreground" />
                            <span className="font-medium truncate text-xs">{note.title}</span>
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground font-mono mt-0.5">
                            {note.path}
                          </div>
                          {note.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {note.tags.map((t) => (
                                <span
                                  key={t}
                                  className="rounded bg-secondary/80 px-1 py-0 text-[9px] text-muted-foreground"
                                >
                                  #{t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        {backlinkCount > 0 && (
                          <span
                            className="ml-2 shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground font-mono"
                            title={`${backlinkCount} incoming backlinks`}
                          >
                            {backlinkCount} links
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Note Detail / Connections Inspector */}
            {activeNode && (
              <div className="h-48 overflow-y-auto bg-secondary/20 p-3 text-[11px] border-t border-border/60">
                <div className="flex items-center justify-between pb-1.5 border-b border-border/30">
                  <span className="font-semibold text-foreground truncate">{activeNode.title}</span>
                  <button
                    onClick={() => setSelectedNotePath(null)}
                    className="text-muted-foreground hover:text-foreground text-[10px]"
                  >
                    Close
                  </button>
                </div>

                <div className="mt-2 space-y-2">
                  {/* Outgoing Wikilinks */}
                  <div>
                    <span className="flex items-center gap-1 font-medium text-muted-foreground text-[10px] uppercase tracking-wider">
                      <ArrowUpRight size={11} className="text-sky-500" /> Outgoing Links ({activeNode.outgoingLinks.length})
                    </span>
                    {activeNode.outgoingLinks.length === 0 ? (
                      <div className="text-[10px] text-muted-foreground italic pl-3 mt-0.5">None</div>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-1 pl-1">
                        {activeNode.outgoingLinks.map((target) => (
                          <span
                            key={target}
                            className="rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20 px-1.5 py-0.5 text-[10px]"
                          >
                            [[{target}]]
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Incoming Backlinks */}
                  <div>
                    <span className="flex items-center gap-1 font-medium text-muted-foreground text-[10px] uppercase tracking-wider">
                      <ArrowDownLeft size={11} className="text-emerald-500" /> Incoming Backlinks ({activeBacklinks.length})
                    </span>
                    {activeBacklinks.length === 0 ? (
                      <div className="text-[10px] text-muted-foreground italic pl-3 mt-0.5">No incoming backlinks</div>
                    ) : (
                      <div className="mt-1 space-y-0.5 pl-1">
                        {activeBacklinks.map((srcPath) => (
                          <button
                            key={srcPath}
                            onClick={() => setSelectedNotePath(srcPath)}
                            className="block w-full text-left truncate rounded px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
                          >
                            ← {graph.nodes[srcPath]?.title ?? srcPath}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
