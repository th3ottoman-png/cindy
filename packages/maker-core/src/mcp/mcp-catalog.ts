/**
 * MCP server catalog (ROADMAP 4.3a).
 *
 * Merges MCP server configs from several sources (Hermes `config.yaml`, any other registry) into
 * one flat, display-safe list, and checks whether each entry can plausibly start. Display-safe
 * means env and header VALUES never leave this module: entries carry key names only. Health is
 * a static check (command resolvable, URL well-formed) plus an optional injected `probe` for
 * http servers; this module makes no network call and starts no process itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Structurally the same as the Hermes manager's `HermesMcpServerConfig`; kept local to avoid a package edge. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: string;
  disabled?: boolean;
}

export interface McpCatalogSource {
  /** Stable label, e.g. `hermes`. */
  source: string;
  servers: Record<string, McpServerConfig>;
}

export type McpTransport = 'stdio' | 'http' | 'invalid';

export interface McpCatalogEntry {
  /** `<source>/<name>`, unique across the catalog. */
  id: string;
  source: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** `command arg arg` for stdio, the URL with credentials and query stripped for http. */
  target: string;
  envKeys: string[];
  headerKeys: string[];
  hasAuth: boolean;
  /** Why the entry is `invalid`. */
  problem?: string;
}

function safeUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

function describe(name: string, cfg: McpServerConfig): Pick<McpCatalogEntry, 'transport' | 'target' | 'problem'> {
  const command = cfg.command?.trim();
  const url = cfg.url?.trim();
  if (command && url) return { transport: 'invalid', target: '', problem: 'has both "command" and "url"' };
  if (command) return { transport: 'stdio', target: [command, ...(cfg.args ?? [])].join(' ') };
  if (url) {
    const u = safeUrl(url);
    if (!u) return { transport: 'invalid', target: '', problem: `"url" for ${name} is not a valid http(s) URL` };
    return { transport: 'http', target: `${u.protocol}//${u.host}${u.pathname}` };
  }
  return { transport: 'invalid', target: '', problem: 'needs "command" or "url"' };
}

/** Flatten sources into entries, sorted by source then name. Never throws on a bad entry. */
export function buildMcpCatalog(sources: McpCatalogSource[]): McpCatalogEntry[] {
  const out: McpCatalogEntry[] = [];
  for (const { source, servers } of sources) {
    for (const [name, cfg] of Object.entries(servers)) {
      out.push({
        id: `${source}/${name}`,
        source,
        name,
        enabled: cfg.disabled !== true,
        ...describe(name, cfg),
        envKeys: Object.keys(cfg.env ?? {}).sort(),
        headerKeys: Object.keys(cfg.headers ?? {}).sort(),
        hasAuth: Boolean(cfg.auth),
      });
    }
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

export type McpHealthStatus = 'ok' | 'disabled' | 'invalid' | 'missing-command' | 'unreachable' | 'unchecked';

export interface McpHealth {
  id: string;
  status: McpHealthStatus;
  detail?: string;
}

export interface McpHealthOptions {
  /** PATH to search for bare command names; defaults to `process.env.PATH`. */
  searchPath?: string;
  /** Optional liveness probe for http servers (the caller decides whether to touch the network). */
  probe?: (url: string) => Promise<boolean>;
  /** The original configs, needed to read `command`/`url`; keyed by entry id. */
  configs: Record<string, McpServerConfig>;
}

function resolvesToExecutable(command: string, searchPath: string): boolean {
  const isExec = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (path.isAbsolute(command) || command.includes('/')) return isExec(command);
  return searchPath.split(path.delimiter).some((dir) => dir !== '' && isExec(path.join(dir, command)));
}

/** Check one entry. A thrown or rejected probe becomes `unreachable`, never an exception. */
export async function checkMcpHealth(entry: McpCatalogEntry, opts: McpHealthOptions): Promise<McpHealth> {
  const done = (status: McpHealthStatus, detail?: string): McpHealth => ({ id: entry.id, status, ...(detail ? { detail } : {}) });
  if (!entry.enabled) return done('disabled');
  if (entry.transport === 'invalid') return done('invalid', entry.problem);
  const cfg = opts.configs[entry.id];
  if (!cfg) return done('invalid', 'no config supplied for this entry');

  if (entry.transport === 'stdio') {
    const command = (cfg.command ?? '').trim();
    return resolvesToExecutable(command, opts.searchPath ?? process.env.PATH ?? '')
      ? done('ok')
      : done('missing-command', `"${command}" is not an executable file or on PATH`);
  }
  if (!opts.probe) return done('unchecked', 'http server; no probe supplied');
  try {
    return (await opts.probe((cfg.url ?? '').trim())) ? done('ok') : done('unreachable', 'probe reported not reachable');
  } catch (err) {
    return done('unreachable', (err as Error).message);
  }
}
