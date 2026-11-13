/**
 * Daemon stderr → desktop log (ROADMAP §Debt: diagnostics for a failed Hermes launch).
 *
 * The hermes-mgr daemon writes its WARN/ERROR lines to stderr. The client drains
 * that pipe (an unread pipe would block the daemon at 64 KB) and keeps only the
 * last 2 KB for a startup failure message, so a WARN emitted mid-session — the
 * one that says which argv died and why — was previously thrown away.
 *
 * Only the daemon's own `[hermes-mgr][warn]` / `[hermes-mgr][error]` markers are
 * forwarded: they are few, and they are the lines the owner greps for.
 */

/** Markers the daemon's logger writes (packages/maker-hermes-manager/src/bin/hermes-mgr.ts). */
const REPORTABLE = /^\[hermes-mgr\]\[(?:warn|error)\]/;

/** One log record, bounded: a stack trace must not become a whole log entry. */
const MAX_LINE_CHARS = 4_000;

/** True when a daemon stderr line is a WARN/ERROR the desktop log should keep. */
export function isReportableDaemonLogLine(line: string): boolean {
  return REPORTABLE.test(line.trim());
}

/** Split a growing buffer into complete lines; the unterminated tail is returned. */
export function drainDaemonLogLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => line.replace(/\r$/, '')), rest };
}

/**
 * Build the chunk handler to attach to the daemon's stderr stream. `emit` receives
 * only reportable lines, already trimmed and bounded.
 */
export function createDaemonLogForwarder(emit: (line: string) => void): (chunk: string | Buffer) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    const { lines, rest } = drainDaemonLogLines(buffer);
    buffer = rest.length > MAX_LINE_CHARS ? rest.slice(-MAX_LINE_CHARS) : rest;
    for (const line of lines) {
      if (!isReportableDaemonLogLine(line)) continue;
      emit(line.trim().slice(0, MAX_LINE_CHARS));
    }
  };
}
