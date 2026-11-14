/**
 * Runtime status model (ROADMAP 12.5). The read-only Runtimes tab shows one card per agent
 * runtime: where its CLI lives, the installed `--version`, whether it matches the pin (Hermes),
 * and how many roster agents use it. Nothing here installs, updates or probes the network.
 *
 * Pure by design. No I/O, no clock, no Electron. The desktop host resolves each binary the way
 * its adapter already does and runs `--version` (5 s timeout); this module is the parse + status
 * pair behind that, unit-tested against real `--version` output shapes.
 */

export const RUNTIME_IDS = ['hermes', 'claude-code', 'codex', 'pi'] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export type RuntimeHealth = 'ok' | 'missing' | 'error';

export interface RuntimeStatus {
  id: RuntimeId;
  /** Resolved CLI path; absent when the runtime is not installed. */
  path?: string;
  /** Normalized installed version; absent when missing or unprobeable. */
  version?: string;
  /** The pinned version this runtime is checked against (Hermes only today). */
  pinned?: string;
  /** true/false when a pin and a version are both known; null otherwise. */
  matchesPin: boolean | null;
  health: RuntimeHealth;
  /** Human-readable reason for a missing/error card. */
  detail?: string;
}

/** Managed CLIs that print `<name> <version>` instead of a leading bare version. */
const NAMED_VERSION_PREFIXES = new Set(['pi', 'codex-cli', 'hermes', 'claude']);

function normalizeVersionToken(token: string | undefined): string | null {
  if (!token) return null;
  const match = token.replace(/^v(?=\d)/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  return match ? match[0] : null;
}

/**
 * Parse the supported version forms from the first `--version` output line:
 *   - `0.84.4`               (pi)
 *   - `2.1.258 (Claude Code)`  (claude-code — version leads, suffix is a product label)
 *   - `codex-cli 0.145.0`     (codex)
 *   - `hermes 0.23.0`         (hermes)
 * Strict on purpose: an unknown leading token that is not itself a version yields null rather
 * than scanning the line for anything semver-shaped (mirrors the host binary-version probe).
 */
export function parseRuntimeVersion(stdout: string, stderr: string): string | null {
  const output = (stdout || stderr).trim();
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const tokens = firstLine.split(/\s+/);
  const leading = normalizeVersionToken(tokens[0]);
  if (leading) return leading;
  if (tokens.length >= 2 && NAMED_VERSION_PREFIXES.has(tokens[0]?.toLowerCase() ?? '')) {
    return normalizeVersionToken(tokens[1]);
  }
  return null;
}

function versionTuple(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Exact major.minor.patch equality; a pre-release suffix does not change the pin match. */
export function runtimeVersionMatchesPin(version: string, pinned: string): boolean {
  const a = versionTuple(version);
  const b = versionTuple(pinned);
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export interface RuntimeStatusInput {
  id: RuntimeId;
  path?: string | null;
  version?: string | null;
  pinned?: string | null;
  /** Set when the binary exists but probing it failed (spawn error / timeout). */
  probeError?: string | null;
}

/**
 * Fold a resolved path + probed version into a card status. Fail closed on meaning:
 * no path → missing; a path but a failed/unparseable probe → error; a path + version → ok.
 * `matchesPin` is null unless both a pin and a version are known.
 */
export function buildRuntimeStatus(input: RuntimeStatusInput): RuntimeStatus {
  const base = { id: input.id, ...(input.pinned ? { pinned: input.pinned } : {}) };
  if (!input.path) {
    return { ...base, matchesPin: null, health: 'missing', detail: 'not installed or not on PATH' };
  }
  if (input.probeError) {
    return { ...base, path: input.path, matchesPin: null, health: 'error', detail: input.probeError };
  }
  if (!input.version) {
    return { ...base, path: input.path, matchesPin: null, health: 'error', detail: 'unrecognized --version output' };
  }
  const matchesPin = input.pinned ? runtimeVersionMatchesPin(input.version, input.pinned) : null;
  return { ...base, path: input.path, version: input.version, matchesPin, health: 'ok' };
}
