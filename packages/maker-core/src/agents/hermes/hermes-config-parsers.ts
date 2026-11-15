/**
 * Pure read-only parsers for `$HERMES_HOME/config.yaml` blocks.
 *
 * Shared between `@cindy/maker-hermes-manager` and `@cindy/maker-core/doctor`.
 * Kept zero-I/O and zero-dependency so both daemon and doctor call the exact
 * same line readers without re-implementing schemas.
 */

export interface HermesDefaultRoute {
  model?: string;
  provider?: string;
  baseUrl?: string;
}

export interface HermesFallbackModel {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** NAME of the environment variable holding the key (custom endpoints). */
  keyEnv?: string;
}

export interface HermesMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: string;
  disabled?: boolean;
}

export interface HermesLocalContextWindowEntry {
  name: string;
  baseUrl: string;
  contextLength: number;
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse only the top-level `model:` block of a Hermes config.yaml body. */
export function parseHermesDefaultRoute(configYaml: string): HermesDefaultRoute {
  const lines = configYaml.split(/\r?\n/);
  const route: HermesDefaultRoute = {};
  let inModelBlock = false;
  let blockIndent: number | null = null;

  for (const rawLine of lines) {
    if (inModelBlock) {
      if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
      const indent = rawLine.length - rawLine.trimStart().length;
      if (blockIndent === null) blockIndent = indent;
      if (indent < blockIndent) break;
      const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine.trim());
      if (!match) continue;
      const [, key, value] = match;
      const parsed = unquote(value!);
      if (!parsed) continue;
      if (key === 'default') route.model = parsed;
      else if (key === 'provider') route.provider = parsed;
      else if (key === 'base_url') route.baseUrl = parsed;
      continue;
    }
    if (/^model\s*:(\s|#|$)/.test(rawLine)) {
      inModelBlock = true;
      blockIndent = null;
    }
  }
  return route;
}

/** Parse only the top-level `fallback_model:` block; null when absent. */
export function parseHermesFallbackModel(configYaml: string): HermesFallbackModel | null {
  const lines = configYaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^fallback_model\s*:(\s|#|$)/.test(line));
  if (start === -1) return null;
  const fallback: HermesFallbackModel = {};
  let blockIndent: number | null = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) break;
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const parsed = unquote(match[2]!);
    if (!parsed) continue;
    if (match[1] === 'provider') fallback.provider = parsed;
    else if (match[1] === 'model') fallback.model = parsed;
    else if (match[1] === 'base_url') fallback.baseUrl = parsed;
    else if (match[1] === 'key_env') fallback.keyEnv = parsed;
  }
  return fallback;
}

/**
 * Parse only the top-level `mcp_servers:` block of a Hermes config.yaml body.
 * Tolerates comments, blank lines, and nested structures (args, headers, env).
 */
export function parseHermesMcpServers(
  configYaml: string,
): Record<string, HermesMcpServerConfig> {
  const lines = configYaml.split(/\r?\n/);
  const servers: Record<string, HermesMcpServerConfig> = {};
  let inMcpBlock = false;
  let currentServer: HermesMcpServerConfig | null = null;
  let serverIndent: number | null = null;
  let currentSubKey: 'args' | 'headers' | 'env' | null = null;
  let subKeyIndent: number | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (!inMcpBlock) {
      if (/^mcp_servers\s*:(\s|#|$)/.test(rawLine)) {
        inMcpBlock = true;
      }
      continue;
    }

    if (indent === 0) {
      break;
    }

    if (serverIndent === null) {
      serverIndent = indent;
    }

    if (indent === serverIndent) {
      const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (match) {
        const currentServerName = match[1]!;
        currentServer = {};
        servers[currentServerName] = currentServer;
        currentSubKey = null;
        subKeyIndent = null;
        continue;
      }
    }

    if (currentServer && indent > serverIndent) {
      if (subKeyIndent !== null && indent > subKeyIndent) {
        if (currentSubKey === 'args') {
          if (trimmed.startsWith('- ') || trimmed === '-') {
            const item = unquote(trimmed.replace(/^-\s*/, ''));
            if (item) {
              currentServer.args = currentServer.args ?? [];
              currentServer.args.push(item);
            }
          }
          continue;
        }

        const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
        if (match) {
          const [, subK, subV] = match;
          const parsed = unquote(subV!);
          if (currentSubKey === 'headers') {
            currentServer.headers = currentServer.headers ?? {};
            currentServer.headers[subK!] = parsed;
          } else if (currentSubKey === 'env') {
            currentServer.env = currentServer.env ?? {};
            currentServer.env[subK!] = parsed;
          }
          continue;
        }
      }

      subKeyIndent = null;
      currentSubKey = null;

      const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      const [, key, rest] = match;
      const val = unquote(rest!);

      if (key === 'command') {
        currentServer.command = val;
      } else if (key === 'url') {
        currentServer.url = val;
      } else if (key === 'cwd') {
        currentServer.cwd = val;
      } else if (key === 'auth') {
        currentServer.auth = val;
      } else if (key === 'disabled') {
        currentServer.disabled = val.toLowerCase() === 'true';
      } else if (key === 'args') {
        currentSubKey = 'args';
        subKeyIndent = indent;
        if (val.startsWith('[') && val.endsWith(']')) {
          try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed)) {
              currentServer.args = parsed.map(String);
            }
          } catch {
            currentServer.args = val
              .slice(1, -1)
              .split(',')
              .map((s) => unquote(s))
              .filter(Boolean);
          }
        }
      } else if (key === 'headers') {
        currentSubKey = 'headers';
        subKeyIndent = indent;
        currentServer.headers = currentServer.headers ?? {};
      } else if (key === 'env') {
        currentSubKey = 'env';
        subKeyIndent = indent;
        currentServer.env = currentServer.env ?? {};
      }
    }
  }

  return servers;
}

