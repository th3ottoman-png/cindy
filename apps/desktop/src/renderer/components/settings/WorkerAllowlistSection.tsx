/**
 * Settings -> Personalization -> Helper agents (ROADMAP 13.8).
 *
 * The owner decides which routing.yaml routes a lead may put a helper agent on.
 * Saving rewrites only the managed `workers:` block; hand-written routes, rules
 * and comments in routing.yaml survive untouched. With no block, today's
 * behaviour stands and a lead may choose any route.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { WorkerAllowlistConfigView } from '../../../main/maker-ipc/workerAllowlist';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('WorkerAllowlistSection');

export function WorkerAllowlistSection() {
  const [view, setView] = useState<WorkerAllowlistConfigView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [allowChoice, setAllowChoice] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.maker.workers.getConfig();
      setView(next);
      setEnabled(next.present);
      setAllowChoice(next.allowModelChoice);
      setSelected(next.allowedRoutes);
    } catch (err) {
      log.warn('workers getConfig failed', err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.electronAPI.maker.workers.setConfig({
        enabled,
        allowModelChoice: allowChoice,
        allowedRoutes: selected,
      });
      setView(next);
      setEnabled(next.present);
      setAllowChoice(next.allowModelChoice);
      setSelected(next.allowedRoutes);
    } catch (err) {
      log.warn('workers setConfig failed', err);
      toast.error('Could not save the helper agent allowlist.');
    } finally {
      setBusy(false);
    }
  }, [enabled, allowChoice, selected]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, WorkerAllowlistConfigView['routes']>();
    for (const route of view?.routes ?? []) {
      const list = byProvider.get(route.provider) ?? [];
      list.push(route);
      byProvider.set(route.provider, list);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [view]);

  const toggleRoute = (name: string) => {
    setSelected((current) =>
      current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name],
    );
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          Helper agents
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          Limit the routes a lead may put a helper agent on. Expert routes and the Hermes default
          always work. Saving changes only the managed block in ~/.cindy-harness/routing.yaml.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-4">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || view === null}
            onChange={(e) => { setEnabled(e.target.checked); }}
            aria-label="Restrict helper agent models"
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-13 text-[var(--text-primary)]">Restrict helper agent models</span>
            <span className="text-11 leading-[1.4] text-[var(--text-tertiary)]">
              {enabled
                ? 'On. Leads may only use the routes checked below. Omitting model stays allowed.'
                : 'Off. No managed block, so today\'s behaviour stands and a lead may choose any route.'}
            </span>
          </span>
        </label>

        {enabled ? (
          <>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={allowChoice}
                disabled={busy}
                onChange={(e) => { setAllowChoice(e.target.checked); }}
                aria-label="Allow leads to choose a model"
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-13 text-[var(--text-primary)]">Allow leads to choose a model</span>
                <span className="text-11 leading-[1.4] text-[var(--text-tertiary)]">
                  {allowChoice
                    ? 'A lead may pass model only when it is in the list below.'
                    : 'A lead can never pass model. Omit model to use the expert\'s route or the Hermes default.'}
                </span>
              </span>
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-12 font-medium text-[var(--text-secondary)]">Approved routes</span>
              {groups.length === 0 ? (
                <p className="text-11 leading-[1.4] text-[var(--text-tertiary)]">
                  No routes found in ~/.cindy-harness/routing.yaml.
                </p>
              ) : (
                groups.map(([provider, routes]) => (
                  <div key={provider} className="flex flex-col gap-1">
                    <span className="text-11 text-[var(--text-tertiary)]">{provider}</span>
                    {routes.map((route) => (
                      <label key={route.name} className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={selected.includes(route.name)}
                          disabled={busy}
                          onChange={() => { toggleRoute(route.name); }}
                          aria-label={`Allow route ${route.name}`}
                        />
                        <span className="text-13 text-[var(--text-primary)]">{route.name}</span>
                        <span className="text-11 text-[var(--text-tertiary)]">{route.model}</span>
                        <span className="ml-auto text-11 text-[var(--text-tertiary)]">
                          {route.local ? 'Local' : 'API'}
                        </span>
                      </label>
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}

        {view && view.issues.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {view.issues.map((issue) => (
              <p key={issue} className="text-11 leading-[1.4] text-[var(--text-warning,#a60)]">{issue}</p>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={busy || view === null}
            aria-label="Save helper agent allowlist"
            className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-12 font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            Save
          </button>
          <span className="text-11 leading-[1.4] text-[var(--text-tertiary)]">
            Saving rewrites only the managed block. Routes are grouped by provider; API routes bill.
          </span>
        </div>
      </div>
    </div>
  );
}
