import { useEffect, useState } from 'react';
import { AlertTriangle, Puzzle } from 'lucide-react';

import type { PluginStatus } from '@cindy/maker-core/plugins';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

/**
 * Settings plugin toggle (ROADMAP 4.2b). Lists ~/.cindy-harness/plugins with the load state
 * main reported (active / disabled / invalid / failed with its error) and flips one through
 * the ext-plugins IPC; the toggle persists in ~/.cindy-harness/plugins.json and applies at
 * once. The files win: hand edits to plugins.json or a plugin folder apply on next start.
 */

export interface PluginRow {
  name: string;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  registered: number;
  version?: string;
  description?: string;
}

export interface PluginsView {
  plugins: PluginRow[];
  stateIssue?: string;
}

const STATUS_LABEL: Record<PluginStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  invalid: 'Invalid',
  failed: 'Failed',
};

export function PluginListView({
  plugins,
  stateIssue,
  pending,
  onToggle,
}: {
  plugins: readonly PluginRow[];
  stateIssue?: string;
  /** Name of the plugin whose toggle is in flight (its switch is disabled). */
  pending: string | null;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {stateIssue ? (
        <div
          role="alert"
          className="flex items-center gap-1.5 rounded-lg border border-amber-500/50 px-3 py-2 text-12"
          data-testid="plugin-state-issue"
        >
          <AlertTriangle size={12} aria-hidden="true" />
          <span>
            plugins.json could not be read as written, so every plugin is enabled: {stateIssue}
          </span>
        </div>
      ) : null}
      <div className={SETTINGS_CARD_CLASS}>
        {plugins.length === 0 ? (
          <div className="px-4 py-3 text-12 text-[var(--text-tertiary)]">
            No plugins yet. A plugin is a folder{' '}
            <code className="font-mono">~/.cindy-harness/plugins/&lt;name&gt;/</code> with a{' '}
            <code className="font-mono">manifest.yaml</code> — copy{' '}
            <code className="font-mono">docs/examples/extending/plugins/hello/</code> to try one.
          </div>
        ) : (
          <ul className="flex flex-col">
            {plugins.map((plugin) => {
              const broken = plugin.status === 'invalid' || plugin.status === 'failed';
              return (
                <li key={plugin.name} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-13 font-medium text-[var(--text-primary)]">
                      {plugin.name}
                      {plugin.version ? (
                        <span className="ml-2 font-mono text-11 text-[var(--text-tertiary)]">
                          v{plugin.version}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          'ml-2 text-11',
                          broken ? 'text-red-500' : 'text-[var(--text-tertiary)]',
                        )}
                        data-testid={`plugin-status-${plugin.name}`}
                      >
                        {STATUS_LABEL[plugin.status]}
                        {plugin.status === 'active' && plugin.registered > 0
                          ? ` · ${plugin.registered} extension${plugin.registered === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    </span>
                    {broken ? (
                      <span className="flex items-center gap-1 text-12 text-red-500">
                        <AlertTriangle size={12} aria-hidden="true" />
                        {plugin.error ?? 'cannot load'}
                      </span>
                    ) : (
                      <span className={SETTINGS_ROW_HINT_CLASS}>
                        {plugin.description || 'No description'}
                      </span>
                    )}
                  </div>
                  <Switch
                    checked={plugin.enabled}
                    disabled={pending === plugin.name}
                    onCheckedChange={(enabled) => onToggle(plugin.name, enabled)}
                    aria-label={`Enable plugin ${plugin.name}`}
                    data-testid={`plugin-toggle-${plugin.name}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function PluginsSection() {
  const api = window.electronAPI?.maker?.extPlugins;
  const [view, setView] = useState<PluginsView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return undefined;
    let alive = true;
    void api
      .list()
      .then((fresh) => {
        if (alive) setView(fresh);
      })
      .catch(() => undefined);
    const off = api.onChanged((fresh) => setView(fresh));
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  if (!api) return null;

  const handleToggle = async (name: string, enabled: boolean) => {
    setPending(name);
    setError(null);
    try {
      setView(await api.setEnabled(name, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="settings-plugins">
      <h2 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
        <Puzzle size={16} aria-hidden="true" /> Plugins
      </h2>
      <p className={SETTINGS_ROW_HINT_CLASS}>
        Folders in <code className="font-mono">~/.cindy-harness/plugins/&lt;name&gt;/</code> with a{' '}
        <code className="font-mono">manifest.yaml</code>, loaded at startup. The toggle is kept in{' '}
        <code className="font-mono">~/.cindy-harness/plugins.json</code> and applies at once; hand
        edits to the files apply on next start. A broken plugin never stops the others.
      </p>
      <PluginListView
        plugins={view?.plugins ?? []}
        stateIssue={view?.stateIssue}
        pending={pending}
        onToggle={(name, enabled) => void handleToggle(name, enabled)}
      />
      {error ? (
        <div role="alert" className="rounded-lg border border-red-500/40 px-3 py-2 text-12 text-red-500">
          {error}
        </div>
      ) : null}
    </div>
  );
}
