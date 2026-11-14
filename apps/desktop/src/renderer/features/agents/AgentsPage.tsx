/**
 * Agents page (ROADMAP 12.2): one roster over experts + imported agents, with search,
 * source filter chips, cards, a detail drawer and the New-agent form. Squads (12.4) and
 * Runtimes (12.5) tabs stay hidden until their rows are built. The Settings expert editor
 * stays; the drawer's Edit links to it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ExpertEntry } from '@cindy/maker-core/experts';
import type { ImportedAgent } from '@cindy/maker-core/imported-agents';

import { getDraft, subscribeDraft } from '@/state/newMakerDraft';

import { AgentDetailDrawer } from './AgentDetailDrawer';
import { NewAgentForm } from './NewAgentForm';
import { SquadsTab } from './SquadsTab';
import { ROSTER_FILTERS, buildRosterRows, filterRosterRows, type RosterFilter, type RosterRow } from './agentsRosterModel';

const CHIP_CLASS = 'rounded-full border px-2.5 py-0.5 text-xs';

export function AgentsPage() {
  const [experts, setExperts] = useState<ExpertEntry[]>([]);
  const [imported, setImported] = useState<ImportedAgent[]>([]);
  const [routes, setRoutes] = useState<Record<string, { provider?: string; model?: string }>>({});
  const [workingDir, setWorkingDir] = useState<string | null>(() => getDraft().workingDir);
  const [filter, setFilter] = useState<RosterFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // ROADMAP 12.4b: the Squads tab is built; Runtimes (12.5) stays hidden until its row lands.
  const [tab, setTab] = useState<'agents' | 'squads'>('agents');

  useEffect(() => subscribeDraft(() => setWorkingDir(getDraft().workingDir)), []);

  useEffect(() => {
    const maker = window.electronAPI?.maker;
    if (!maker) return undefined;
    let alive = true;
    void maker.experts.list().then((list) => { if (alive) setExperts(list); }).catch(() => undefined);
    void maker.providers.getRouting().then((r) => {
      if (alive && r && typeof r === 'object') setRoutes((r as { routes?: Record<string, { provider?: string; model?: string }> }).routes ?? {});
    }).catch(() => undefined);
    const offExperts = maker.experts.onChanged((list) => { if (alive) setExperts(list); });
    return () => { alive = false; offExperts(); };
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.maker?.importedAgents;
    if (!api) return undefined;
    let alive = true;
    void api.list(workingDir).then((view) => { if (alive) setImported(view.agents); }).catch(() => undefined);
    const off = api.onChanged((view) => { if (alive) setImported(view.agents); });
    return () => { alive = false; off(); };
  }, [workingDir]);

  const rows = useMemo(() => buildRosterRows(experts, imported), [experts, imported]);
  const visible = useMemo(() => filterRosterRows(rows, filter, query), [rows, filter, query]);
  const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? null : null;

  const onSaved = useCallback((slug: string) => {
    setFormOpen(false);
    setNotice(`Saved "~/.cindy-harness/experts/${slug}". Hand-edit the file any time; the page follows it.`);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agents-page">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-default)] px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-medium text-[var(--text-primary)]">Agents</h1>
          <div className="flex items-center gap-1" role="tablist" aria-label="Agents page tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'agents'}
              onClick={() => setTab('agents')}
              className={`${CHIP_CLASS} ${tab === 'agents' ? 'border-[var(--border-strong,#888)] bg-[var(--bg-subtle,rgba(127,127,127,0.12))] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]'}`}
              data-testid="agents-tab-agents"
            >
              Agents
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'squads'}
              onClick={() => setTab('squads')}
              className={`${CHIP_CLASS} ${tab === 'squads' ? 'border-[var(--border-strong,#888)] bg-[var(--bg-subtle,rgba(127,127,127,0.12))] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]'}`}
              data-testid="agents-tab-squads"
            >
              Squads
            </button>
          </div>
          {tab === 'agents' && <span className="text-xs text-[var(--text-tertiary)]">{rows.length} agents</span>}
        </div>
        {tab === 'agents' && (
          <button
            type="button"
            onClick={() => { setFormOpen((open) => !open); setNotice(null); }}
            className="rounded-md bg-[var(--bg-accent,#3b82f6)] px-3 py-1.5 text-sm text-white"
            data-testid="agents-new-agent"
          >
            New agent
          </button>
        )}
      </div>

      {tab === 'squads' ? (
        <SquadsTab rows={rows} workingDir={workingDir} />
      ) : (
        <>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents"
          aria-label="Search agents"
          className="w-56 rounded-md border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]"
          data-testid="agents-search"
        />
        {ROSTER_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`${CHIP_CLASS} ${filter === f.id
              ? 'border-[var(--border-strong,#888)] bg-[var(--bg-subtle,rgba(127,127,127,0.12))] text-[var(--text-primary)]'
              : 'border-[var(--border-default)] text-[var(--text-secondary)]'}`}
            data-testid={`agents-filter-${f.id}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {notice && <p className="px-4 pb-2 text-xs text-[var(--text-secondary)]" data-testid="agents-notice">{notice}</p>}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-4">
          {formOpen && (
            <div className="mb-4">
              <NewAgentForm rows={rows} routes={routes} workingDir={workingDir} onClose={() => setFormOpen(false)} onSaved={onSaved} />
            </div>
          )}
          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--text-tertiary)]">No agents match.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
              {visible.map((row) => (
                <AgentCard key={row.id} row={row} selected={row.id === selectedId} onSelect={() => setSelectedId(row.id)} />
              ))}
            </div>
          )}
        </div>
        {selected && <AgentDetailDrawer row={selected} onClose={() => setSelectedId(null)} />}
      </div>
        </>
      )}
    </div>
  );
}

function AgentCard({ row, selected, onSelect }: { row: RosterRow; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex flex-col gap-1 rounded-lg border p-3 text-left ${selected ? 'border-[var(--border-strong,#888)]' : 'border-[var(--border-default)]'} hover:bg-[var(--bg-subtle,rgba(127,127,127,0.08))]`}
      data-testid={`agent-card-${row.id}`}
    >
      <span className="truncate text-sm text-[var(--text-primary)]">{row.name}</span>
      <span className="line-clamp-2 min-h-[2em] text-xs text-[var(--text-secondary)]">{row.description || row.error || ''}</span>
      <span className="mt-1 flex flex-wrap gap-1 text-xs">
        <span className="rounded bg-[var(--bg-subtle,rgba(127,127,127,0.12))] px-1.5 py-0.5 text-[var(--text-secondary)]">{row.program}</span>
        <span className="rounded bg-[var(--bg-subtle,rgba(127,127,127,0.12))] px-1.5 py-0.5 text-[var(--text-tertiary)]">{row.source}</span>
        {row.error && <span className="rounded px-1.5 py-0.5 text-[var(--text-danger,#d33)]">error</span>}
      </span>
    </button>
  );
}
