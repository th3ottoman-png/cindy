/**
 * Settings -> Personalization -> Recap (ROADMAP 13.3).
 *
 * On by default but inert until `recap` is routed in routing.yaml. The hint says so, and says
 * that an API route bills per call — background spend is never hidden (AGENTS.md §6.4).
 */

import { useCallback, useEffect, useState } from 'react';

import type { RecapConfigView } from '../../../main/maker-ipc/recap';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('RecapSection');

const MIN_AWAY_MINUTES = 1;

export function RecapSection() {
  const [view, setView] = useState<RecapConfigView | null>(null);
  const [away, setAway] = useState('15');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.maker.recap.getConfig();
      setView(next);
      setAway(String(next.awayMinutes));
    } catch (err) {
      log.warn('recap getConfig failed', err);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: { enabled?: boolean; awayMinutes?: number }) => {
    setBusy(true);
    try {
      const next = await window.electronAPI.maker.recap.setConfig(patch);
      setView(next);
      setAway(String(next.awayMinutes));
    } catch (err) {
      log.warn('recap setConfig failed', err);
      toast.error('Could not save the recap setting.');
    } finally {
      setBusy(false);
    }
  }, []);

  const saveAway = useCallback(() => {
    const parsed = Number(away);
    if (!Number.isFinite(parsed) || parsed < MIN_AWAY_MINUTES) {
      toast.error(`Away minutes must be at least ${MIN_AWAY_MINUTES}.`);
      return;
    }
    void save({ awayMinutes: Math.floor(parsed) });
  }, [away, save]);

  if (!view) {
    return (
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">Recap</h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">Unavailable.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">Recap</h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          A one or two sentence reminder of where a conversation left off, shown above the composer
          when you return to it. It never enters the transcript and is never sent to the agent.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-4">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={view.enabled}
            disabled={busy}
            onChange={(e) => { void save({ enabled: e.target.checked }); }}
            aria-label="Show a recap when I return to a conversation"
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-13 text-[var(--text-primary)]">Show a recap when I return to a conversation</span>
            <span className="text-11 leading-[1.4] text-[var(--text-tertiary)]">
              {view.routed
                ? `Runs on ${view.routeName}/${view.model}. One call per return, at most one per away period. API routes bill per call.`
                : 'Off until routed. Add a `recap` rule to ~/.cindy-harness/routing.yaml; it runs on the route you pick, and API routes bill per call.'}
            </span>
          </span>
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={MIN_AWAY_MINUTES}
            step={1}
            value={away}
            onChange={(e) => { setAway(e.target.value); }}
            aria-label="Away minutes before a recap"
            className="w-[90px] rounded-md border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-1.5 text-13 tabular-nums text-[var(--text-primary)]"
          />
          <span className="text-12 text-[var(--text-secondary)]">minutes away before a recap is offered</span>
          <button
            type="button"
            onClick={saveAway}
            disabled={busy}
            className="ml-auto shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-12 font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            Save
          </button>
        </div>
        {view.issue ? (
          <p className="text-11 leading-[1.4] text-[var(--text-warning,#a60)]">{view.issue}</p>
        ) : null}
      </div>
    </div>
  );
}