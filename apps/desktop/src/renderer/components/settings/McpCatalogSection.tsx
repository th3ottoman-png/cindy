import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plug, RefreshCw } from 'lucide-react';

import type { ExpertEntry } from '@cindy/maker-core/experts';
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
  /** Hermes experts available to add servers to. */
  expertOptions?: readonly { slug: string; name: string }[];
  /** Entry id whose "add to expert" is in flight. */
  addingToExpert?: string | null;
  onAddToExpert?: (id: string, slug: string) => void;
}

export function McpCatalogListView({
  entries,
  pending,
  checking,
  onToggle,
  onCheck,
  expertOptions,
  addingToExpert,
  onAddToExpert,
}: McpCatalogListViewProps) {
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
                  {onAddToExpert ? (
                    <select
                      aria-label={`Add ${entry.name} to expert`}
                      className="h-7 max-w-[9rem] truncate rounded-md border border-[var(--border-subtle)] bg-transparent px-1.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                      value=""
                      disabled={addingToExpert === entry.id || !expertOptions || expertOptions.length === 0}
                      onChange={(e) => {
                        const slug = e.target.value;
                        if (slug) onAddToExpert(entry.id, slug);
                      }}
                      data-testid={`mcp-catalog-add-expert-${suffix}`}
                    >
                      <option value="" disabled>
                        {!expertOptions || expertOptions.length === 0 ? 'No experts' : 'Add to expert…'}
                      </option>
                      {expertOptions?.map((opt) => (
                        <option key={opt.slug} value={opt.slug}>
                          {opt.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
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

export const MCP_CATALOG_COLLAPSE_STORAGE_KEY = 'cindy:settings:mcp-catalog-collapsed';

export interface McpCatalogSectionProps {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function McpCatalogSection({
  collapsed: controlledCollapsed,
  onToggleCollapsed,
}: McpCatalogSectionProps = {}) {
  const api = window.electronAPI?.maker?.mcpCatalog;
  const expertsApi = window.electronAPI?.maker?.experts;
  const [internalCollapsed, setInternalCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(MCP_CATALOG_COLLAPSE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const isCollapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;

  const handleToggleCollapse = () => {
    if (onToggleCollapsed) {
      onToggleCollapsed();
    } else {
      setInternalCollapsed((prev) => {
        const next = !prev;
        try {
          window.localStorage.setItem(MCP_CATALOG_COLLAPSE_STORAGE_KEY, String(next));
        } catch {
          // ignore
        }
        return next;
      });
    }
  };

  const [view, setView] = useState<McpCatalogView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [addingToExpert, setAddingToExpert] = useState<string | null>(null);
  const [expertEntries, setExpertEntries] = useState<readonly ExpertEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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

  useEffect(() => {
    if (!expertsApi) return undefined;
    let alive = true;
    void expertsApi.list().then((list) => {
      if (alive) setExpertEntries(list);
    }).catch(() => undefined);
    const off = expertsApi.onChanged((list) => {
      if (alive) setExpertEntries(list);
    });
    return () => {
      alive = false;
      off();
    };
  }, [expertsApi]);

  if (!api) return null;

  const expertOptions = expertEntries
    .filter((e) => e.expert && e.expert.agent === 'hermes')
    .map((e) => ({ slug: e.slug, name: e.expert!.name }));

  const handleToggle = async (id: string, enabled: boolean) => {
    setPending(id);
    setError(null);
    setStatus(null);
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
    setStatus(null);
    try {
      await api.checkHealth(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(null);
    }
  };

  const handleAddToExpert = async (id: string, slug: string) => {
    setAddingToExpert(id);
    setError(null);
    setStatus(null);
    try {
      const res = await api.addToExpert(id, slug);
      const expertName = expertOptions.find((o) => o.slug === slug)?.name ?? slug;
      setStatus(`Added ${res.serverName} to ${expertName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingToExpert(null);
    }
  };

  const entryCount = view?.entries.length ?? 0;

  return (
    <div className="flex flex-col gap-3" data-testid="settings-mcp-catalog">
      <div className="flex items-center justify-between">
        <h2 className={SETTINGS_SECTION_TITLE_CLASS}>
          <button
            type="button"
            onClick={handleToggleCollapse}
            className="flex items-center gap-2 group text-left text-inherit font-inherit hover:opacity-85 transition-opacity"
            aria-expanded={!isCollapsed}
            data-testid="mcp-catalog-collapse-toggle"
          >
            <Plug size={16} aria-hidden="true" />
            <span>MCP Servers</span>
            {entryCount > 0 ? (
              <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 text-11 font-normal text-[var(--text-tertiary)]">
                {entryCount}
              </span>
            ) : null}
            <span className="text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)] transition-colors">
              {isCollapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
            </span>
          </button>
        </h2>
      </div>
      {!isCollapsed ? (
        <>
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
            expertOptions={expertOptions}
            addingToExpert={addingToExpert}
            onToggle={(id, enabled) => void handleToggle(id, enabled)}
            onCheck={(id) => void handleCheck(id)}
            onAddToExpert={(id, slug) => void handleAddToExpert(id, slug)}
          />
        </>
      ) : null}
      {status ? (
        <div role="status" className="rounded-lg border border-emerald-500/40 px-3 py-2 text-12 text-emerald-500">
          {status}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="rounded-lg border border-red-500/40 px-3 py-2 text-12 text-red-500">
          {error}
        </div>
      ) : null}
    </div>
  );
}
