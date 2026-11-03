/**
 * Local extension plugins (ROADMAP 4.2b). Loads `~/.cindy-harness/plugins` at app startup
 * through `@cindy/maker-core/plugins` into the shared 4.1a extension registry, lists the
 * result over IPC for the Settings toggle, and persists the toggle in
 * `~/.cindy-harness/plugins.json` (`@cindy/maker-core/plugin-state`: atomic, hand-editable;
 * AGENTS §6.1).
 *
 * A toggle applies immediately: disabling unregisters that plugin's extensions (the
 * unregister handles the registry returns are captured per plugin through a tracking
 * wrapper), enabling loads just that plugin through the 4.2a loader. Failure stays inside
 * the plugin (4.2a): a broken one is a report row, never an app error, and the others load.
 */

import { getExtensionRegistry, type ExtensionRegistry } from '@cindy/maker-core/extensions';
import {
  emptyPluginState,
  readPluginState,
  setPluginEnabled,
  writePluginState,
  type PluginState,
} from '@cindy/maker-core/plugin-state';
import {
  isValidPluginName,
  loadPlugins,
  type PluginReport,
  type PluginStatus,
} from '@cindy/maker-core/plugins';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ExtensionPluginItem {
  name: string;
  /** From plugins.json — what the owner asked for, independent of the load outcome. */
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  /** Extensions the plugin registered (0 unless active). */
  registered: number;
  version?: string;
  description?: string;
}

export interface ExtensionPluginListView {
  plugins: ExtensionPluginItem[];
  /** Set when plugins.json exists but could not be parsed; every plugin is then enabled. */
  stateIssue?: string;
}

export interface ExtensionPluginsHostDeps {
  /** Plugins root (production: ~/.cindy-harness/plugins). */
  rootDir: string;
  /** Toggle state file (production: ~/.cindy-harness/plugins.json). */
  stateFile: string;
  /** The 4.1a registry the plugins register into (production: the shared one). */
  registry: ExtensionRegistry;
  /** Injected so tests need no native import(); production default is the real loader. */
  load?: typeof loadPlugins;
}

export interface ExtensionPluginsHost {
  /** Initial load at app startup. Idempotent; `list`/`setEnabled` await it. */
  start(): Promise<void>;
  list(): Promise<ExtensionPluginListView>;
  /** Validates its input; throws on an invalid name or a non-boolean enabled. */
  setEnabled(name: unknown, enabled: unknown): Promise<ExtensionPluginListView>;
}

export function createExtensionPluginsHost(deps: ExtensionPluginsHostDeps): ExtensionPluginsHost {
  const load = deps.load ?? loadPlugins;
  const undoByName = new Map<string, Array<() => void>>();
  const reports = new Map<string, PluginReport>();
  let state: PluginState = emptyPluginState();
  let stateIssue: string | undefined;
  let started: Promise<void> | undefined;

  // Captures, per plugin, the unregister functions the registry returns, keyed off the
  // `plugin:<name>` source tag the 4.2a loader adds to everything a plugin registers.
  const trackingRegistry: ExtensionRegistry = {
    ...deps.registry,
    register: (descriptor) => {
      const off = deps.registry.register(descriptor);
      const match = /^plugin:(.+)$/.exec(descriptor.source ?? '');
      if (match) {
        const list = undoByName.get(match[1]);
        if (list) list.push(off);
        else undoByName.set(match[1], [off]);
      }
      return off;
    },
  };

  async function runLoad(only?: string): Promise<void> {
    // The file is the source of truth: re-read it on every (re)load so a hand edit
    // between toggles is honoured.
    const read = readPluginState(deps.stateFile);
    state = read.state;
    stateIssue = read.issue;
    const rows = await load({
      root: deps.rootDir,
      registry: trackingRegistry,
      isEnabled: (name) => (only === undefined || name === only) && !state.disabled.includes(name),
    });
    for (const row of rows) {
      // A single-plugin reload must not overwrite the other plugins' rows with the
      // 'disabled' placeholders the loader returns for skipped names.
      if (only === undefined || row.name === only) reports.set(row.name, row);
    }
  }

  function view(): ExtensionPluginListView {
    const plugins = [...reports.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((row): ExtensionPluginItem => {
        const enabled = !state.disabled.includes(row.name);
        return {
          name: row.name,
          enabled,
          status: !enabled && row.status === 'active' ? 'disabled' : row.status,
          ...(row.error ? { error: row.error } : {}),
          registered: row.registered,
          ...(row.version ? { version: row.version } : {}),
          ...(row.description ? { description: row.description } : {}),
        };
      });
    return stateIssue ? { plugins, stateIssue } : { plugins };
  }

  function ensureStarted(): Promise<void> {
    started ??= runLoad();
    return started;
  }

  return {
    start: ensureStarted,
    async list() {
      await ensureStarted();
      return view();
    },
    async setEnabled(name: unknown, enabled: unknown) {
      if (typeof name !== 'string' || !isValidPluginName(name)) {
        throw new Error('name must be a valid plugin name');
      }
      if (typeof enabled !== 'boolean') {
        throw new Error('enabled (boolean) required');
      }
      await ensureStarted();
      // Re-read so a hand edit since the last load is honoured, not overwritten.
      const fresh = readPluginState(deps.stateFile);
      state = fresh.state;
      stateIssue = fresh.issue;
      writePluginState(deps.stateFile, setPluginEnabled(state, name, enabled));
      state = setPluginEnabled(state, name, enabled);
      stateIssue = undefined;
      if (!enabled) {
        const offs = undoByName.get(name) ?? [];
        undoByName.delete(name);
        for (const off of offs.splice(0)) {
          try {
            off();
          } catch {
            // one bad unregister must not strand the rest
          }
        }
        const row = reports.get(name);
        if (row && row.status === 'active') {
          reports.set(name, { ...row, status: 'disabled', registered: 0 });
        }
      } else {
        // (Re)load just this plugin; a previous failure row is replaced by the fresh one.
        await runLoad(name);
      }
      return view();
    },
  };
}

export interface ExtensionPluginsHandlerDeps {
  host: ExtensionPluginsHost;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production: send to every BrowserWindow. */
  broadcast(channel: string, payload: unknown): void;
}

/** maker:ext-plugins:* IPC: the Settings toggle lists the plugins and flips one. */
export function registerExtensionPluginsHandlers(
  registry: IpcHandlerRegistry,
  deps: ExtensionPluginsHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.EXT_PLUGINS_LIST, async (event) => {
    deps.assertTrusted(event);
    return deps.host.list();
  });
  registry.handle(MAKER_INVOKE.EXT_PLUGINS_SET_ENABLED, async (event, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const fresh = await deps.host.setEnabled(r.name, r.enabled);
    deps.broadcast(MAKER_PUSH.EXT_PLUGINS_CHANGED, fresh);
    return fresh;
  });
}

/** Production singleton wiring (register.ts): shared registry, real loader, real paths. */
export function createDesktopExtensionPluginsHost(deps: {
  rootDir: string;
  stateFile: string;
}): ExtensionPluginsHost {
  return createExtensionPluginsHost({ ...deps, registry: getExtensionRegistry() });
}
