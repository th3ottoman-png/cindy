/**
 * Why a Hermes turn died before it could answer (ROADMAP §Debt: the banner used
 * to say only `Hermes exited with code 1`).
 *
 * Measured 2026-11-13 with the installed CLI: a launch that fails before its
 * first model call ends with a stream-json `result` that carries
 * `exit_code: 1` and **no** `error` field, while the cause is written by the
 * managed worker into `<home>/logs/managed-worker.log`, not into the CLI's own
 * stderr (whose tail is install noise plus `session_id: …`). So the useful
 * last line lives one level down from `stderrTail`, in the home; both are
 * consulted, the home first.
 *
 * Pure + bounded: one optional 32 KiB tail read of a known file, no spawn, no
 * network. Only the failure path pays for it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The worker log Hermes writes under whichever home the turn ran in. */
const MANAGED_WORKER_LOG = path.join('logs', 'managed-worker.log');

/** Reading the whole log would grow with the home's age; a cause is at the end. */
const TAIL_BYTES = 32 * 1024;

/** Filesystem timestamp skew tolerated when deciding whether a log is this run's. */
const MTIME_SKEW_MS = 1_000;

export interface FailureDetailOptions {
  /**
   * When set, a worker log last written before this instant cannot explain the
   * run: it would surface an older turn's cause, which is worse than the bare
   * exit code. Pass the run's start time.
   */
  notBeforeMs?: number;
}

/** A banner line, not a stack: the renderer shows this verbatim. */
const MAX_LINE_CHARS = 400;

/** `\u001b[31m` and friends make a one-line banner unreadable. */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `[pid 94503] ` prefixes every managed-worker line. */
const PID_PREFIX = /^\[pid \d+\]\s*/;

/**
 * Lines a doomed launch always leaves behind (measured; see the file header).
 * They are not causes, so a banner must not show them.
 */
const NOISE = [
  /^session_id\s*:/i,
  /^session\s*:/i,
  /^\u26a0/,
  /hermes pm install/i,
  /install out of sync/i,
];

/**
 * What a cause looks like across the shapes seen so far: a Python traceback
 * tail (`hermes_cli.auth_constants.AuthError: …`), a plain `Error: …`, or a
 * gateway/CLI `fatal:` line.
 */
const ERRORISH =
  /(?:\b[A-Za-z0-9_.]*(?:Error|Exception)\b)|\bTraceback\b|(?:^|\b)(?:fatal|error|FATAL|ERROR)\s*:/;

/**
 * Last error-shaped line of a log or stderr tail, or undefined when the text
 * carries no cause at all (so the caller keeps its existing wording instead of
 * inventing one).
 */
export function pickFailureLine(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(PID_PREFIX, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (NOISE.some((pattern) => pattern.test(line))) continue;
    if (!ERRORISH.test(line)) continue;
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}\u2026` : line;
  }
  return undefined;
}

/**
 * Tail of `<home>/logs/managed-worker.log`, where a failed managed worker
 * writes its traceback. Missing/unreadable file ⇒ undefined, never a throw:
 * this runs while a turn is already failing.
 */
export function readHermesLogFailureLine(
  home: string,
  options: FailureDetailOptions = {},
): string | undefined {
  const file = path.join(home, MANAGED_WORKER_LOG);
  let fd: number | undefined;
  try {
    if (
      options.notBeforeMs !== undefined &&
      fs.statSync(file).mtimeMs < options.notBeforeMs - MTIME_SKEW_MS
    ) {
      return undefined;
    }
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return undefined;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return pickFailureLine(buffer.toString('utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* an unreadable log must not mask the turn failure */
      }
    }
  }
}

/**
 * Best one-line cause for a failed run: the managed worker's log first (measured
 * to be the only place the real message lands), then the CLI's own stderr tail.
 */
export function describeHermesRunFailure(
  home: string,
  stderrTail: string,
  options: FailureDetailOptions = {},
): string | undefined {
  return readHermesLogFailureLine(home, options) ?? pickFailureLine(stderrTail);
}

/**
 * A failing stream-json `result` names a non-zero `exit_code` but frequently no
 * `error` (measured). Fill it in before the event is forwarded, so the banner —
 * which renders `error` — shows the cause instead of the exit code.
 */
export function attachHermesFailureDetail(
  event: unknown,
  home: string,
  options: FailureDetailOptions = {},
): unknown {
  if (!event || typeof event !== 'object') return event;
  const evt = event as { type?: unknown; exit_code?: unknown; is_error?: unknown; error?: unknown };
  if (evt.type !== 'result') return event;
  if (typeof evt.error === 'string' && evt.error.trim().length > 0) return event;
  const failed = evt.is_error === true || (typeof evt.exit_code === 'number' && evt.exit_code !== 0);
  if (!failed) return event;
  const detail = describeHermesRunFailure(home, '', options);
  return detail ? { ...evt, error: detail } : event;
}
