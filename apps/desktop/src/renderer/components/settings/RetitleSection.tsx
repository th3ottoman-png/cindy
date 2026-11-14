/**
 * Settings -> Personalization -> Conversation titles (ROADMAP 13.9).
 *
 * On by default but inert until `title` is routed in routing.yaml. The hint says so, and
 * says that an API route bills per call — background spend is never hidden (AGENTS.md §6.4).
 */

import { useCallback, useEffect, useState } from 'react';

import type { RetitleConfigView } from '../../../main/maker-ipc/retitle';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('RetitleSection');

export function RetitleSection() {
  const [view, setView] = useState<RetitleConfigView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await window.electronAPI.maker.retitle.getConfig());
    } catch (err) {
      log.warn('retitle getConfig failed', err);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: { enabled?: boolean }) => {
    setBusy(true);
    try {
      setView(await window.electronAPI.maker.retitle.setConfig(patch));
    } catch (err) {
      log.warn('retitle setConfig failed', err);
      toast.error('Could not save the title setting.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!view) {
    return (
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">Conversation titles</h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">Unavailable.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">Conversation titles</h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          Let a title follow the conversation when its topic changes. A name you type yourself is
          permanent, and the last three automatic titles are kept for one-click undo.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-4">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={view.enabled}
            disabled={busy}
            onChange={(e) => { void save({ enabled: e.target.checked }); }}
            aria-label="Let titles follow the conversation"
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-13 text-[var(--text-primary)]">Let titles follow the conversation</span>
            <span className="text-11 leading-[1.4] text-[var(--text-tertiary)]">
              {view.routed
                ? `Runs on ${view.routeName}/${view.model}. At most one call per six user turns, only after a turn ends. API routes bill per call.`
                : 'Off until routed. Add a `title` rule to ~/.cindy-harness/routing.yaml; it runs on the route you pick, and API routes bill per call.'}
            </span>
          </span>
        </label>
        {view.issue ? (
          <p className="text-11 leading-[1.4] text-[var(--text-warning,#a60)]">{view.issue}</p>
        ) : null}
      </div>
    </div>
  );
}
