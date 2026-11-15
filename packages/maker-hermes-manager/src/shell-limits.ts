/**
 * Shell limits (ROADMAP 13.10b).
 *
 * The owner sets one limit: how long a Hermes `terminal` command may run. The daemon writes it
 * into each session home's `config.yaml` (`terminal.timeout`), using the same keep-formatting
 * writer as the vision route and the hook block, so every other byte of the owner's config
 * survives and the base home is never touched.
 *
 * Probed in 13.10a on Hermes 0.23.0 (docs/evidence/13.10a-shell-limits-probe.md):
 * - `terminal.timeout` exists, integer seconds, default 180.
 * - The foreground hard cap is 600 s (`TERMINAL_MAX_FOREGROUND_TIMEOUT`), so a larger value is
 *   refused here instead of being promoted to a background job behind the owner's back.
 * - There is **no** output-cap setting anywhere in Hermes. `max_output_chars` is therefore read
 *   only to say so plainly; a Cindy-side output cap has to be enforced host-side and is a
 *   separate row.
 * - A per-call `timeout=` argument still overrides the config, so this is a default, not a
 *   ceiling.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 300;
/** Hermes 0.23.0 `FOREGROUND_MAX_TIMEOUT` (probed in 13.10a). */
export const MAX_SHELL_TIMEOUT_SECONDS = 600;
export const SHELL_LIMITS_FILENAME = 'shell-limits.yaml';

export interface ShellLimitsConfig {
  /** Seconds a terminal command may run; 0 leaves the Hermes default (180) alone. */
  timeoutSeconds: number;
}

export interface ShellLimitsLoad {
  config: ShellLimitsConfig;
  /** Problems found in the file; each one fell back to the default for that key. */
  errors: string[];
  file: string;
  exists: boolean;
}

export function defaultShellLimitsConfig(): ShellLimitsConfig {
  return { timeoutSeconds: DEFAULT_SHELL_TIMEOUT_SECONDS };
}

export function defaultShellLimitsFile(): string {
  return nodePath.join(os.homedir(), '.cindy-harness', SHELL_LIMITS_FILENAME);
}

/** Mirrors the narrow reader in web-budget.ts: no YAML dependency for one small file. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Unknown keys and unreadable values are listed and the default is used, so a broken file can
 * never quietly remove the limit.
 */
export function parseShellLimitsYaml(text: string): { config: ShellLimitsConfig; errors: string[] } {
  const config = defaultShellLimitsConfig();
  const errors: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      errors.push(`unexpected indented line: ${JSON.stringify(line.trim())}`);
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) {
      errors.push(`unreadable line: ${JSON.stringify(line.trim())}`);
      continue;
    }
    const key = kv[1]!;
    const value = unquote(kv[2]!.trim());
    if (key === 'timeout_seconds') {
      const n = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n > MAX_SHELL_TIMEOUT_SECONDS) {
        errors.push(
          `timeout_seconds: ${JSON.stringify(value)} is not a whole number from 0 to ${MAX_SHELL_TIMEOUT_SECONDS}; using ${DEFAULT_SHELL_TIMEOUT_SECONDS}`,
        );
      } else {
        config.timeoutSeconds = n;
      }
    } else if (key === 'max_output_chars') {
      errors.push(
        'max_output_chars: ignored — Hermes 0.23 has no output cap setting (probed in ROADMAP 13.10a). '
          + "The per-result budget follows the model's context window; a Cindy-side cap is a separate row.",
      );
    } else {
      errors.push(`unknown key ${JSON.stringify(key)} (ignored)`);
    }
  }
  return { config, errors };
}

/** Never throws: a missing file gives the defaults, an unreadable one lists the error. */
export async function loadShellLimitsConfig(file: string = defaultShellLimitsFile()): Promise<ShellLimitsLoad> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      config: defaultShellLimitsConfig(),
      errors: code === 'ENOENT' ? [] : [`could not read the file (${code ?? 'error'}); using the defaults`],
      file,
      exists: code !== 'ENOENT',
    };
  }
  return { ...parseShellLimitsYaml(text), file, exists: true };
}

/** Re-reads the owner's file at most every `ttlMs`, so a hand edit applies within seconds. */
export function cachedShellLimitsLoader(
  file: string = defaultShellLimitsFile(),
  ttlMs = 2_000,
  now: () => number = Date.now,
): () => Promise<ShellLimitsLoad> {
  let cache: { at: number; load: ShellLimitsLoad } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.load;
    const load = await loadShellLimitsConfig(file);
    cache = { at: now(), load };
    return load;
  };
}

/** End of a top-level block: the next top-level key after at, or EOF. Blank/comment lines skip. */
function blockExtent(lines: string[], at: number): number {
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length === 0) return i;
  }
  return lines.length;
}

function setTerminalTimeout(lines: string[], seconds: number): string[] {
  const entry = `  timeout: ${seconds}`;
  const at = lines.findIndex((line) => /^terminal\s*:/.test(line));
  if (at === -1) {
    const body = [...lines];
    while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
    return [...body, 'terminal:', entry];
  }
  const rest = lines[at]!.replace(/^terminal\s*:/, '').trim();
  if (rest && !rest.startsWith('#')) {
    throw new Error('config.yaml has an inline terminal value; Cindy cannot set the shell timeout');
  }
  const end = blockExtent(lines, at);
  let timeoutAt = -1;
  for (let i = at + 1; i < end; i++) {
    if (/^ {2}timeout\s*:/.test(lines[i]!)) {
      timeoutAt = i;
      break;
    }
  }
  if (timeoutAt === -1) {
    return [...lines.slice(0, at + 1), entry, ...lines.slice(at + 1)];
  }
  return [...lines.slice(0, timeoutAt), entry, ...lines.slice(timeoutAt + 1)];
}

/**
 * Add or replace `terminal.timeout` keeping every other byte. Nested keys under other top-level
 * blocks, comments inside the terminal block and the file's line endings all survive.
 */
export function injectTerminalTimeout(configYaml: string, seconds: number): string {
  const eol = configYaml.includes('\r\n') ? '\r\n' : '\n';
  let lines = configYaml.length > 0 ? configYaml.split(/\r?\n/) : [];
  lines = setTerminalTimeout(lines, seconds);
  const text = lines.join(eol).replace(/(\r?\n)+$/, '');
  return text + eol;
}
