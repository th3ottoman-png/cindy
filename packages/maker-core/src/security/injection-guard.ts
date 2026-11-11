/**
 * Runtime guard for tool calls and tool results (ROADMAP 10.1).
 *
 * Why this exists: in Full access Cindy runs Hermes with `--yolo`, which bypasses Hermes's own
 * dangerous-command approvals, and `--safe-mode` (the only other guard) is not in play. Nothing
 * inspects a tool call before it executes, and nothing inspects what a tool returns before that
 * text re-enters the model's context.
 *
 * Design rules, learned the hard way from a draft that scored `cd … && pnpm typecheck` as
 * critical and `curl | sh` as harmless:
 *
 *  - **Never substring-match.** A shell command is tokenised first; a path or a variable is not a
 *    command. `result`, `issue`, `sudo` and `summary` must not be read as `su`.
 *  - **Score is `max(signal weights)`, not a sum.** Ordinary facts stacking up (a `&&`, a path with
 *    `key` in it, a long argument) must never add up to "critical"; one genuinely dangerous shape
 *    should, on its own.
 *  - **Weights are calibrated against a benign corpus** of commands this repo actually runs; see the
 *    test table. A signal earns a high weight only if it is dangerous *in isolation*.
 *  - **Two directions.** `scoreToolCall` looks at intent to act; `scoreToolResult` looks for text
 *    that tries to become instructions once it is back in context (override phrases, fake
 *    system/tool framing, embedded tool-call JSON, hidden characters).
 *  - Pure and dependency-free: no clock, no I/O, no network. The daemon decides what to do with the
 *    verdict (`decideGuardAction`), so this module is trivially testable and reproducible.
 */

export type GuardSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface GuardSignal {
  /** Stable id, used in the transcript and in tests. */
  id: string;
  /** 0…1; the verdict score is the maximum weight found. */
  weight: number;
  /** One line the owner can read in the transcript. */
  detail: string;
}

export interface GuardVerdict {
  /** `max(signal.weight)`, rounded to two decimals. 0 when nothing fired. */
  score: number;
  severity: GuardSeverity;
  signals: GuardSignal[];
  /** Empty string when nothing fired. */
  reason: string;
}

export interface GuardConfig {
  /** A verdict at or above this score is acted on. Goose's scale: 0.01 strict … 1.0 lenient. */
  threshold: number;
  /** What to do with a verdict at or above the threshold. `off` disables the guard entirely. */
  policy: 'off' | 'log' | 'hold' | 'block';
}

export type GuardAction = 'allow' | 'log' | 'hold' | 'block';

export const DEFAULT_GUARD_CONFIG: GuardConfig = { threshold: 0.8, policy: 'hold' };

export const EMPTY_VERDICT: GuardVerdict = { score: 0, severity: 'low', signals: [], reason: '' };

/** Files whose modification is almost never the user's intent in a chat turn. */
const PROTECTED_WRITE_PATHS = [
  /(?:^|[\s"'])~?\/?\.ssh\//,
  /(?:^|[\s"'])~?\/?\.aws\//,
  /(?:^|[\s"'])~?\/?\.gnupg\//,
  /\/\.hermes-cindy\/\.env\b/,
  /\/\.hermes-cindy\/config\.yaml\b/,
  /\/\.cindy-harness\/providers\.yaml\b/,
];

const SHELL_TOOLS = /^(?:shell|bash|shell_command|run_command|run_shell|terminal|exec|execute_command|command)$/i;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php']);
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'httpie', 'http']);

function verdictFrom(signals: GuardSignal[]): GuardVerdict {
  if (signals.length === 0) return EMPTY_VERDICT;
  const sorted = [...signals].sort((a, b) => b.weight - a.weight);
  const score = Math.round(sorted[0]!.weight * 100) / 100;
  const severity: GuardSeverity =
    score >= 0.8 ? 'critical' : score >= 0.6 ? 'high' : score >= 0.35 ? 'medium' : 'low';
  return {
    score,
    severity,
    signals: sorted,
    reason: sorted.map((s) => s.detail).join('; '),
  };
}

/** Flatten a tool argument payload into the string(s) worth looking at. */
function textLeaves(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((v) => textLeaves(v, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) => textLeaves(v, depth + 1));
  }
  return [];
}

/** Split a shell command into simple commands, respecting quotes. */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** First word of a segment, with any leading env assignment or sudo/env wrapper skipped. */
export function commandWord(segment: string): string {
  let rest = segment.trim();
  for (let guard = 0; guard < 6; guard += 1) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env|command|exec|time|nohup|-\S+)\s+/.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length);
  }
  return (/^[\w./-]+/.exec(rest)?.[0] ?? '').toLowerCase();
}

