/**
 * Hermes `auto` permission mode, daemon side (ROADMAP 1.13b).
 *
 * Hermes 0.22.7 runs a `pre_tool_call` shell hook before every tool call and
 * blocks the call when the hook says so (probed live in 1.13a, STATUS
 * 2026-11-07). In `auto` the daemon:
 *
 *   1. writes one fail-closed `pre_tool_call` hook into the session's own
 *      home `config.yaml` (never the shared base config);
 *   2. runs the turn with `--yolo --accept-hooks` (no `--safe-mode`, which
 *      would ignore config and hooks alike);
 *   3. hands the hook a per-turn token and this gate's socket path through
 *      the spawn env (Hermes passes its env to hooks; nothing is written to
 *      disk);
 *   4. answers each hook request by asking the attached Cindy client
 *      (`approval/request` reverse-request). Anything but a clear `allow`
 *      blocks the call.
 *
 * The hook itself is the daemon bundle run as `--auto-review-hook`
 * (runAutoReviewHook below), so packaging ships nothing new.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';

export const AUTO_REVIEW_SOCKET_ENV = 'CINDY_HERMES_REVIEW_SOCKET';
export const AUTO_REVIEW_TOKEN_ENV = 'CINDY_HERMES_REVIEW_TOKEN';
export const AUTO_REVIEW_HOOK_FLAG = '--auto-review-hook';

/** Hermes caps a shell hook at 300 s; the owner may need most of that to answer a prompt. */
export const AUTO_REVIEW_HOOK_TIMEOUT_SECONDS = 300;
/** The daemon gives up on the client before Hermes gives up on the hook. */
export const AUTO_REVIEW_CLIENT_TIMEOUT_MS = 285_000;
/** The hook gives up on the daemon just after the daemon gives up on the client. */
export const AUTO_REVIEW_HOOK_SOCKET_TIMEOUT_MS = 292_000;
const MAX_REQUEST_BYTES = 1_000_000;

export interface AutoReviewHookPayload {
  toolName: string;
  toolInput: unknown;
  toolCallId?: string;
  hermesSessionId?: string;
}

export interface AutoReviewVerdict {
  decision: 'allow' | 'block';
  reason?: string;
}

/** Single-quote a word for Python's shlex.split (Hermes splits `command` with it). */
export function shlexQuote(word: string): string {
  return `'${word.replace(/'/g, `'"'"'`)}'`;
}

export function buildAutoReviewHookCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('auto-review hook command is empty');
  return argv.map(shlexQuote).join(' ');
}

function yamlDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Adds Cindy's `pre_tool_call` hook to a Hermes `config.yaml` text, keeping
 * every other byte. An existing top-level `hooks:` block is extended (owner
 * hooks still run; Hermes lets any block win); a `hooks:` key with an inline
 * value cannot be extended safely, so it throws and the turn fails closed.
 */
export function injectAutoReviewHook(configYaml: string, command: string): string {
  const eol = configYaml.includes('\r\n') ? '\r\n' : '\n';
  const entry = (indent: string): string[] => [
    `${indent}- matcher: ".*"`,
    `${indent}  command: ${yamlDoubleQuote(command)}`,
    `${indent}  timeout: ${AUTO_REVIEW_HOOK_TIMEOUT_SECONDS}`,
    `${indent}  fail_closed: true`,
  ];
  const lines = configYaml.length > 0 ? configYaml.split(/\r?\n/) : [];
  const hooksAt = lines.findIndex((line) => /^hooks\s*:/.test(line));
  if (hooksAt === -1) {
    const body = configYaml.length === 0 || configYaml.endsWith('\n') ? configYaml : `${configYaml}${eol}`;
    return `${body}${['hooks:', '  pre_tool_call:', ...entry('    ')].join(eol)}${eol}`;
  }
  const rest = lines[hooksAt]!.replace(/^hooks\s*:/, '').trim();
  if (rest && !rest.startsWith('#')) {
    throw new Error('config.yaml has an inline `hooks:` value; Cindy auto-review cannot add its hook');
  }
  let end = lines.length;
  for (let i = hooksAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length === 0) {
      end = i;
      break;
    }
  }
  const eventAt = lines.findIndex(
    (line, i) => i > hooksAt && i < end && /^\s+pre_tool_call\s*:/.test(line),
  );
  if (eventAt === -1) {
    lines.splice(hooksAt + 1, 0, '  pre_tool_call:', ...entry('    '));
  } else {
    const eventLine = lines[eventAt]!;
    const eventRest = eventLine.replace(/^\s+pre_tool_call\s*:/, '').trim();
    if (eventRest && !eventRest.startsWith('#')) {
      throw new Error('config.yaml has an inline `hooks.pre_tool_call` value; Cindy auto-review cannot add its hook');
    }
    const eventIndent = eventLine.length - eventLine.trimStart().length;
    lines.splice(eventAt + 1, 0, ...entry(' '.repeat(eventIndent + 2)));
  }
  return lines.join(eol);
}

/** Pulls the fields Cindy needs from Hermes's hook stdin (shape probed in 1.13a). */
export function parseHookPayload(raw: unknown): AutoReviewHookPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.hook_event_name !== undefined && p.hook_event_name !== 'pre_tool_call') return null;
  if (typeof p.tool_name !== 'string' || !p.tool_name) return null;
  const extra = p.extra && typeof p.extra === 'object' ? (p.extra as Record<string, unknown>) : {};
  return {
    toolName: p.tool_name,
    toolInput: p.tool_input ?? {},
    ...(typeof extra.tool_call_id === 'string' ? { toolCallId: extra.tool_call_id } : {}),
    ...(typeof p.session_id === 'string' ? { hermesSessionId: p.session_id } : {}),
  };
}

