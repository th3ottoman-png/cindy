/**
 * `~/.cindy-harness/security.json` — the injection guard's own settings file (ROADMAP 10.1).
 *
 * Its own file, like `chat-autosave.json` and `chat-summary.json`, so a future writer of another
 * preference cannot drop it. Missing file → the defaults; unreadable or malformed → the defaults
 * plus an `issue` the Settings row shows, never a throw (the guard must never make the app fail to
 * start, but it must also never run with a silently invented policy).
 *
 * The threshold is clamped rather than rejected: an out-of-range number is a typo, not a decision.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_GUARD_CONFIG, type GuardConfig } from './injection-guard.js';

export const GUARD_POLICIES = ['off', 'log', 'hold', 'block'] as const;
export type GuardPolicy = (typeof GUARD_POLICIES)[number];

export interface GuardConfigRead {
  config: GuardConfig;
  issue?: string;
}

export function defaultGuardConfigFile(home: string): string {
  return path.join(home, '.cindy-harness', 'security.json');
}

function clampThreshold(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0.01, Math.round(value * 100) / 100));
}

/** Validate a parsed object into a `GuardConfig`, reporting the first problem it had to fix. */
export function normalizeGuardConfig(raw: unknown): GuardConfigRead {
  if (raw === undefined || raw === null) return { config: { ...DEFAULT_GUARD_CONFIG } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: { ...DEFAULT_GUARD_CONFIG },
      issue: 'security guard config must be an object like { "threshold": 0.8, "policy": "hold" }',
    };
  }
  const obj = raw as Record<string, unknown>;
  const issues: string[] = [];

  let threshold = DEFAULT_GUARD_CONFIG.threshold;
  if (obj.threshold !== undefined) {
    const clamped = clampThreshold(obj.threshold);
    if (clamped === undefined) issues.push('"threshold" must be a number between 0.01 and 1');
    else {
      if (clamped !== obj.threshold) issues.push('"threshold" was clamped to 0.01…1');
      threshold = clamped;
    }
  }

  let policy: GuardPolicy = DEFAULT_GUARD_CONFIG.policy;
  if (obj.policy !== undefined) {
    if (typeof obj.policy === 'string' && (GUARD_POLICIES as readonly string[]).includes(obj.policy)) {
      policy = obj.policy as GuardPolicy;
    } else {
      issues.push(`"policy" must be one of ${GUARD_POLICIES.join(', ')}`);
    }
  }

  return {
    config: { threshold, policy },
    ...(issues.length ? { issue: issues.join('; ') } : {}),
  };
}

/** Read the guard config; never throws. */
export function readGuardConfig(configFile: string): GuardConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: { ...DEFAULT_GUARD_CONFIG } };
    return {
      config: { ...DEFAULT_GUARD_CONFIG },
      issue: `could not read ${configFile}: ${(err as Error).message}`,
    };
  }
  try {
    return normalizeGuardConfig(JSON.parse(text));
  } catch {
    return { config: { ...DEFAULT_GUARD_CONFIG }, issue: `${configFile} is not valid JSON` };
  }
}

/** Write the guard config atomically (temp file in the same folder + rename). */
export function writeGuardConfig(configFile: string, config: Partial<GuardConfig>): GuardConfig {
  const normalized = normalizeGuardConfig({
    threshold: config.threshold,
    policy: config.policy,
  }).config;
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(configFile)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, configFile);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return normalized;
}