interface CustomProvidersBlock {
  start: number;
  end: number;
}

function findCustomProvidersBlock(lines: string[]): CustomProvidersBlock {
  const start = lines.findIndex((line) => /^custom_providers\s*:(\s|#|$)/.test(line));
  if (start === -1) return { start: -1, end: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length === 0) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Parse the top-level `custom_providers:` list of a Hermes config.yaml body.
 * Only complete entries (base_url + integer context_length) are returned;
 * entry-level keys deeper than the item's own indent (e.g. a `models:`
 * override block) are ignored.
 */
export function parseHermesCustomProviders(
  configYaml: string,
): HermesLocalContextWindowEntry[] {
  const lines = configYaml.split(/\r?\n/);
  const { start, end } = findCustomProvidersBlock(lines);
  if (start === -1) return [];

  const entries: HermesLocalContextWindowEntry[] = [];
  let current: { name: string; baseUrl: string; contextLength: number | null } | null = null;
  let itemIndent: number | null = null;

  const flush = (): void => {
    if (current && current.baseUrl && current.contextLength !== null) {
      entries.push({
        name: current.name,
        baseUrl: current.baseUrl,
        contextLength: current.contextLength,
      });
    }
    current = null;
  };

  const readKey = (content: string): void => {
    if (!current) return;
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(content);
    if (!match) return;
    const [, key, rawValue] = match;
    const value = unquote(rawValue!);
    if (key === 'name') current.name = value;
    else if (key === 'base_url') current.baseUrl = value;
    else if (key === 'context_length') {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) current.contextLength = n;
    }
  };

  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const itemMatch = /^(\s*)-\s*(.*)$/.exec(line);
    if (itemMatch && (itemIndent === null || indent <= itemIndent)) {
      flush();
      itemIndent = itemMatch[1]!.length;
      current = { name: '', baseUrl: '', contextLength: null };
      readKey(itemMatch[2]!);
      continue;
    }
    if (current && itemIndent !== null && indent <= itemIndent + 2) {
      readKey(trimmed);
    }
  }
  flush();
  return entries;
}

/**
 * `name -> base_url` for the home's `custom_providers:` (and `providers:`) list entries.
 */
export function parseHermesCustomProviderBaseUrls(configYaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = configYaml.split(/\r?\n/);
  let inBlock = false;
  let itemIndent: number | null = null;
  let current: { name: string; baseUrl: string } | null = null;

  const flush = (): void => {
    if (current && current.name && current.baseUrl) out.set(current.name, current.baseUrl);
    current = null;
  };
  const readKey = (content: string): void => {
    if (!current) return;
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(content);
    if (!match) return;
    const value = unquote(match[2]!);
    if (match[1] === 'name') current.name = value;
    else if (match[1] === 'base_url' || match[1] === 'baseUrl') current.baseUrl = value;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      flush();
      itemIndent = null;
      const header = /^([A-Za-z0-9_]+)\s*:(\s|#|$)/.exec(line)?.[1];
      inBlock = header === 'custom_providers' || header === 'providers';
      continue;
    }
    if (!inBlock) continue;
    const item = /^(\s*)-\s*(.*)$/.exec(line);
    if (item && (itemIndent === null || item[1]!.length <= itemIndent)) {
      flush();
      itemIndent = item[1]!.length;
      current = { name: '', baseUrl: '' };
      readKey(item[2]!);
      continue;
    }
    if (current && itemIndent !== null && indent <= itemIndent + 2) readKey(trimmed);
  }
  flush();
  return out;
}