export function normalizeVerdict(value: unknown): AutoReviewVerdict {
  if (value && typeof value === 'object') {
    const v = value as { decision?: unknown; reason?: unknown };
    const reason = typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim().slice(0, 2000) : undefined;
    if (v.decision === 'allow') return { decision: 'allow' };
    if (v.decision === 'block') return { decision: 'block', ...(reason ? { reason } : {}) };
  }
  return { decision: 'block', reason: 'Cindy auto-review returned no valid decision.' };
}

export type AutoReviewHandler = (sessionId: string, payload: AutoReviewHookPayload) => Promise<AutoReviewVerdict>;

export interface AutoReviewGateOptions {
  socketPath: string;
  handler: AutoReviewHandler;
}

/** Unix-socket endpoint the hook calls: one JSON line in, one JSON line out. */
export class AutoReviewGate {
  private readonly server: net.Server;
  private readonly tokens = new Map<string, string>();
  private started = false;

  constructor(private readonly opts: AutoReviewGateOptions) {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await fs.rm(this.opts.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    await fs.chmod(this.opts.socketPath, 0o600).catch(() => {});
    this.started = true;
  }

  async stop(): Promise<void> {
    this.tokens.clear();
    if (!this.started) return;
    this.started = false;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await fs.rm(this.opts.socketPath, { force: true }).catch(() => {});
  }

  /** One token per turn; the env for the spawned `hermes chat`. */
  registerTurn(sessionId: string): { token: string; env: Record<string, string> } {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, sessionId);
    return {
      token,
      env: { [AUTO_REVIEW_SOCKET_ENV]: this.opts.socketPath, [AUTO_REVIEW_TOKEN_ENV]: token },
    };
  }

  unregisterTurn(token: string): void {
    this.tokens.delete(token);
  }

  private onConnection(socket: net.Socket): void {
    let buf = '';
    let done = false;
    const reply = (verdict: AutoReviewVerdict): void => {
      if (done) return;
      done = true;
      if (!socket.destroyed) socket.end(`${JSON.stringify(verdict)}\n`);
    };
    socket.setEncoding('utf8');
    socket.on('error', () => {
      done = true;
    });
    socket.on('data', (chunk: string) => {
      if (done) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        reply({ decision: 'block', reason: 'Tool call too large for Cindy auto-review.' });
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      void this.answer(line).then(reply, () =>
        reply({ decision: 'block', reason: 'Cindy auto-review failed.' }),
      );
    });
  }

  private async answer(line: string): Promise<AutoReviewVerdict> {
    let msg: { token?: unknown; payload?: unknown };
    try {
      msg = JSON.parse(line) as { token?: unknown; payload?: unknown };
    } catch {
      return { decision: 'block', reason: 'Malformed auto-review request.' };
    }
    const sessionId = typeof msg.token === 'string' ? this.tokens.get(msg.token) : undefined;
    if (!sessionId) return { decision: 'block', reason: 'This Hermes turn is not registered with Cindy auto-review.' };
    const payload = parseHookPayload(msg.payload);
    if (!payload) return { decision: 'block', reason: 'Unreadable tool call for Cindy auto-review.' };
    return normalizeVerdict(await this.opts.handler(sessionId, payload));
  }
}

function blockOutput(reason: string): string {
  return JSON.stringify({ decision: 'block', reason });
}

export interface RunHookIo {
  readStdin(): Promise<string>;
  env: NodeJS.ProcessEnv;
  connect?: (socketPath: string) => net.Socket;
  socketTimeoutMs?: number;
}

/**
 * The hook process: Hermes pipes the payload in; we print `{}` (allow) or a
 * block directive. Exit code 2 blocks even if stdout is lost. Every failure
 * blocks (the config entry is also `fail_closed: true`).
 */
export async function runAutoReviewHook(io: RunHookIo): Promise<{ stdout: string; exitCode: number }> {
  const socketPath = io.env[AUTO_REVIEW_SOCKET_ENV];
  const token = io.env[AUTO_REVIEW_TOKEN_ENV];
  if (!socketPath || !token) {
    return { stdout: blockOutput('Cindy auto-review is not connected to this Hermes run.'), exitCode: 2 };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await io.readStdin());
  } catch {
    return { stdout: blockOutput('Cindy auto-review could not read the tool call.'), exitCode: 2 };
  }
  const verdict = await new Promise<AutoReviewVerdict>((resolve) => {
    const socket = (io.connect ?? ((p: string) => net.createConnection(p)))(socketPath);
    let buf = '';
    let settled = false;
    const finish = (v: AutoReviewVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(
      () => finish({ decision: 'block', reason: 'Cindy auto-review timed out.' }),
      io.socketTimeoutMs ?? AUTO_REVIEW_HOOK_SOCKET_TIMEOUT_MS,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, payload })}\n`));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        finish(normalizeVerdict(JSON.parse(buf.slice(0, nl))));
      } catch {
        finish({ decision: 'block', reason: 'Cindy auto-review sent an unreadable answer.' });
      }
    });
    socket.on('error', () => finish({ decision: 'block', reason: 'Cindy auto-review is unreachable.' }));
    socket.on('close', () => finish({ decision: 'block', reason: 'Cindy auto-review closed without an answer.' }));
  });
  if (verdict.decision === 'allow') return { stdout: '{}', exitCode: 0 };
  return { stdout: blockOutput(verdict.reason ?? 'Blocked by Cindy auto-review.'), exitCode: 2 };
}
