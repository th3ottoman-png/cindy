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
 *   3. hands the hook this gate's socket path and a per-session token
 *      through a 0600 file in the session home, named on the hook's command
 *      line (`--credentials`). The spawn env is NOT enough: `hermes chat` runs
 *      tools inside the session's long-lived gateway, whose env is whatever it
 *      started with (found live in 1.13d);
 *   4. answers each hook request by asking the attached Cindy client
 *      (`approval/request` reverse-request). Anything but a clear `allow`
 *      blocks the call.
 *
 * The hook itself is the daemon bundle run as `--auto-review-hook`
 * (runAutoReviewHook below), so packaging ships nothing new.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as net from 'node:net';

import { repairToolCallArguments } from './tool-call-repair.js';

export const AUTO_REVIEW_SOCKET_ENV = 'CINDY_HERMES_REVIEW_SOCKET';
export const AUTO_REVIEW_TOKEN_ENV = 'CINDY_HERMES_REVIEW_TOKEN';
export const AUTO_REVIEW_HOOK_FLAG = '--auto-review-hook';
export const AUTO_REVIEW_CREDENTIALS_FLAG = '--credentials';
export const AUTO_REVIEW_CREDENTIALS_FILE = 'auto-review.json';

/**
 * Hermes 0.22.7 stops waiting for a `pre_tool_call` callback after ~30 s, whatever the
 * entry's `timeout` says, and refuses every later tool call while one is still running
 * (found live, ROADMAP 1.13f). So every hook answer must arrive well inside 30 s.
 */
export const AUTO_REVIEW_HOOK_TIMEOUT_SECONDS = 30;
/**
 * How long one review (reviewer + the owner's answer to a card) may stay open in the
 * daemon. It outlives the hook: a call still open when the hook must answer is blocked
 * with HOLD_REASON, and the owner's later `allow` is kept as a one-time grant (ReviewHold).
 */
export const AUTO_REVIEW_CLIENT_TIMEOUT_MS = 285_000;
/** The daemon answers the hook within this, so the hook (and Hermes) never wait longer. */
export const AUTO_REVIEW_HOOK_HOLD_MS = 24_000;
/** The hook gives up on the daemon just after the daemon must have answered. */
export const AUTO_REVIEW_HOOK_SOCKET_TIMEOUT_MS = 27_000;
/** A grant for an owner-allowed call that missed its hook answer lives this long. */
export const AUTO_REVIEW_GRANT_TTL_MS = 10 * 60_000;
export const AUTO_REVIEW_HOLD_REASON =
  'Waiting for the owner to approve this call in Cindy. It did not run. '
  + 'Retry this exact call unchanged now; it runs once the owner allows it.';
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

/** The hook command of one session: the shared argv plus that session's credentials file. */
export function buildSessionHookCommand(argv: readonly string[], credentialsFile: string): string {
  return buildAutoReviewHookCommand([...argv, AUTO_REVIEW_CREDENTIALS_FLAG, credentialsFile]);
}

/** Atomic 0600 write of the socket path + token the hook of one session reads. */
export async function writeHookCredentials(
  file: string,
  creds: { socketPath: string; token: string },
): Promise<void> {
  const tmp = nodePath.join(nodePath.dirname(file), `.${nodePath.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ socketPath: creds.socketPath, token: creds.token }), { mode: 0o600 });
  await fs.rename(tmp, file);
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
    toolInput: repairToolCallArguments(p.tool_input ?? {}),
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

/** Stable JSON (sorted object keys) so the same call always gets the same key. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** One tool call of one session, ignoring the per-attempt tool_call_id. */
export function reviewKey(sessionId: string, payload: AutoReviewHookPayload): string {
  return `${sessionId}\u0000${payload.toolName}\u0000${stableJson(payload.toolInput)}`;
}

interface ReviewHoldOptions {
  holdMs?: number;
  grantTtlMs?: number;
  now?: () => number;
}

/**
 * Keeps a review open past the hook's short answer window (ROADMAP 1.13f).
 *
 * - A call with an unused grant (the owner allowed it after its hook had to answer)
 *   is allowed at once, and the grant is used up.
 * - A call whose review is still open waits on that same review (no second card).
 * - Otherwise a new review starts.
 * If the review has not finished within `holdMs`, the call is blocked with
 * AUTO_REVIEW_HOLD_REASON; when that review later ends in `allow`, a one-time grant
 * for exactly this call is stored for `grantTtlMs`. A later `block` stores nothing.
 */
export class ReviewHold {
  private readonly open = new Map<string, Promise<AutoReviewVerdict>>();
  private readonly grants = new Map<string, number>();
  private readonly holdMs: number;
  private readonly grantTtlMs: number;
  private readonly now: () => number;

  constructor(opts: ReviewHoldOptions = {}) {
    this.holdMs = opts.holdMs ?? AUTO_REVIEW_HOOK_HOLD_MS;
    this.grantTtlMs = opts.grantTtlMs ?? AUTO_REVIEW_GRANT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async review(key: string, start: () => Promise<AutoReviewVerdict>): Promise<AutoReviewVerdict> {
    const grantedUntil = this.grants.get(key);
    if (grantedUntil !== undefined) {
      this.grants.delete(key);
      if (grantedUntil > this.now()) return { decision: 'allow' };
    }
    let pending = this.open.get(key);
    if (!pending) {
      pending = start().then(normalizeVerdict, () => ({
        decision: 'block' as const,
        reason: 'Cindy auto-review failed.',
      }));
      this.open.set(key, pending);
      void pending.then((verdict) => {
        this.open.delete(key);
        if (verdict.decision === 'allow' && this.heldOver.has(pending!)) {
          this.grants.set(key, this.now() + this.grantTtlMs);
        }
        this.heldOver.delete(pending!);
      });
    }
    const current = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        // Marked here, before anything can resolve `current` later, so a late allow is never lost.
        this.heldOver.add(current);
        resolve(null);
      }, this.holdMs);
    });
    const first = await Promise.race([current, held]);
    clearTimeout(timer);
    if (first) {
      // A retry that receives the late allow itself uses up the grant that allow just stored.
      if (first.decision === 'allow') this.grants.delete(key);
      return first;
    }
    return { decision: 'block', reason: AUTO_REVIEW_HOLD_REASON };
  }

  /** Reviews that outlived at least one hook answer; only their `allow` becomes a grant. */
  private readonly heldOver = new WeakSet<Promise<AutoReviewVerdict>>();
}

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
  /** Per-session credentials file from the hook command line (`--credentials`). */
  credentialsFile?: string;
  connect?: (socketPath: string) => net.Socket;
  socketTimeoutMs?: number;
}

/**
 * The hook process: Hermes pipes the payload in; we print `{}` (allow) or a
 * block directive. Exit code 2 blocks even if stdout is lost. Every failure
 * blocks (the config entry is also `fail_closed: true`).
 */
export async function runAutoReviewHook(io: RunHookIo): Promise<{ stdout: string; exitCode: number }> {
  let socketPath = io.env[AUTO_REVIEW_SOCKET_ENV];
  let token = io.env[AUTO_REVIEW_TOKEN_ENV];
  if (io.credentialsFile) {
    try {
      const creds = JSON.parse(await fs.readFile(io.credentialsFile, 'utf8')) as { socketPath?: unknown; token?: unknown };
      if (typeof creds.socketPath === 'string' && typeof creds.token === 'string') {
        socketPath = creds.socketPath;
        token = creds.token;
      }
    } catch {
      /* fall back to the env; no usable credentials blocks below */
    }
  }
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