function signalsForShell(command: string): GuardSignal[] {
  const signals: GuardSignal[] = [];
  const segments = splitShellSegments(command);
  const words = segments.map(commandWord);

  // curl … | sh, wget … | bash — the canonical remote-code pattern.
  for (let i = 0; i < segments.length; i += 1) {
    const word = words[i]!;
    const next = words[i + 1];
    if (FETCHERS.has(word) && next && SHELLS.has(next)) {
      signals.push({
        id: 'fetch-pipe-to-shell',
        weight: 1,
        detail: `Downloads code and runs it (${word} … | ${next})`,
      });
    }
    if ((word === 'base64' || word === 'openssl') && next && SHELLS.has(next)) {
      signals.push({
        id: 'decode-pipe-to-shell',
        weight: 0.95,
        detail: 'Decodes an opaque payload and runs it',
      });
    }
    if (word === 'bash' || word === 'sh' || word === 'source' || word === '.') {
      if (segments[i]!.includes('<(curl') || segments[i]!.includes('<(wget')) {
        signals.push({ id: 'process-substitution-exec', weight: 0.95, detail: 'Runs a downloaded script via process substitution' });
      }
    }
    if (word === 'eval' && /curl|wget/.test(segments.join(' '))) {
      signals.push({ id: 'eval-fetched', weight: 0.95, detail: 'Evaluates downloaded text' });
    }
  }

  // Destructive filesystem/system operations, anchored to their real shapes.
  const whole = command.replace(/\s+/g, ' ');
  // `rm` is dangerous only when a *target token* is a whole path like / or ~ or $HOME — never
  // because a path happens to contain "rm" or the flags mention "--preserve-root".
  const destructiveTarget = /^(?:["']?)(?:\/|\/~|~|\$HOME|\$\{HOME\}|\*)(?:["']?)$/;
  const rmHitsRoot = segments.some((segment) => {
    if (commandWord(segment) !== 'rm') return false;
    return segment
      .split(/\s+/)
      .slice(1)
      .filter((token) => !token.startsWith('-'))
      .some((token) => destructiveTarget.test(token.replace(/["']/g, '"')));
  });
  if (rmHitsRoot) {
    signals.push({ id: 'rm-root-or-home', weight: 1, detail: 'Deletes the filesystem root, home or everything' });
  }
  if (/\bmkfs(?:\.\w+)?\b/.test(whole) || /\bdd\b[^|;]*\bof=\/dev\/[sh]d/.test(whole)) {
    signals.push({ id: 'disk-destroy', weight: 1, detail: 'Formats or overwrites a disk device' });
  }
  if (/\bchmod\s+-R\s+0?777\s+\/(?:\s|$)/.test(whole)) {
    signals.push({ id: 'chmod-root', weight: 0.9, detail: 'Makes the filesystem world-writable' });
  }
  if (/\bgit\s+push\b[^|;]*\s(?:--force|-f)\b/.test(whole) || /\bgit\s+push\b[^|;]*\s\+\w/.test(whole)) {
    signals.push({ id: 'git-force-push', weight: 0.7, detail: 'Force-pushes (rewrites remote history)' });
  }
  if (/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/.test(whole)) {
    signals.push({ id: 'fork-bomb', weight: 1, detail: 'Fork bomb' });
  }

  // Writing into credential/config locations.
  const writesToProtected = segments.some((segment) => {
    const word = commandWord(segment);
    const writes = /(?:^|\s)(?:>|>>|tee|cp|mv|install|ln|chmod|chown|sed\s+-i|rm)\b/.test(segment);
    if (!writes) return false;
    return PROTECTED_WRITE_PATHS.some((rx) => rx.test(segment)) && !/^\s*(?:cat|less|grep|rg|head|tail|wc|stat|ls)\b/.test(word);
  });
  if (writesToProtected) {
    signals.push({ id: 'write-protected-config', weight: 0.9, detail: 'Writes to a credential or harness config path' });
  }

  // Reading a secret and sending it out in the same command line.
  const readsSecret = /(?:\.ssh\/id_|\.hermes-cindy\/\.env|\.aws\/credentials|\.cindy-harness\/)/.test(whole);
  const sendsOut = /\b(?:curl|wget|nc|ncat|ssh|scp)\b|https?:\/\//.test(whole);
  if (readsSecret && sendsOut) {
    signals.push({ id: 'secret-exfil', weight: 0.95, detail: 'Reads a credential file and sends it over the network' });
  }

  return signals;
}

/** Signals that only make sense on text a tool returned. */
function signalsForResultText(text: string): GuardSignal[] {
  const signals: GuardSignal[] = [];
  const sample = text.slice(0, 20000);

  // A bare mention is documentation (this repo's own ROADMAP discusses the phrase), so it only
  // becomes dangerous when an action verb sits next to it — the shape of an actual hijack.
  const override = /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i;
  if (override.test(sample)) {
    const imperative =
      /\b(?:ignore|disregard)\b[^\n]{0,200}\b(?:and|then|instead)\b[^\n]{0,80}\b(?:run|execute|send|post|delete|remove|print|output|write|reveal|export|curl|wget)\b/i;
    signals.push(
      imperative.test(sample)
        ? { id: 'instruction-override-imperative', weight: 0.85, detail: 'Tool output tells the assistant to ignore its instructions and act' }
        : { id: 'instruction-override-quoted', weight: 0.55, detail: 'Tool output mentions an instruction-override phrase' },
    );
  }
  if (/\byou\s+are\s+(?:now|no longer)\b|\bnew\s+(?:system\s+prompt|instructions?:)\b|\bact\s+as\s+(?:the\s+)?(?:system|developer)\b/i.test(sample)) {
    signals.push({ id: 'role-reassignment', weight: 0.8, detail: 'Tool output tries to reassign the assistant’s role' });
  }
  const fakeFraming = /(?:^|\n)\s*(?:<\|?system\|?>|system\s*:|\[inst\]|###\s*instruction|assistant\s*:|tool\s*:)/i;
  if (fakeFraming.test(sample)) {
    signals.push({ id: 'fake-message-framing', weight: 0.65, detail: 'Tool output imitates a system/tool message' });
  }
  if (/"tool_calls"\s*:/.test(sample) || /"function_call"\s*:/.test(sample) || /<function_calls>/.test(sample)) {
    signals.push({ id: 'embedded-tool-call', weight: 0.75, detail: 'Tool output embeds a tool-call payload' });
  }
  if (/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/.test(sample)) {
    const hidden = (sample.match(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g) ?? []).length;
    if (hidden >= 3) {
      signals.push({ id: 'hidden-characters', weight: 0.6, detail: `Tool output hides ${hidden} zero-width/bidi characters` });
    }
  }
  if (/(?:send|post|upload|exfiltrate|transmit)[^\n]{0,80}(?:token|api[_ -]?key|password|secret|credential)[^\n]{0,40}(?:to|at)\s+https?:\/\//i.test(sample)) {
    signals.push({ id: 'exfil-instruction', weight: 0.85, detail: 'Tool output instructs sending credentials to a URL' });
  }
  return signals;
}

/** Score a tool call. `input` is the raw arguments payload (object or string). */
export function scoreToolCall(input: { tool: string; input?: unknown }): GuardVerdict {
  const tool = String(input?.tool ?? '');
  const leaves = textLeaves(input?.input);
  const signals: GuardSignal[] = [];

  // A shell-shaped tool: tokenise its command and look for real command shapes.
  if (SHELL_TOOLS.test(tool) || /command|shell|bash/i.test(tool)) {
    for (const leaf of leaves) signals.push(...signalsForShell(leaf));
  } else {
    // Non-shell tools: only anchored, unambiguous shapes. A path mentioning `key` is not a threat.
    for (const leaf of leaves) {
      if (/(?:^|\/)(?:\.ssh|\.aws|\.gnupg)\/(?:id_|credentials|config)/.test(leaf)) {
        signals.push({ id: 'credential-path-touched', weight: 0.5, detail: 'Tool targets a credential file' });
        break;
      }
    }
  }
  return verdictFrom(signals);
}

/** Score a tool result before its text re-enters the model's context. */
export function scoreToolResult(input: { tool: string; output?: unknown }): GuardVerdict {
  const texts = textLeaves(input?.output);
  const signals = texts.flatMap((text) => signalsForResultText(text));
  return verdictFrom(signals);
}

/** What the caller should do. Kept separate so policy can change without touching scoring. */
export function decideGuardAction(verdict: GuardVerdict, config: GuardConfig = DEFAULT_GUARD_CONFIG): GuardAction {
  if (config.policy === 'off') return 'allow';
  if (verdict.score <= 0) return 'allow';
  if (verdict.score < config.threshold) return config.policy === 'log' ? 'log' : 'allow';
  return config.policy;
}
