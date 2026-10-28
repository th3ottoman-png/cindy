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
