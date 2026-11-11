/**
 * Injection guard at the `pre_tool_call` seam (ROADMAP 10.1).
 *
 * Hermes executes tools itself, so the only place a verdict can actually stop a call is this hook.
 * Full access (`--yolo`) previously had no hook at all; it now carries `--accept-hooks` and the
 * hook is installed whenever the guard's policy is not `off`, which makes the score the only
 * thing that decides whether the owner sees the call. Clean calls answer `allow` immediately —
 * no approval card, no extra turn — so Full access stays Full access; only a scored call is held.
 *
 * The config file is read per call, so flipping the policy in Settings takes effect on the next
 * tool call without restarting the app.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { readGuardConfig } from '@cindy/maker-core/guard-config';
import {
  DEFAULT_GUARD_CONFIG,
  decideGuardAction,
  scoreToolCall,
  type GuardAction,
  type GuardConfig,
  type GuardVerdict,
} from '@cindy/maker-core/injection-guard';

export function defaultSecurityConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'security.json');
}

/** Never throws: a broken settings file leaves the guard at its defaults rather than unarmed. */
export function readActiveGuardConfig(configFile: string = defaultSecurityConfigFile()): GuardConfig {
  try {
    return readGuardConfig(configFile).config;
  } catch {
    return { ...DEFAULT_GUARD_CONFIG };
  }
}

export interface GuardDecision {
  action: GuardAction;
  verdict: GuardVerdict;
  /** Verdict text for the transcript / hook answer; absent when the call is allowed. */
  reason?: string;
}

export function guardReason(verdict: GuardVerdict, action: GuardAction): string | undefined {
  if (action === 'allow' || !verdict.reason) return undefined;
  const prefix =
    action === 'block'
      ? 'Cindy security guard blocked this tool call'
      : 'Cindy security guard held this tool call';
  return `${prefix} — ${verdict.reason} (score ${verdict.score.toFixed(2)}).`;
}

/** Score one hook payload against the current policy. */
export function decideToolCallGuard(
  payload: { toolName: string; toolInput: unknown },
  config: GuardConfig,
): GuardDecision {
  const verdict = scoreToolCall({ tool: payload.toolName, input: payload.toolInput });
  const action = decideGuardAction(verdict, config);
  const reason = guardReason(verdict, action);
  return { action, verdict, ...(reason ? { reason } : {}) };
}
