import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';

import type { McpHealthStatus } from '@cindy/maker-core/mcp-catalog';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import type { McpCatalogView, McpCatalogViewEntry } from '../../../main/maker-ipc/mcpCatalog';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

/**
 * Unified MCP server catalog (ROADMAP 4.3b). One list over every MCP server Cindy can hand
 * an agent: Hermes `config.yaml` servers (toggle = the `disabled` flag, written through the
 * daemon-side helpers) and the lizi builtin in-process providers (toggle = the plugin
 * registry user default, which the per-session provider gate reads — it applies to NEW
 * sessions). Health is static on load (stdio command resolvable, http unchecked); the
 * per-row Check button is the only thing that touches the network.
 */

const SOURCE_LABEL: Record<string, string> = {
  hermes: 'Hermes',
  lizi: 'Built-in',
};

const HEALTH_LABEL: Record<McpHealthStatus, string> = {
  ok: 'OK',
  disabled: 'Disabled',
  invalid: 'Invalid',
  'missing-command': 'Missing command',
  unreachable: 'Unreachable',
  unchecked: 'Unchecked',
};

function healthClass(status: McpHealthStatus): string {
  switch (status) {
    case 'ok':
      return 'text-emerald-500';
    case 'invalid':
    case 'missing-command':
    case 'unreachable':
      return 'text-red-500';
    default:
      return 'text-[var(--text-tertiary)]';
  }
}

/** `<source>/<name>` → testid-safe suffix. */
export function mcpCatalogTestIdSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-');
}

export interface McpCatalogListViewProps {
  entries: readonly McpCatalogViewEntry[];
  /** Entry id whose toggle is in flight (its switch is disabled). */
  pending: string | null;
  /** Entry id whose health probe is in flight. */
  checking: string | null;
  onToggle: (id: string, enabled: boolean) => void;
  onCheck: (id: string) => void;
}

export function McpCatalogListView({ entries, pending, checking, onToggle, onCheck }: McpCatalogListViewProps) {
  return (
    <div className={SETTINGS_CARD_CLASS}>
      {entries.length === 0 ? (
        <div className="px-4 py-3 text-12 text-[var(--text-tertiary)]">No MCP servers configured.</div>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => {
            const suffix = mcpCatalogTestIdSuffix(entry.id);
            return (
              <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-13 font-medium text-[var(--text-primary)]">
                    {entry.name}
                    <span className="ml-2 rounded border border-[var(--border-subtle)] px-1 py-px text-10 text-[var(--text-tertiary)]">
                      {SOURCE_LABEL[entry.source] ?? entry.source}
                    </span>
                    <span className="ml-1 rounded border border-[var(--border-subtle)] px-1 py-px font-mono text-10 text-[var(--text-tertiary)]">
                      {entry.transport}
                    </span>
                    <span
                      className={cn('ml-2 text-11', healthClass(entry.health))}
                      data-testid={`mcp-catalog-health-${suffix}`}
                    >
                      {HEALTH_LABEL[entry.health]}
                    </span>
                  </span>
                  {entry.target ? (
                    <span className="break-all font-mono text-11 text-[var(--text-tertiary)]">{entry.target}</span>
                  ) : null}
                  {entry.healthDetail && entry.health !== 'ok' ? (
                    <span className="text-11 text-red-500">{entry.healthDetail}</span>
                  ) : null}
                  <span className={SETTINGS_ROW_HINT_CLASS}>
                    {entry.description ??
                      (entry.envKeys.length > 0 || entry.headerKeys.length > 0
                        ? `env: ${entry.envKeys.join(', ') || '—'} · headers: ${entry.headerKeys.join(', ') || '—'}`
                        : entry.problem ?? '')}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {entry.transport === 'http' && entry.enabled ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-11 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                      disabled={checking === entry.id}
                      onClick={() => onCheck(entry.id)}
                      data-testid={`mcp-catalog-check-${suffix}`}
                    >
                      <RefreshCw size={11} aria-hidden="true" className={checking === entry.id ? 'animate-spin' : undefined} />
                      {checking === entry.id ? 'Checking…' : 'Check'}
                    </button>
                  ) : null}
                  <Switch
                    checked={entry.enabled}
                    disabled={pending === entry.id}
                    onCheckedChange={(enabled) => onToggle(entry.id, enabled)}
                    aria-label={`Enable MCP server ${entry.id}`}
                    data-testid={`mcp-catalog-toggle-${suffix}`}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function McpCatalogSection() {
  const api = window.electronAPI?.maker?.mcpCatalog;
  const [view, setView] = useState<McpCatalogView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setView(await api.list());
    } catch {
      // A list failure keeps the last good view; toggles still surface their own error.
    }
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    void refresh();
    const off = api.onChanged(() => void refresh());
    return off;
  }, [api, refresh]);

  if (!api) return null;

  const handleToggle = async (id: string, enabled: boolean) => {
    setPending(id);
    setError(null);
    try {
      setView(await api.setEnabled(id, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const handleCheck = async (id: string) => {
    setChecking(id);
    setError(null);
    try {
      await api.checkHealth(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(null);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="settings-mcp-catalog">
      <h2 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
        <Plug size={16} aria-hidden="true" /> MCP Servers
      </h2>
      <p className={SETTINGS_ROW_HINT_CLASS}>
        Every MCP server Cindy can hand an agent. <strong>Hermes</strong> servers live in the Hermes home{' '}
        <code className="font-mono">config.yaml</code>; the toggle writes their{' '}
        <code className="font-mono">disabled</code> flag. <strong>Built-in</strong> servers run inside Cindy; their
        toggle applies to new sessions. Stdio health only checks that the command exists — press Check on a
        server URL to probe it.
      </p>
      <McpCatalogListView
        entries={view?.entries ?? []}
        pending={pending}
        checking={checking}
        onToggle={(id, enabled) => void handleToggle(id, enabled)}
        onCheck={(id) => void handleCheck(id)}
      />
      {error ? (
        <div role="alert" className="rounded-lg border border-red-500/40 px-3 py-2 text-12 text-red-500">
          {error}
        </div>
      ) : null}
    </div>
  );
}
