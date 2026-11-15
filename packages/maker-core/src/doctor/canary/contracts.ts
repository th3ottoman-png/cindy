/**
 * Hermes upgrade canary contracts (ROADMAP 14.7, blueprint §6).
 *
 * Each contract is a pure check backed by a specific invariant documented in `HANDOVER.md §3`.
 * Probes outside this automated turn (pre_tool_call timing, compression log lines, web tool names)
 * are surfaced explicitly as "not covered — re-probe per HANDOVER §3".
 */

import * as path from 'node:path';

import {
  compareEventShapes,
  type HermesStreamEvent,
} from '../../agents/hermes/event-shapes.js';
import type { DoctorContext } from '../types.js';

export const HERMES_CANARY_PROMPT = 'Reply with the single token CINDY_CANARY_OK.';
export const HERMES_CANARY_TOKEN = 'CINDY_CANARY_OK';

export type CanaryContractId =
  | 'event-shapes'
  | 'result-session-id'
  | 'agent-log-api-call'
  | 'safe-mode-custom-provider'
  | 'canary-reply-token';

export interface CanaryContractResult {
  id: CanaryContractId;
  ok: boolean;
  detail: string;
  docRef: string;
}

export interface CanaryNotCoveredProbe {
  area: string;
  note: string;
}

export const CANARY_NOT_COVERED_PROBES: readonly CanaryNotCoveredProbe[] = [
  {
    area: 'pre_tool_call hook timing',
    note: 'not covered — re-probe per HANDOVER §3',
  },
  {
    area: 'context compression log lines (agent.conversation_compression)',
    note: 'not covered — re-probe per HANDOVER §3',
  },
  {
    area: 'web tool names and schema',
    note: 'not covered — re-probe per HANDOVER §3',
  },
];

export interface SafeModeLaunchRun {
  exitCode: number | null;
  stderr: string;
  events: readonly HermesStreamEvent[];
}

export interface EvaluateHermesCanaryInput {
  candidateEvents: readonly HermesStreamEvent[];
  referenceEvents: readonly HermesStreamEvent[];
  referenceLabel: string;
  agentLogText: string;
  launchRun: SafeModeLaunchRun;
  expectedToken?: string;
}

export interface EvaluatedHermesCanary {
  passed: boolean;
  verdict: string;
  failedIds: CanaryContractId[];
  contracts: CanaryContractResult[];
  notCovered: readonly CanaryNotCoveredProbe[];
}

const AGENT_LOG_API_CALL_RE =
  /agent\.conversation_loop:\s+API call #\d+:\s+model=\S+\s+provider=\S+\s+in=\S+/;

/**
 * Contract 1 (HANDOVER §3 — NDJSON event schema):
 * Emitted `hermes chat --format stream-json` event shapes match the newest stored fixture.
 */
export function checkEventShapesContract(
  candidateEvents: readonly HermesStreamEvent[],
  referenceEvents: readonly HermesStreamEvent[],
  referenceLabel: string,
): CanaryContractResult {
  const cmp = compareEventShapes(candidateEvents, referenceEvents);
  return {
    id: 'event-shapes',
    ok: cmp.ok,
    detail: cmp.ok
      ? `matched ${cmp.checkedKinds.join(', ')} shapes against ${referenceLabel}`
      : cmp.mismatches.join('; '),
    docRef: 'HANDOVER.md §3 (stream-json event shapes & tokens)',
  };
}

/**
 * Contract 2 (HANDOVER §3 — session persistence):
 * Hermes leaves `session_id` empty on `system/init` and places the real ID on `result`.
 */
export function checkResultSessionIdContract(
  candidateEvents: readonly HermesStreamEvent[],
): CanaryContractResult {
  const resultEvent = candidateEvents.find((e) => e.type === 'result');
  if (!resultEvent) {
    return {
      id: 'result-session-id',
      ok: false,
      detail: 'missing result event in stream-json output',
      docRef: 'HANDOVER.md §3 (result.session_id)',
    };
  }
  const sid = resultEvent.session_id;
  if (typeof sid !== 'string' || sid.trim().length === 0) {
    return {
      id: 'result-session-id',
      ok: false,
      detail: 'result event is missing a non-empty string session_id',
      docRef: 'HANDOVER.md §3 (result.session_id)',
    };
  }
  return {
    id: 'result-session-id',
    ok: true,
    detail: `result.session_id present (length ${sid.trim().length})`,
    docRef: 'HANDOVER.md §3 (result.session_id)',
  };
}

/**
 * Contract 3 (HANDOVER §3 — live context indicator):
 * `$HERMES_HOME/logs/agent.log` still writes `agent.conversation_loop: API call #N: model=… provider=… in=…`.
 */
export function checkAgentLogApiCallContract(agentLogText: string): CanaryContractResult {
  const match = AGENT_LOG_API_CALL_RE.exec(agentLogText);
  if (!match) {
    return {
      id: 'agent-log-api-call',
      ok: false,
      detail: 'logs/agent.log missing "agent.conversation_loop: API call #N: model=… provider=… in=…" line',
      docRef: 'HANDOVER.md §3 (agent.conversation_loop API call log line)',
    };
  }
  return {
    id: 'agent-log-api-call',
    ok: true,
    detail: match[0],
    docRef: 'HANDOVER.md §3 (agent.conversation_loop API call log line)',
  };
}

