/**
 * ROADMAP 13.10b: read a shell timeout out of a tool result so the tool row can say the limit was
 * hit without re-rendering or rewriting the result.
 *
 * Probed on Hermes 0.23.0 (ROADMAP 13.10a, docs/evidence/13.10a-shell-limits-probe.md):
 * - a command killed by `terminal.timeout` comes back as `[Command timed out after Ns]` with exit
 *   code 124 (`tools/environments/base.py:770`);
 * - the backend-error path that never reached a command renders
 *   `Command timed out after N seconds` (`tools/terminal_tool.py:1383`).
 *
 * Both are matched here. Nothing is rewritten: this only annotates.
 */

export interface ShellTimeoutNotice {
  /** Whole seconds Hermes reported. */
  seconds: number;
}

const BRACKET_MARKER = /\[Command timed out after (\d+)s\]/;
const ERROR_SENTENCE = /Command timed out after (\d+) seconds/;

function toNotice(match: RegExpMatchArray | null): ShellTimeoutNotice | null {
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return { seconds };
}

/** Null when the result carries no timeout marker. Accepts the raw string or a structured result. */
export function parseShellTimeoutNotice(result: unknown): ShellTimeoutNotice | null {
  let text: string;
  if (typeof result === 'string') text = result;
  else if (result === null || result === undefined) return null;
  else {
    try {
      text = JSON.stringify(result);
    } catch {
      return null;
    }
  }
  if (!text.includes('Command timed out after')) return null;
  return toNotice(BRACKET_MARKER.exec(text)) ?? toNotice(ERROR_SENTENCE.exec(text));
}

/** The badge text: `stopped at 5 s`. */
export function shellTimeoutLabel(notice: ShellTimeoutNotice): string {
  return `stopped at ${notice.seconds} s`;
}
