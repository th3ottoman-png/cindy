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

import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { HermesLocalContextWindowEntry, HermesMcpServerConfig } from './protocol.js';

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

/** Temp-file-then-rename in the same directory (AGENTS.md §4 atomic writes). */
async function writeFileAtomic(configPath: string, text: string): Promise<void> {
  const tmp = path.join(
    path.dirname(configPath),
    `.config.yaml.${randomBytes(6).toString('hex')}.tmp`,
  );
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, configPath);
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

  const isCrlf = yaml.includes('\r\n');
  const newline = isCrlf ? '\r\n' : '\n';
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
    const next = lines.concat(block).join(newline) + newline;
    await writeFileAtomic(configPath, next);
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

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const next = lines.length > 0 ? lines.join(newline) + newline : '';
  await writeFileAtomic(configPath, next);
  return parseHermesDefaultRoute(next);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `fallback_model:` block — Hermes's automatic provider failover on 429/5xx/
 * connection failures. Same surgical rules as the `model:` block: read and
 * rewrite only that top-level block, keep every other byte of the file.
 */
export interface HermesFallbackModel {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** NAME of the environment variable holding the key (custom endpoints). */
  keyEnv?: string;
}

const FALLBACK_FIELDS: ReadonlyArray<readonly [keyof HermesFallbackModel, string]> = [
  ['provider', 'provider'],
  ['model', 'model'],
  ['baseUrl', 'base_url'],
  ['keyEnv', 'key_env'],
];

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

/** Read the home's fallback model; never throws. */
export async function readHermesFallbackModel(hermesHome: string): Promise<HermesFallbackModel | null> {
  try {
    const yaml = await readFile(path.join(hermesHome, 'config.yaml'), 'utf8');
    return parseHermesFallbackModel(yaml);
  } catch {
    return null;
  }
}

/**
 * Write (or, with `null`, delete) the top-level `fallback_model:` block,
 * preserving every other line of the config byte-for-byte. Returns the block
 * as re-parsed from the written file.
 */
