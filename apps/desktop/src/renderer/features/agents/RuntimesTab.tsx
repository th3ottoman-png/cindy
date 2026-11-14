/**
 * Runtimes tab (ROADMAP 12.5): read-only status of the agent CLIs. One card per runtime — path,
 * installed version, pin match (Hermes), how many roster agents use it, and a Recheck button.
 * Nothing is installed or updated here (AGENTS.md §3: no auto-update). The host resolves each
 * binary the way its adapter does and runs --version; this tab only displays the result.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { RuntimeId, RuntimeStatus } from '@cindy/maker-core/runtime-status';

import type { RosterRow } from './agentsRosterModel';

const RUNTIME_LABELS: Record<RuntimeId, string> = {
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

const HEALTH_CLASS: Record<RuntimeStatus['health'], string> = {
  ok: 'text-[var(--text-success,#2a2)]',
  missing: 'text-[var(--text-tertiary)]',
  error: 'text-[var(--text-danger,#d33)]',
};

function countAgentsUsing(rows: readonly RosterRow[], id: RuntimeId): number {
  return rows.filter((r) => !r.error && (r.kind === 'expert' ? r.program === id : (r.runsOn?.includes(id) ?? false))).length;
}

export function RuntimesTab({ rows }: { rows: readonly RosterRow[] }) {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = window.electronAPI?.maker?.runtimes;
    if (!api) return;
    setBusy(true);
    try {
      const view = await api.list();
      setRuntimes(view.runtimes);
    } catch {
      // A failed probe leaves the previous cards; the host reports per-runtime health.
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const map = {} as Record<RuntimeId, number>;
    for (const id of Object.keys(RUNTIME_LABELS) as RuntimeId[]) map[id] = countAgentsUsing(rows, id);
    return map;
  }, [rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="runtimes-tab">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <span className="text-xs text-[var(--text-tertiary)]">{runtimes.length} runtimes · read-only</span>
        <button
          type="button"
          onClick={() => { void load(); }}
          disabled={busy}
          className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:opacity-50"
          data-testid="runtimes-recheck"
        >
          {busy ? 'Checking…' : 'Recheck'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2">
          {runtimes.map((rt) => (
            <div key={rt.id} className="flex flex-col gap-1 rounded-lg border border-[var(--border-default)] p-3" data-testid={`runtime-card-${rt.id}`}>
              <span className="flex items-center justify-between text-sm text-[var(--text-primary)]">
                {RUNTIME_LABELS[rt.id]}
                <span className={`text-xs ${HEALTH_CLASS[rt.health]}`} data-testid={`runtime-health-${rt.id}`}>{rt.health}</span>
              </span>
              <span className="break-all text-xs text-[var(--text-secondary)]" data-testid={`runtime-path-${rt.id}`}>{rt.path ?? 'not installed'}</span>
              <span className="text-xs text-[var(--text-secondary)]">
                version: <span className="text-[var(--text-primary)]" data-testid={`runtime-version-${rt.id}`}>{rt.version ?? '—'}</span>
              </span>
              {rt.pinned && (
                <span className="text-xs text-[var(--text-tertiary)]" data-testid={`runtime-pin-${rt.id}`}>
                  pin {rt.pinned} · {rt.matchesPin === null ? 'unknown' : rt.matchesPin ? 'matches' : 'mismatch'}
                </span>
              )}
              {rt.detail && <span className="text-xs text-[var(--text-tertiary)]">{rt.detail}</span>}
              <span className="mt-1 text-xs text-[var(--text-tertiary)]" data-testid={`runtime-agents-${rt.id}`}>{counts[rt.id]} agents use it</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
