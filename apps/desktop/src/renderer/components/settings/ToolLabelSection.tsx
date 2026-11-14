/**
 * Settings -> Personalization -> Tool-batch labels (ROADMAP 13.4).
 *
 * Read-only status: the feature is on exactly when `tool-label` is routed in routing.yaml.
 * The hint names the route/model and says that API routes bill — background spend is never
 * hidden (AGENTS.md §6.4).
 */

import { useEffect, useState } from 'react';

import type { ToolLabelConfigView } from '../../../main/maker-ipc/toolLabels';
import { createLogger } from '@/lib/logger';

const log = createLogger('ToolLabelSection');

export function ToolLabelSection() {
  const [view, setView] = useState<ToolLabelConfigView | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.maker.toolLabel
      .getConfig()
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((err) => log.warn('tool-label getConfig failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          Tool-batch labels
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          Name each finished group of tool calls (for example “Updated auth tests · 7 tools”) so
          scrolling back shows what each group did. Labels are cached, so reopening a session never
          calls the model again.
        </p>
      </div>
      <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-4">
        <p className="text-13 text-[var(--text-primary)]">
          {view === null
            ? 'Unavailable.'
            : view.routed
              ? `On — runs on ${view.routeName}/${view.model}.`
              : 'Off.'}
        </p>
        <p className="mt-0.5 text-11 leading-[1.4] text-[var(--text-tertiary)]">
          {view?.routed
            ? 'One small call per finished tool group. Bills on API routes. Remove the `tool-label` rule from ~/.cindy-harness/routing.yaml to turn it off.'
            : 'Off until routed. Add a `tool-label` rule to ~/.cindy-harness/routing.yaml. One small call per finished tool group; bills on API routes.'}
        </p>
      </div>
    </div>
  );
}
