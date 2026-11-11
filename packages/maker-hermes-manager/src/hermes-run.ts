/**
 * One Hermes run = one `hermes chat --format stream-json` child process.
 * The query text rides stdin (`--query-file -`, nothing shell-interpreted);
 * JSONL events stream on stdout; the terminal `result` event and process exit
 * settle the run. Interruption escalates SIGINT → SIGTERM → SIGKILL.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { HermesPermissionMode } from './protocol.js';
import { repairHermesToolEvent } from './tool-call-repair.js';

export interface HermesSpawnSpec {
  hermesBin: string;
  hermesHome: string;
  cwd: string;
  text: string;
  /** Prepended to the first turn's query (Cindy context, in-band). */
  preamble?: string;
  env?: Record<string, string>;
  resumeHermesSessionId?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: HermesPermissionMode;
  /**
   * ROADMAP 10.3 chat-only: run Hermes with `--safe-mode` (no toolsets, no MCP servers, no
   * plugins/user config). Hermes refuses `--safe-mode` without an explicit model, so a chat-only
   * turn must carry `model` (the daemon freezes the route in the registry and always passes it).
   */
  chatOnly?: boolean;
  maxTurns?: number;
  /** Built-in toolsets (`-t`); passed sorted so a resume repeats the launch value exactly. */
  toolsets?: string[];
  runBudgetSeconds?: number;
  /**
   * Argv inserted between the binary and the `chat` subcommand — for wrapper
   * scripts and test fixtures that take the real CLI as an argument.
   */
  extraArgs?: string[];
}

export interface HermesRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  sawResult: boolean;
  resultEvent?: Record<string, unknown>;
  stderrTail: string;
  spawnError?: string;
}

export interface HermesRunHandle {
  child: ChildProcess;
  result: Promise<HermesRunResult>;
  /** Escalating stop; resolves once the child has exited. Idempotent. */
  kill(): Promise<void>;
}

const STDERR_TAIL_BYTES = 16 * 1024;
const KILL_ESCALATION_MS = 2_000;

/**
 * `hermes chat --resume <id>` validates the id before any turn runs and exits
 * with this message when the home no longer has the session. Matching only the
 * documented wording keeps unrelated failures (auth, gateway, tool crashes) out
 * of the fresh-start fallback.
 */
const INVALID_RESUME_PATTERN = /no session found matching|session not found/i;

/**
 * True when the run failed because the requested resume id is gone. Both the
 * stream-json `result.error` and the stderr trailer are checked: Hermes writes
 * the message to both today, and a future version may keep only one.
 */
export function isInvalidResumeFailure(result: HermesRunResult): boolean {
  if (result.spawnError || result.code === 0) return false;
  const resultError = typeof result.resultEvent?.error === 'string'
    ? result.resultEvent.error
    : '';
  return INVALID_RESUME_PATTERN.test(resultError) || INVALID_RESUME_PATTERN.test(result.stderrTail);
}

/**
 * Cindy permission modes → Hermes CLI flags (approved mapping; v1).
 * `auto` (ROADMAP 1.13b) runs with full tools like `--yolo`, but the session
 * home carries a fail-closed `pre_tool_call` hook that asks Cindy before every
 * tool call; `--accept-hooks` registers it without a TTY consent prompt.
 * `--safe-mode` would ignore config (and so the hook), so `auto` never uses it.
 */
export function permissionModeToFlags(mode?: HermesPermissionMode): string[] {
  // ROADMAP 10.1: Full access keeps `--yolo` (no prompts, no safe-mode) but accepts hooks, which
  // is what lets Cindy's security guard score a tool call before Hermes runs it.
  if (mode === 'bypassPermissions') return ['--yolo', '--accept-hooks'];
  if (mode === 'auto') return ['--yolo', '--accept-hooks'];
  return ['--safe-mode'];
}

