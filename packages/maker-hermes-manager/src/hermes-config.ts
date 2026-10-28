/**
 * Minimal reader for the Hermes home's default model route.
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
 *
 * This is intentionally a tiny, tolerant line reader for that one block — the
 * daemon must not grow a general YAML dependency, and unknown/extra keys are
 * ignored. Missing file or block yields `{}` so callers can fail closed with
 * their own actionable error.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface HermesDefaultRoute {
  model?: string;
  provider?: string;
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
      // A dedented line ends the block.
      if (indent < blockIndent) break;
      const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine.trim());
      if (!match) continue;
      const [, key, value] = match;
      const parsed = unquote(value);
      if (!parsed) continue;
      if (key === 'default') route.model = parsed;
      else if (key === 'provider') route.provider = parsed;
      continue;
    }
    if (/^model\s*:\s*$/.test(rawLine.trim())) {
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