/**
 * Contract 4 (HANDOVER §3 — safe-mode custom provider launch):
 * `--safe-mode --provider custom --base-url <url>` runs to completion cleanly.
 */
export function checkSafeModeCustomProviderContract(
  run: SafeModeLaunchRun,
): CanaryContractResult {
  if (run.exitCode !== 0) {
    const tail = run.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
    return {
      id: 'safe-mode-custom-provider',
      ok: false,
      detail: `hermes chat --safe-mode --provider custom --base-url exited with code ${String(run.exitCode)}${tail ? `: ${tail}` : ''}`,
      docRef: 'HANDOVER.md §3 (--safe-mode --provider custom --base-url)',
    };
  }
  const resultEvent = run.events.find((e) => e.type === 'result');
  if (!resultEvent) {
    return {
      id: 'safe-mode-custom-provider',
      ok: false,
      detail: 'process exited 0 but emitted no result event',
      docRef: 'HANDOVER.md §3 (--safe-mode --provider custom --base-url)',
    };
  }
  if (typeof resultEvent.exit_code === 'number' && resultEvent.exit_code !== 0) {
    return {
      id: 'safe-mode-custom-provider',
      ok: false,
      detail: `result.exit_code was ${resultEvent.exit_code}${typeof resultEvent.error === 'string' ? `: ${resultEvent.error}` : ''}`,
      docRef: 'HANDOVER.md §3 (--safe-mode --provider custom --base-url)',
    };
  }
  return {
    id: 'safe-mode-custom-provider',
    ok: true,
    detail: '--safe-mode --provider custom --base-url completed with exit_code=0',
    docRef: 'HANDOVER.md §3 (--safe-mode --provider custom --base-url)',
  };
}

/**
 * Contract 5 (end-to-end model turn sanity):
 * Streamed reply or `result.text` contains `CINDY_CANARY_OK`.
 */
export function checkReplyTokenContract(
  candidateEvents: readonly HermesStreamEvent[],
  expectedToken: string = HERMES_CANARY_TOKEN,
): CanaryContractResult {
  const resultEvent = candidateEvents.find((e) => e.type === 'result');
  const resultText = typeof resultEvent?.text === 'string' ? resultEvent.text : '';
  const deltaText = candidateEvents
    .filter((e) => e.type === 'text' && typeof e.text === 'string')
    .map((e) => e.text as string)
    .join('');
  const combined = resultText || deltaText;
  const ok = combined.includes(expectedToken);
  return {
    id: 'canary-reply-token',
    ok,
    detail: ok
      ? `reply contained ${expectedToken}`
      : `reply did not contain ${expectedToken} (got ${JSON.stringify(combined.slice(0, 120))})`,
    docRef: 'HANDOVER.md §3 (end-to-end chat reply)',
  };
}

/**
 * Evaluate all five Hermes canary contracts and compute the pin-bump verdict.
 */
export function evaluateHermesCanaryContracts(
  input: EvaluateHermesCanaryInput,
): EvaluatedHermesCanary {
  const contracts: CanaryContractResult[] = [
    checkEventShapesContract(input.candidateEvents, input.referenceEvents, input.referenceLabel),
    checkResultSessionIdContract(input.candidateEvents),
    checkAgentLogApiCallContract(input.agentLogText),
    checkSafeModeCustomProviderContract(input.launchRun),
    checkReplyTokenContract(input.candidateEvents, input.expectedToken),
  ];
  const failedIds = contracts.filter((c) => !c.ok).map((c) => c.id);
  const passed = failedIds.length === 0;
  return {
    passed,
    verdict: passed ? 'safe to bump pin' : `do not bump: ${failedIds.join(', ')}`,
    failedIds,
    contracts,
    notCovered: CANARY_NOT_COVERED_PROBES,
  };
}


export interface HermesCanaryRecordRoute {
  routeName: string;
  providerId: string;
  model: string;
  baseUrl: string;
  local: boolean;
  keyEnv?: string;
}

export interface HermesCanaryRecord {
  version: string;
  at: string;
  route: HermesCanaryRecordRoute;
  passed: boolean;
  verdict: string;
  contracts: CanaryContractResult[];
  notCovered: readonly CanaryNotCoveredProbe[];
}

export function resolveHermesCanaryRecordPath(ctx: DoctorContext, version: string): string {
  return path.join(ctx.paths.harnessDir, 'doctor', 'canary', `hermes-${version}.json`);
}

export async function readHermesCanaryRecord(
  ctx: DoctorContext,
  version: string,
): Promise<
  | { exists: false }
  | { exists: true; valid: true; record: HermesCanaryRecord; filePath: string }
  | { exists: true; valid: false; error: string; filePath: string }
> {
  const filePath = resolveHermesCanaryRecordPath(ctx, version);
  let raw: string;
  try {
    raw = await ctx.fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false };
    }
    return {
      exists: true,
      valid: false,
      error: err instanceof Error ? err.message : String(err),
      filePath,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HermesCanaryRecord>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.version !== 'string' ||
      typeof parsed.at !== 'string' ||
      typeof parsed.passed !== 'boolean' ||
      !Array.isArray(parsed.contracts)
    ) {
      return { exists: true, valid: false, error: 'invalid canary record schema', filePath };
    }
    return { exists: true, valid: true, record: parsed as HermesCanaryRecord, filePath };
  } catch (err) {
    return {
      exists: true,
      valid: false,
      error: `corrupt JSON: ${err instanceof Error ? err.message : String(err)}`,
      filePath,
    };
  }
}
