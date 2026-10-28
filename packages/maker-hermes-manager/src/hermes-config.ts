/**
 * Minimal reader/writer for the Hermes home's default model route.
 *
 * `hermes chat --safe-mode` deliberately refuses to read the profile default
 * and requires an explicit `--model`/`--provider`; Cindy's `default`
 * permission mode maps to `--safe-mode`, so the daemon must supply the route
 * its home would otherwise use. The profile source of truth is
 * `$HERMES_HOME/config.yaml`:
 *
 *   model:
 *     default: deepseek/deepseek-v4.1-flash-1017
 *     provider: nous
 *     base_url: https://inference-api.nousresearch.com/v1
 *
 * This is intentionally a tiny, tolerant line reader/editor for that one
 * block — the daemon must not grow a general YAML dependency, and
 * unknown/extra keys are ignored. A missing file or block yields `{}` on
 * read so callers can fail closed with their own actionable error.
 *
 * The writer is equally surgical: it rewrites only the `default` / `provider`
 * / `base_url` keys of the top-level `model:` block and preserves every other
 * byte of the file (comments, key order, unrelated blocks). When a key is
 * absent it is inserted directly under `model:`; when the whole block is
 * missing it is appended.
 */

import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { HermesMcpServerConfig } from './protocol.js';

export interface HermesDefaultRoute {
  model?: string;
  provider?: string;
  baseUrl?: string;
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

/** YAML scalar rendering that survives Hermes's line-based reader. */
function yamlScalar(value: string): string {
  // Plain scalars stay plain (matches the hand-written config style); anything
  // with YAML-special characters goes double-quoted.
  return /^[A-Za-z0-9._/:~-]+$/.test(value) ? value : JSON.stringify(value);
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
      // A dedented line ends the block.
      if (indent < blockIndent) break;
      const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine.trim());
      if (!match) continue;
      const [, key, value] = match;
      const parsed = unquote(value);
      if (!parsed) continue;
      if (key === 'default') route.model = parsed;
      else if (key === 'provider') route.provider = parsed;
      else if (key === 'base_url') route.baseUrl = parsed;
      continue;
    }
    // Top-level `model:` only — a nested `model:` under another block must not
    // hijack the route (the writer relies on the same rule).
    if (/^model\s*:(\s|#|$)/.test(rawLine)) {
      inModelBlock = true;
      blockIndent = null;
    }
  }
  return route;
}

/** Read the home's default route; never throws. */
export async function readHermesDefaultRoute(hermesHome: string): Promise<HermesDefaultRoute> {
  try {
    const yaml = await readFile(path.join(hermesHome, 'config.yaml'), 'utf8');
    return parseHermesDefaultRoute(yaml);
  } catch {
    return {};
  }
}

const ROUTE_KEYS = ['default', 'provider', 'base_url'] as const;
const ROUTE_KEY_FOR: Record<'model' | 'provider' | 'baseUrl', (typeof ROUTE_KEYS)[number]> = {
  model: 'default',
  provider: 'provider',
  baseUrl: 'base_url',
};

/**
 * Rewrite the top-level `model:` block's default/provider/base_url keys,
 * preserving every other line of the config byte-for-byte. `model` and
 * `provider` are required; `baseUrl` is optional — when omitted the existing
 * `base_url` line (if any) is left untouched. Returns the route as re-parsed
 * from the written file. Throws on filesystem errors; callers map to RPC
 * errors.
 */