export async function writeHermesFallbackModel(
  hermesHome: string,
  fallback: HermesFallbackModel | null,
): Promise<HermesFallbackModel | null> {
  const configPath = path.join(hermesHome, 'config.yaml');
  let yaml = '';
  try {
    yaml = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }

  const newline = yaml.includes('\r\n') ? '\r\n' : '\n';
  const lines = yaml.split(/\r?\n/);
  const block = fallback
    ? [
        'fallback_model:',
        ...FALLBACK_FIELDS.filter(([field]) => fallback[field] !== undefined).map(
          ([field, key]) => `  ${key}: ${yamlScalar(fallback[field]!)}`,
        ),
      ]
    : [];

  const start = lines.findIndex((line) => /^fallback_model\s*:(\s|#|$)/.test(line));
  if (start === -1) {
    if (!block.length) return null; // nothing to delete
    while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...block);
  } else {
    // The block owns every following indented line (and blank lines inside it);
    // a column-0 line starts the next top-level key.
    let end = start;
    for (let index = start + 1; index < lines.length; index += 1) {
      const rawLine = lines[index]!;
      if (!rawLine.trim()) {
        end = index;
        continue;
      }
      if (rawLine.length === rawLine.trimStart().length) break;
      end = index;
    }
    lines.splice(start, end - start + 1, ...block);
  }

  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  const next = lines.length > 0 ? lines.join(newline) + newline : '';
  await writeFileAtomic(configPath, next);
  return parseHermesFallbackModel(next);
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

  const isCrlf = yaml.includes('\r\n');
  const newline = isCrlf ? '\r\n' : '\n';
  const lines = yaml.split(/\r?\n/);
  const blockStart = lines.findIndex((line) => /^mcp_servers\s*:(\s|#|$)/.test(line));

  if (blockStart === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const newBlock = ['', 'mcp_servers:', ...serializeServerLines(name, server, '  ')];
    const next = lines.concat(newBlock).join(newline) + newline;
    await writeFileAtomic(configPath, next);
    return parseHermesMcpServers(next);
  }

  // If mcp_servers was inline empty "mcp_servers: {}", expand to "mcp_servers:"
  if (/^mcp_servers\s*:\s*\{\s*\}\s*$/.test(lines[blockStart]!)) {
    lines[blockStart] = 'mcp_servers:';
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

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const next = lines.length > 0 ? lines.join(newline) + newline : '';
  await writeFileAtomic(configPath, next);
  return parseHermesMcpServers(next);
}

/**
 * Remove an MCP server from `mcp_servers:` in config.yaml.
 * Preserves other servers, blocks and comments. Returns the re-parsed servers.
 *
 * When the last MCP server is removed, removes the empty `mcp_servers:` key
 * (and any preceding comment/blank line separating it from prior blocks),
 * and ensures a clean trailing newline. Writes atomically.
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

  const isCrlf = yaml.includes('\r\n');
  const newline = isCrlf ? '\r\n' : '\n';
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

  // Count all server headers in mcp_servers with this indent
  const serverHeaders: Array<{ name: string; headerIndex: number; startIndex: number }> = [];
  for (let i = blockStart + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === serverIndent) {
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line.trim());
      if (match) {
        let startIndex = i;
        while (startIndex > blockStart + 1) {
          const prev = lines[startIndex - 1]!;
          if (!prev.trim()) break;
          const prevIndent = prev.length - prev.trimStart().length;
          if (prevIndent === serverIndent && prev.trimStart().startsWith('#')) {
            startIndex--;
          } else {
            break;
          }
        }
        serverHeaders.push({ name: match[1]!, headerIndex: i, startIndex });
      }
    }
  }

  const targetIdx = serverHeaders.findIndex((s) => s.name === name);
  if (targetIdx === -1) {
    return parseHermesMcpServers(yaml);
  }

  if (serverHeaders.length === 1) {
    // Last server in mcp_servers block: remove the entire mcp_servers block
    // including any block-level comments and blank separator lines.
    let removeStart = blockStart;
    while (removeStart > 0) {
      const prev = lines[removeStart - 1]!;
      const prevIndent = prev.length - prev.trimStart().length;
      if (prevIndent === 0 && prev.trimStart().startsWith('#')) {
        removeStart--;
      } else {
        break;
      }
    }
    lines.splice(removeStart, blockEnd - removeStart);
  } else {
    // Multiple servers: remove only this server and its preceding comments
    const target = serverHeaders[targetIdx]!;
    const nextServer = serverHeaders[targetIdx + 1];
    let serverEnd = nextServer ? nextServer.startIndex : blockEnd;
    if (!nextServer) {
      while (serverEnd > target.startIndex + 1 && !lines[serverEnd - 1]!.trim()) {
        serverEnd--;
      }
    }
    lines.splice(target.startIndex, serverEnd - target.startIndex);
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const next = lines.length > 0 ? lines.join(newline) + newline : '';
  await writeFileAtomic(configPath, next);
  return parseHermesMcpServers(next);
}

/**
 * Strips any MCP server entries from config.yaml that have `disabled: true`.
 * Used when materializing per-session home config.yaml files, because
 * Hermes 0.22.5 ignores `disabled: true` on mcp_servers at startup.
 * Preserves comments, enabled servers, and non-MCP blocks byte-for-byte.
 */
export function filterDisabledMcpServers(configYaml: string): string {
  const parsed = parseHermesMcpServers(configYaml);
  const disabledNames = new Set(
    Object.entries(parsed)
      .filter(([, cfg]) => cfg.disabled === true)
      .map(([name]) => name),
  );

  if (disabledNames.size === 0) {
    return configYaml;
  }

  const isCrlf = configYaml.includes('\r\n');
  const lines = configYaml.split(/\r?\n/);
  const blockStart = lines.findIndex((line) => /^mcp_servers\s*:(\s|#|$)/.test(line));
  if (blockStart === -1) {
    return configYaml;
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

  let serverIndent: number | null = null;
  for (let i = blockStart + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    serverIndent = line.length - line.trimStart().length;
    break;
  }

  if (serverIndent === null) {
    return configYaml;
  }

  const serverHeaders: Array<{ name: string; headerIndex: number; startIndex: number }> = [];
  for (let i = blockStart + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === serverIndent) {
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line.trim());
      if (match) {
        let startIndex = i;
        while (startIndex > blockStart + 1) {
          const prev = lines[startIndex - 1]!;
          if (!prev.trim()) break;
          const prevIndent = prev.length - prev.trimStart().length;
          if (prevIndent === serverIndent && prev.trimStart().startsWith('#')) {
            startIndex--;
          } else {
            break;
          }
        }
        serverHeaders.push({ name: match[1]!, headerIndex: i, startIndex });
      }
    }
  }

  const disabledRanges: Array<{ start: number; end: number }> = [];
  for (let idx = 0; idx < serverHeaders.length; idx++) {
    const { name, startIndex } = serverHeaders[idx]!;
    if (disabledNames.has(name)) {
      const nextServer = serverHeaders[idx + 1];
      let end = nextServer ? nextServer.startIndex : blockEnd;
      if (!nextServer) {
        while (end > startIndex + 1 && !lines[end - 1]!.trim()) {
          end--;
        }
      }
      disabledRanges.push({ start: startIndex, end });
    }
  }

  disabledRanges.sort((a, b) => b.start - a.start);
  for (const { start, end } of disabledRanges) {
    lines.splice(start, end - start);
  }

  const remainingServersCount = serverHeaders.length - disabledRanges.length;
  if (remainingServersCount === 0) {
    lines[blockStart] = 'mcp_servers: {}';
  }

  return lines.join(isCrlf ? '\r\n' : '\n');
}

/* ===== Local endpoint context windows (custom_providers) ===== */

/** Same normalization as the route resolver: strip trailing slashes, ensure `/v1`. */
function normalizeLocalBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

interface CustomProvidersBlock {
  /** Index of the `custom_providers:` line, or -1 when absent. */
  start: number;
  /** First line index past the block (only meaningful when start !== -1). */
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
    // Continuation line: entry-level keys sit at itemIndent + 2; anything
    // deeper belongs to a nested block (e.g. per-model overrides).
    if (current && itemIndent !== null && indent <= itemIndent + 2) {
      readKey(trimmed);
    }
  }
  flush();
  return entries;
}

/**
 * `name → base_url` for the home's `custom_providers:` (and `providers:`) list entries.
 *
 * `--safe-mode` implies `--ignore-user-config`, so a `--provider <name>` that only exists in
 * that config cannot resolve and Hermes exits with `Unknown provider '<name>'` before any model
 * call (ROADMAP §Debt). The built-in `custom` provider plus `--base-url` is the same endpoint
 * without needing the config, so the daemon hands this map to the argv builder.
 *
 * Only list-shaped entries (`- name: …` + `base_url:`) are read; an entry without a usable
 * base_url is omitted, and any other block shape yields nothing, so the caller leaves the
 * route untouched rather than guessing. Comments and the entries' other keys are ignored.
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
    // Continuation keys sit one level under the item; anything deeper is a nested block.
    if (current && itemIndent !== null && indent <= itemIndent + 2) readKey(trimmed);
  }
  flush();
  return out;
}

/** Read {@link parseHermesCustomProviderBaseUrls} from a home; missing/unreadable → empty. */
export async function readHermesCustomProviderBaseUrls(
  hermesHome: string,
): Promise<Map<string, string>> {
  try {
    return parseHermesCustomProviderBaseUrls(await readFile(path.join(hermesHome, 'config.yaml'), 'utf8'));
  } catch {
    return new Map();
  }
}

export interface SafeModeRouteRewrite {
  provider?: string;
  baseUrl?: string;
  /** The custom-provider name that was replaced by the built-in `custom` provider. */
  rewrittenFrom?: string;
}

/**
 * Spell a custom-provider route in the one form `--safe-mode` can resolve.
 *
 * `--provider <custom_providers name>` needs the user config that safe-mode ignores, so it fails
 * with `Unknown provider '<name>'`; `--provider custom --base-url <url>` needs nothing. Built-in
 * providers, an already-`custom` route and unknown names are returned untouched — the daemon must
 * not invent an endpoint it does not know.
 */
export function rewriteProviderForSafeMode(
  route: { provider?: string; baseUrl?: string },
  customProviderBaseUrls: ReadonlyMap<string, string>,
): SafeModeRouteRewrite {
  const provider = route.provider?.trim();
  const baseUrl = route.baseUrl?.trim();
  if (!provider || provider === 'custom') {
    return { ...(provider ? { provider } : {}), ...(baseUrl ? { baseUrl } : {}) };
  }
  const knownBaseUrl = customProviderBaseUrls.get(provider);
  if (!knownBaseUrl) return { provider, ...(baseUrl ? { baseUrl } : {}) };
  return { provider: 'custom', baseUrl: baseUrl || knownBaseUrl, rewrittenFrom: provider };
}

function serializeCustomProviderLines(
  entry: HermesLocalContextWindowEntry,
  itemIndent: string,
): string[] {
  return [
    `${itemIndent}- name: ${yamlScalar(entry.name)}`,
    `${itemIndent}  base_url: ${yamlScalar(entry.baseUrl)}`,
    `${itemIndent}  context_length: ${entry.contextLength}`,
  ];
}

/**
 * Replace the global `model.ollama_num_ctx` clamp with per-endpoint context
 * windows (1.12b). Removes the key from the top-level `model:` block and
 * upserts one `custom_providers` list entry per local endpoint, matched by
 * normalized base_url. Other keys, other entries, comments and unrelated
 * blocks are preserved byte-for-byte. The whole change lands in one atomic
 * write; the result is re-parsed from the final text.
 *
 * Throws when an existing `custom_providers` block is not a YAML list — that
 * shape is a config error Hermes itself rejects, and merging into it would
 * corrupt the file.
 */
export async function writeHermesLocalContextWindows(
  hermesHome: string,
  entries: HermesLocalContextWindowEntry[],
): Promise<{ removedOllamaNumCtx: boolean; providers: HermesLocalContextWindowEntry[] }> {
  const configPath = path.join(hermesHome, 'config.yaml');
  let yaml = '';
  try {
    yaml = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }

  const incoming = entries.map((entry) => ({
    name: entry.name,
    baseUrl: normalizeLocalBaseUrl(entry.baseUrl),
    contextLength: entry.contextLength,
  }));
  const incomingByUrl = new Map(incoming.map((entry) => [entry.baseUrl, entry]));

  const lines = yaml.split(/\r?\n/);

  // 1. Drop the global clamp from the top-level model: block.
  let removedOllamaNumCtx = false;
  const modelStart = lines.findIndex((line) => /^model\s*:(\s|#|$)/.test(line));
  if (modelStart !== -1) {
    for (let i = modelStart + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) break;
      if (/^\s*ollama_num_ctx\s*:/.test(line)) {
        lines.splice(i, 1);
        removedOllamaNumCtx = true;
        i -= 1; // re-check the line that shifted into this slot
      }
    }
  }

  // 2. Upsert the custom_providers list.
  const block = findCustomProvidersBlock(lines);
  if (block.start === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const appended = ['', 'custom_providers:'];
    for (const entry of incoming) appended.push(...serializeCustomProviderLines(entry, '  '));
    const next = lines.concat(appended).join('\n') + '\n';
    await writeFileAtomic(configPath, next);
    return { removedOllamaNumCtx, providers: parseHermesCustomProviders(next) };
  }

  // An inline `[]` is an empty list; any other inline value is not a list.
  const headerMatch = /^custom_providers\s*:\s*(.*?)\s*(?:#.*)?$/.exec(lines[block.start]!);
  const inlineValue = headerMatch?.[1] ?? '';
  if (inlineValue === '[]') {
    lines[block.start] = 'custom_providers:';
  } else if (inlineValue) {
    throw new Error('custom_providers block is not a list; refusing to edit');
  }

  // Pass 1: scan the block and collect list items without mutating anything.
  // Every content line must belong to a list item — a mapping-shaped block is
  // a config error, fail closed.
  interface ScannedItem {
    baseUrl: string;
    baseUrlLine: number;
    baseUrlIndent: number;
    isHeaderLine: boolean;
    contextLengthLine: number;
  }
  const items: ScannedItem[] = [];
  let itemIndent: number | null = null;
  let currentItem: ScannedItem | null = null;
  let detectedItemIndent = '  ';

  for (let i = block.start + 1; i < block.end; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const itemMatch = /^(\s*)-\s*(.*)$/.exec(line);
    if (itemMatch && (itemIndent === null || indent <= itemIndent)) {
      itemIndent = itemMatch[1]!.length;
      detectedItemIndent = itemMatch[1]!;
      currentItem = {
        baseUrl: '',
        baseUrlLine: -1,
        baseUrlIndent: 0,
        isHeaderLine: false,
        contextLengthLine: -1,
      };
      items.push(currentItem);
      const keyMatch = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(itemMatch[2]!);
      if (keyMatch?.[1] === 'base_url') {
        currentItem.baseUrl = normalizeLocalBaseUrl(unquote(keyMatch[2]!));
        currentItem.baseUrlLine = i;
        currentItem.baseUrlIndent = indent;
        currentItem.isHeaderLine = true;
      }
      continue;
    }
    if (itemIndent === null) {
      throw new Error('custom_providers block is not a list; refusing to edit');
    }
    if (!currentItem) continue;
    const keyMatch = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!keyMatch) continue;
    if (keyMatch[1] === 'base_url' && currentItem.baseUrlLine === -1) {
      currentItem.baseUrl = normalizeLocalBaseUrl(unquote(keyMatch[2]!));
      currentItem.baseUrlLine = i;
      currentItem.baseUrlIndent = indent;
    } else if (
      keyMatch[1] === 'context_length' &&
      currentItem.contextLengthLine === -1 &&
      currentItem.baseUrlLine !== -1 &&
      indent <= currentItem.baseUrlIndent + 2
    ) {
      currentItem.contextLengthLine = i;
    }
  }

  // Pass 2: mutate from the bottom up so earlier line indices stay valid.
  const handledUrls = new Set<string>();
  let insertDelta = 0;
  for (const item of [...items].reverse()) {
    const incomingEntry = incomingByUrl.get(item.baseUrl);
    if (!incomingEntry) continue;
    handledUrls.add(item.baseUrl);
    const rendered = `context_length: ${incomingEntry.contextLength}`;
    if (item.contextLengthLine !== -1) {
      const indent = lines[item.contextLengthLine]!.match(/^\s*/)![0];
      lines[item.contextLengthLine] = `${indent}${rendered}`;
    } else {
      const indent = ' '.repeat(
        item.isHeaderLine ? item.baseUrlIndent + 2 : item.baseUrlIndent,
      );
      lines.splice(item.baseUrlLine + 1, 0, `${indent}${rendered}`);
      insertDelta += 1;
    }
  }

  const pendingAppends = incoming
    .filter((entry) => !handledUrls.has(entry.baseUrl))
    .flatMap((entry) => serializeCustomProviderLines(entry, detectedItemIndent));
  if (pendingAppends.length) {
    lines.splice(block.end + insertDelta, 0, ...pendingAppends);
  }

  const next = lines.join('\n');
  await writeFileAtomic(configPath, next);
  return { removedOllamaNumCtx, providers: parseHermesCustomProviders(next) };
}