export function buildHermesArgs(spec: HermesSpawnSpec): string[] {
  // `hermes chat` always launches through Hermes's canonical gateway, whose
  // option allowlist rejects `--no-restore-cwd` (it names `--in <dir>` as the
  // replacement; the gateway keeps the session's frozen cwd). `--in` is
  // authoritative and always present below. `--run-budget` is likewise
  // gateway-refused (config.yaml `agent.run_budget_seconds` owns it), so the
  // spec field is intentionally not forwarded.
  const args = [
    ...(spec.extraArgs ?? []),
    'chat',
    '--format', 'stream-json',
    '--query-file', '-',
    '--in', spec.cwd,
  ];
  if (spec.resumeHermesSessionId) args.push('--resume', spec.resumeHermesSessionId);
  if (spec.model) args.push('-m', spec.model);
  if (spec.provider) args.push('--provider', spec.provider);
  if (spec.baseUrl) args.push('--base-url', spec.baseUrl);
  if (spec.apiKey) args.push('--api-key', spec.apiKey);
  if (spec.maxTurns !== undefined) args.push('--max-turns', String(spec.maxTurns));
  // Chat-only (10.3) needs *two* flags, which is not obvious:
  //   `--safe-mode`  drops MCP servers, plugins and the user config (so no MCP tools, no hooks)
  //   `-t ''`        drops the built-in toolsets; safe-mode on its own still exposes the shell
  //                  and file tools (measured: a touch still executed under `--safe-mode` alone)
  // `--safe-mode` also refuses to start without an explicit model, hence the check below.
  if (spec.chatOnly) {
    if (!spec.model) {
      throw new Error('chat-only mode needs an explicit model: Hermes refuses --safe-mode without one');
    }
    args.push('--safe-mode', '-t', '');
    return args;
  }
  if (spec.toolsets?.length) args.push('-t', [...spec.toolsets].sort().join(','));
  args.push(...permissionModeToFlags(spec.permissionMode));
  return args;
}

export function startHermesRun(
  spec: HermesSpawnSpec,
  onEvent: (event: unknown) => void,
): HermesRunHandle {
  const child = spawn(spec.hermesBin, buildHermesArgs(spec), {
    cwd: spec.cwd,
    env: {
      ...process.env,
      HERMES_HOME: spec.hermesHome,
      // The child must never inherit a context that could reach the daily home.
      HERMES_MGR_CHILD: '1',
      ...spec.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;
    while (stderrBytes > STDERR_TAIL_BYTES && stderrChunks.length > 0) {
      const dropped = stderrChunks.shift()!;
      stderrBytes -= dropped.length;
    }
  });

  const rl = createInterface({ input: child.stdout });
  let sawResult = false;
  let resultEvent: Record<string, unknown> | undefined;
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // non-JSON stdout line (banner noise) — skip
    }
    if (event && typeof event === 'object' && (event as { type?: string }).type === 'result') {
      sawResult = true;
      resultEvent = event as Record<string, unknown>;
    }
    const sanitized = repairHermesToolEvent(event);
    onEvent(sanitized);
  });

  // A fixture/short-lived child may exit before reading stdin; an EPIPE on our
  // write side is harmless then and must not crash the daemon.
  child.stdin.on('error', () => undefined);
  const queryText = spec.preamble ? `${spec.preamble}\n\n${spec.text}` : spec.text;
  child.stdin.write(queryText);
  child.stdin.end();

  let killed = false;
  const result = new Promise<HermesRunResult>((resolve) => {
    let settled = false;
    const finish = (r: HermesRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.on('error', (err) => {
      finish({
        code: 1, signal: null, sawResult, resultEvent,
        stderrTail: tail(stderrChunks),
        spawnError: err.message,
      });
    });
    child.on('close', (code, signal) => {
      finish({
        code, signal, sawResult, resultEvent, stderrTail: tail(stderrChunks),
      });
    });
  });

  const handle: HermesRunHandle = {
    child,
    result,
    kill(): Promise<void> {
      killed = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        return result.then(() => undefined);
      }
      return new Promise<void>((resolve) => {
        const escalate = (step: 0 | 1 | 2): void => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const signal = step === 0 ? 'SIGINT' : step === 1 ? 'SIGTERM' : 'SIGKILL';
          try {
            child.kill(signal as NodeJS.Signals);
          } catch {
            resolve();
            return;
          }
          if (step >= 2) return; // SIGKILL: close event settles us
          const timer = setTimeout(() => escalate((step + 1) as 1 | 2), KILL_ESCALATION_MS);
          timer.unref?.();
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        };
        escalate(0);
      });
    },
  };
  void killed; // reserved: manager reads its own killed flag for close reasons
  return handle;
}

function tail(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8').slice(-STDERR_TAIL_BYTES);
}