export async function writeHermesDefaultRoute(
  hermesHome: string,
  route: { model: string; provider: string; baseUrl?: string },
): Promise<HermesDefaultRoute> {
  const configPath = path.join(hermesHome, 'config.yaml');
  let yaml = '';
  try {
    yaml = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }

  const lines = yaml.split(/\r?\n/);
  const values: Record<'model' | 'provider' | 'baseUrl', string | undefined> = {
    model: route.model,
    provider: route.provider,
    baseUrl: route.baseUrl,
  };
  const rendered: Partial<Record<(typeof ROUTE_KEYS)[number], string>> = {};
  for (const field of ['model', 'provider', 'baseUrl'] as const) {
    const value = values[field];
    if (value !== undefined) rendered[ROUTE_KEY_FOR[field]] = `  ${ROUTE_KEY_FOR[field]}: ${yamlScalar(value)}`;
  }

  const blockStart = lines.findIndex((line) => /^model\s*:(\s|#|$)/.test(line));
  if (blockStart === -1) {
    // No block: append one. Missing keys that were not provided are skipped,
    // but `model`/`provider` are always present by the caller's contract.
    const block = ['', 'model:'];
    for (const key of ROUTE_KEYS) {
      const line = rendered[key];
      if (line) block.push(line);
    }
    // Drop trailing blank lines, append the block, keep exactly one final newline.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const next = lines.concat(block).join('\n') + '\n';
    await writeFile(configPath, next, 'utf8');
    return parseHermesDefaultRoute(next);
  }

  // Walk the block's key lines and rewrite in place; remember where the block
  // ends so missing keys can be inserted right after `model:`.
  let insertAfter = blockStart;
  const seen = new Set<(typeof ROUTE_KEYS)[number]>();
  for (let index = blockStart + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // dedented to column 0: next top-level key
    const match = /^([A-Za-z0-9_]+)\s*:/.exec(line.trim());
    if (match) {
      const key = match[1] as (typeof ROUTE_KEYS)[number];
      if (key in rendered) {
        lines[index] = rendered[key]!;
        seen.add(key);
      }
      if (key === 'default') insertAfter = index;
      else if (key === 'provider' && !('default' in rendered)) insertAfter = index;
    }
  }
  // Insert missing keys directly under `model:` (or under the last rewritten
  // key above), keeping the conventional default → provider → base_url order.
  const missing = ROUTE_KEYS.filter((key) => key in rendered && !seen.has(key));
  if (missing.length) {
    lines.splice(insertAfter + 1, 0, ...missing.map((key) => rendered[key]!));
  }

  const next = lines.join('\n');
  await writeFile(configPath, next, 'utf8');
  return parseHermesDefaultRoute(next);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    // Dedented to column 0: top-level section ended
    if (indent === 0) {
      break;
    }

    if (serverIndent === null) {
      serverIndent = indent;
    }

    // A new server header at serverIndent
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

    // Server properties (nested under currentServer)
    if (currentServer && indent > serverIndent) {
      // Sub-block handling (headers, env, or args list items)
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
          const parsed = unquote(subV);
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

      // If we got here, we're not inside a deeper sub-block
      subKeyIndent = null;
      currentSubKey = null;

      const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      const [, key, rest] = match;
      const val = unquote(rest);

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

/** Read configured MCP servers from $HERMES_HOME/config.yaml; never throws. */
export async function readHermesMcpServers(
  hermesHome: string,
): Promise<Record<string, HermesMcpServerConfig>> {
  try {
    const yaml = await readFile(path.join(hermesHome, 'config.yaml'), 'utf8');
    return parseHermesMcpServers(yaml);
  } catch {
    return {};
  }
}

function serializeServerLines(
  name: string,
  server: HermesMcpServerConfig,
  indent = '  ',
): string[] {
  const lines: string[] = [`${indent}${name}:`];
  const pIndent = `${indent}  `;
  if (server.command) {
    lines.push(`${pIndent}command: ${yamlScalar(server.command)}`);
  }
  if (server.args && server.args.length > 0) {
    lines.push(`${pIndent}args:`);
    for (const a of server.args) {
      lines.push(`${pIndent}  - ${yamlScalar(a)}`);
    }
  }
  if (server.url) {
    lines.push(`${pIndent}url: ${yamlScalar(server.url)}`);
  }
  if (server.headers && Object.keys(server.headers).length > 0) {
    lines.push(`${pIndent}headers:`);
    for (const [k, v] of Object.entries(server.headers)) {
      lines.push(`${pIndent}  ${k}: ${yamlScalar(v)}`);
    }
  }
  if (server.env && Object.keys(server.env).length > 0) {
    lines.push(`${pIndent}env:`);
    for (const [k, v] of Object.entries(server.env)) {
      lines.push(`${pIndent}  ${k}: ${yamlScalar(v)}`);
    }
  }
  if (server.cwd) {
    lines.push(`${pIndent}cwd: ${yamlScalar(server.cwd)}`);
  }
  if (server.auth) {
    lines.push(`${pIndent}auth: ${yamlScalar(server.auth)}`);
  }
  if (server.disabled !== undefined) {
    lines.push(`${pIndent}disabled: ${server.disabled ? 'true' : 'false'}`);
  }
  return lines;
}

/**
 * Write or update an MCP server under top-level `mcp_servers:` in config.yaml.
 * Preserves other blocks and comments. Returns the re-parsed servers.
 */
export async function writeHermesMcpServer(
  hermesHome: string,
  name: string,
  server: HermesMcpServerConfig,
): Promise<Record<string, HermesMcpServerConfig>> {
  const configPath = path.join(hermesHome, 'config.yaml');
  let yaml = '';
  try {
    yaml = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }

  const lines = yaml.split(/\r?\n/);
  const blockStart = lines.findIndex((line) => /^mcp_servers\s*:(\s|#|$)/.test(line));

  if (blockStart === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const newBlock = ['', 'mcp_servers:', ...serializeServerLines(name, server, '  ')];
    const next = lines.concat(newBlock).join('\n') + '\n';
    await writeFile(configPath, next, 'utf8');
    return parseHermesMcpServers(next);
  }

  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      blockEnd = i;
      break;
    }
  }

  const serverHeaderRegex = new RegExp(`^(\\s+)${escapeRegex(name)}\\s*:`);
  let serverIndex = -1;
  let serverIndentStr = '  ';

  for (let i = blockStart + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    const match = serverHeaderRegex.exec(line);
    if (match) {
      serverIndex = i;
      serverIndentStr = match[1]!;
      break;
    }
  }

  const newServerLines = serializeServerLines(name, server, serverIndentStr);

  if (serverIndex !== -1) {
    const serverIndent = serverIndentStr.length;
    let serverEnd = blockEnd;
    for (let i = serverIndex + 1; i < blockEnd; i++) {
      const line = lines[i]!;
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= serverIndent) {
        serverEnd = i;
        break;
      }
    }
    lines.splice(serverIndex, serverEnd - serverIndex, ...newServerLines);
  } else {
    lines.splice(blockStart + 1, 0, ...newServerLines);
  }

  const next = lines.join('\n');
  await writeFile(configPath, next, 'utf8');
  return parseHermesMcpServers(next);
}

/**
 * Remove an MCP server from `mcp_servers:` in config.yaml.
 * Preserves other servers, blocks and comments. Returns the re-parsed servers.
 */
export async function removeHermesMcpServer(
  hermesHome: string,
  name: string,
): Promise<Record<string, HermesMcpServerConfig>> {
  const configPath = path.join(hermesHome, 'config.yaml');
  let yaml = '';
  try {
    yaml = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return {};
  }

  const lines = yaml.split(/\r?\n/);
  const blockStart = lines.findIndex((line) => /^mcp_servers\s*:(\s|#|$)/.test(line));
  if (blockStart === -1) {
    return parseHermesMcpServers(yaml);
  }

  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      blockEnd = i;
      break;
    }
  }

  const serverHeaderRegex = new RegExp(`^(\\s+)${escapeRegex(name)}\\s*:`);
  let serverIndex = -1;
  let serverIndent = 2;

  for (let i = blockStart + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    const match = serverHeaderRegex.exec(line);
    if (match) {
      serverIndex = i;
      serverIndent = match[1]!.length;
      break;
    }
  }

  if (serverIndex === -1) {
    return parseHermesMcpServers(yaml);
  }

  let serverEnd = blockEnd;
  for (let i = serverIndex + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= serverIndent) {
      serverEnd = i;
      break;
    }
  }

  lines.splice(serverIndex, serverEnd - serverIndex);
  const next = lines.join('\n');
  await writeFile(configPath, next, 'utf8');
  return parseHermesMcpServers(next);
}
