import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTO_REVIEW_SOCKET_ENV,
  AUTO_REVIEW_TOKEN_ENV,
  AutoReviewGate,
  buildAutoReviewHookCommand,
  injectAutoReviewHook,
  normalizeVerdict,
  parseHookPayload,
  runAutoReviewHook,
  shlexQuote,
  type AutoReviewHookPayload,
} from '../auto-review-gate.js';
import { RpcClient } from '../client.js';
import { HermesManager } from '../hermes-manager.js';
import { permissionModeToFlags } from '../hermes-run.js';
import { METHODS, NOTIFICATIONS, SERVER_METHODS, type ApprovalRequestParams, type RpcNotification } from '../protocol.js';
import { sessionHomePath } from '../session-home.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));
const CMD = buildAutoReviewHookCommand(['node', '/x y/hermes-mgr.mjs', '--auto-review-hook']);

const tmpDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
function tmpDir(): string {
  // Short base: unix socket paths are limited to ~104 bytes on macOS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  delete process.env.FAKE_RECORD_ENV;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const payload = (tool = 'terminal', input: unknown = { command: 'ls' }): Record<string, unknown> => ({
  hook_event_name: 'pre_tool_call',
  tool_name: tool,
  tool_input: input,
  session_id: 'local-abc',
  cwd: '/opt/hermes',
  profile: 'default',
  extra: { task_id: 'local-abc', tool_call_id: 'call_1' },
});

describe('permission flags', () => {
  it('maps auto to --yolo --accept-hooks and keeps the other modes', () => {
    expect(permissionModeToFlags('auto')).toEqual(['--yolo', '--accept-hooks']);
    // ROADMAP 10.1: Full access keeps no prompts, but accepts hooks so the security guard can
    // score a tool call before Hermes runs it.
    expect(permissionModeToFlags('bypassPermissions')).toEqual(['--yolo', '--accept-hooks']);
    expect(permissionModeToFlags('default')).toEqual(['--safe-mode']);
    expect(permissionModeToFlags(undefined)).toEqual(['--safe-mode']);
  });
});

describe('hook command and config injection', () => {
  it('quotes every word for shlex, including spaces and single quotes', () => {
    expect(shlexQuote("a b'c")).toBe(`'a b'"'"'c'`);
    expect(CMD).toBe(`'node' '/x y/hermes-mgr.mjs' '--auto-review-hook'`);
  });

  it('appends a fail-closed pre_tool_call hook when the config has no hooks block', () => {
    const out = injectAutoReviewHook('model:\n  default: m\n', CMD);
    expect(out.startsWith('model:\n  default: m\n')).toBe(true);
    expect(out).toContain('hooks:\n  pre_tool_call:\n    - matcher: ".*"\n');
    expect(out).toContain(`      command: "${CMD}"\n`);
    expect(out).toContain('      timeout: 30\n      fail_closed: true\n');
  });

  it('handles an empty config and one without a trailing newline', () => {
    expect(injectAutoReviewHook('', CMD).startsWith('hooks:\n')).toBe(true);
    expect(injectAutoReviewHook('a: 1', CMD).startsWith('a: 1\nhooks:\n')).toBe(true);
  });

  it('extends an owner hooks block and keeps the owner hooks and other keys', () => {
    const base = 'hooks:\n  post_tool_call:\n    - command: "/bin/true"\nother: 1\n';
    const out = injectAutoReviewHook(base, CMD);
    expect(out).toContain('hooks:\n  pre_tool_call:\n    - matcher: ".*"');
    expect(out).toContain('  post_tool_call:\n    - command: "/bin/true"\nother: 1\n');
  });

  it('puts Cindy first inside an existing pre_tool_call list', () => {
    const base = 'hooks:\n  pre_tool_call:\n    - command: "/owner.sh"\n';
    const out = injectAutoReviewHook(base, CMD);
    expect(out.indexOf(CMD)).toBeLessThan(out.indexOf('/owner.sh'));
    expect(out).toContain('  pre_tool_call:\n    - matcher: ".*"');
  });

  it('refuses inline hooks values it cannot extend', () => {
    expect(() => injectAutoReviewHook('hooks: {}\n', CMD)).toThrow(/inline/);
    expect(() => injectAutoReviewHook('hooks:\n  pre_tool_call: []\n', CMD)).toThrow(/inline/);
  });
});

describe('payload and verdict parsing', () => {
  it('reads the hook stdin shape probed in 1.13a', () => {
    expect(parseHookPayload(payload())).toEqual({
      toolName: 'terminal',
      toolInput: { command: 'ls' },
      toolCallId: 'call_1',
      hermesSessionId: 'local-abc',
    });
    expect(parseHookPayload({ ...payload(), hook_event_name: 'post_tool_call' })).toBeNull();
    expect(parseHookPayload({ tool_input: {} })).toBeNull();
    expect(parseHookPayload('x')).toBeNull();
  });

  it('only a literal allow allows', () => {
    expect(normalizeVerdict({ decision: 'allow', reason: 'x' })).toEqual({ decision: 'allow' });
    expect(normalizeVerdict({ decision: 'block', reason: ' no ' })).toEqual({ decision: 'block', reason: 'no' });
    expect(normalizeVerdict({ decision: 'yes' }).decision).toBe('block');
    expect(normalizeVerdict(null).decision).toBe('block');
  });
});

async function startGate(
  handler: (sessionId: string, p: AutoReviewHookPayload) => Promise<{ decision: 'allow' | 'block'; reason?: string }>,
): Promise<AutoReviewGate> {
  const gate = new AutoReviewGate({ socketPath: path.join(tmpDir(), 'g.sock'), handler });
  await gate.start();
  cleanups.push(() => gate.stop());
  return gate;
}

function hookWith(env: Record<string, string | undefined>, stdin: string, socketTimeoutMs?: number) {
  return runAutoReviewHook({
    readStdin: async () => stdin,
    env,
    ...(socketTimeoutMs !== undefined ? { socketTimeoutMs } : {}),
  });
}

describe('gate + hook process', () => {
  it('allows when the handler allows, and the handler sees the session and tool', async () => {
    const seen: Array<[string, AutoReviewHookPayload]> = [];
    const gate = await startGate(async (sid, p) => {
      seen.push([sid, p]);
      return { decision: 'allow' };
    });
    const turn = gate.registerTurn('cindy-1');
    const out = await hookWith(turn.env, JSON.stringify(payload('read_file', { path: 'a.txt' })));
    expect(out).toEqual({ stdout: '{}', exitCode: 0 });
    expect(seen).toEqual([['cindy-1', expect.objectContaining({ toolName: 'read_file', toolInput: { path: 'a.txt' } })]]);
  });

  it('blocks with the reviewer reason and exit 2', async () => {
    const gate = await startGate(async () => ({ decision: 'block', reason: 'outside the project' }));
    const out = await hookWith(gate.registerTurn('s').env, JSON.stringify(payload()));
    expect(out.exitCode).toBe(2);
    expect(JSON.parse(out.stdout)).toEqual({ decision: 'block', reason: 'outside the project' });
  });

  it('blocks an unknown or revoked token without asking the handler', async () => {
    let calls = 0;
    const gate = await startGate(async () => {
      calls++;
      return { decision: 'allow' };
    });
    const turn = gate.registerTurn('s');
    gate.unregisterTurn(turn.token);
    const out = await hookWith(turn.env, JSON.stringify(payload()));
    expect(out.exitCode).toBe(2);
    expect(JSON.parse(out.stdout).reason).toMatch(/not registered/);
    expect(calls).toBe(0);
  });

  it('blocks when the handler throws', async () => {
    const gate = await startGate(async () => {
      throw new Error('boom');
    });
    const out = await hookWith(gate.registerTurn('s').env, JSON.stringify(payload()));
    expect(out.exitCode).toBe(2);
  });

  it('blocks with no env, unreadable stdin, an unreachable socket, or a silent gate', async () => {
    expect((await hookWith({}, JSON.stringify(payload()))).exitCode).toBe(2);
    expect(
      (await hookWith({ [AUTO_REVIEW_SOCKET_ENV]: '/nope.sock', [AUTO_REVIEW_TOKEN_ENV]: 't' }, '{not json')).exitCode,
    ).toBe(2);
    const missing = await hookWith(
      { [AUTO_REVIEW_SOCKET_ENV]: path.join(tmpDir(), 'none.sock'), [AUTO_REVIEW_TOKEN_ENV]: 't' },
      JSON.stringify(payload()),
    );
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout).reason).toMatch(/unreachable/);
    const gate = await startGate(() => new Promise(() => {}));
    const slow = await hookWith(gate.registerTurn('s').env, JSON.stringify(payload()), 150);
    expect(slow.exitCode).toBe(2);
    expect(JSON.parse(slow.stdout).reason).toMatch(/timed out/);
  });
});

interface Spawn {
  home: string | null;
  argv: string[];
  reviewSocket: string | null;
  reviewToken: string | null;
}

async function startDaemon(opts: { hook: boolean; sessionHomes: boolean }) {
  const dir = tmpDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: fake/m\n  provider: fake\n');
  const envLog = path.join(dir, 'spawns.ndjson');
  process.env.FAKE_RECORD_ENV = envLog;
  const socketPath = path.join(dir, 'm.sock');
  const manager = new HermesManager({
    socketPath,
    hermesHome: home,
    hermesBin: process.execPath,
    hermesExtraArgs: [FIXTURE],
    registryFile: path.join(home, 'hermes-mgr', 'sessions.json'),
    ...(opts.sessionHomes ? { sessionHomes: { prewarmGateway: false } } : {}),
    ...(opts.hook ? { autoReviewHookArgv: ['node', '/x y/hermes-mgr.mjs', '--auto-review-hook'] } : {}),
    // ROADMAP 10.1: the guard is armed by default in production (policy `hold`). These tests are
    // about the Auto-review gate itself, so they run with it off — the guard has its own tests.
    securityGuardConfig: () => ({ threshold: 0.8, policy: 'off' }),
  });
  await manager.start();
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  const notes: RpcNotification[] = [];
  const client = new RpcClient(socket, { onNotification: (n) => notes.push(n) });
  await client.hello({ timeoutMs: 5_000 });
  cleanups.push(async () => {
    await manager.stop();
    client.dispose();
  });
  const spawns = (): Spawn[] =>
    fs.existsSync(envLog)
      ? fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Spawn)
      : [];
  return { manager, client, socket, notes, dir, home, spawns };
}

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('HermesManager auto mode (fake hermes)', () => {
  it('refuses an auto turn when the daemon has no hook', async () => {
    const d = await startDaemon({ hook: false, sessionHomes: true });
    await d.client.request(METHODS.QUERY_START, { sessionId: 'a', cwd: d.dir, permissionMode: 'auto' }, { timeoutMs: 5_000 });
    await expect(
      d.client.request(METHODS.QUERY_SEND, { sessionId: 'a', text: 'hi' }, { timeoutMs: 5_000 }),
    ).rejects.toThrow(/Auto-review is not available/);
    expect(d.spawns()).toHaveLength(0);
  });

  it('refuses an auto turn without per-session homes', async () => {
    const d = await startDaemon({ hook: true, sessionHomes: false });
    await d.client.request(METHODS.QUERY_START, { sessionId: 'a', cwd: d.dir, permissionMode: 'auto' }, { timeoutMs: 5_000 });
    await expect(
      d.client.request(METHODS.QUERY_SEND, { sessionId: 'a', text: 'hi' }, { timeoutMs: 5_000 }),
    ).rejects.toThrow(/Auto-review is not available/);
  });

  it('runs auto with --yolo --accept-hooks, the hook in the session home only, and a working review round-trip', async () => {
    const d = await startDaemon({ hook: true, sessionHomes: true });
    const asked: ApprovalRequestParams[] = [];
    d.client.setRequestHandler(SERVER_METHODS.APPROVAL_REQUEST, async (params) => {
      const p = params as ApprovalRequestParams;
      asked.push(p);
      return p.input?.command === 'rm -rf /'
        ? { kind: 'permission', behavior: 'deny', reason: 'destructive' }
        : { kind: 'permission', behavior: 'allow' };
    });
    await d.client.request(METHODS.QUERY_START, { sessionId: 'a', cwd: d.dir, permissionMode: 'auto' }, { timeoutMs: 5_000 });
    await d.client.request(METHODS.SESSION_ATTACH, { sessionId: 'a' }, { timeoutMs: 5_000 });
    await d.client.request(METHODS.QUERY_SEND, { sessionId: 'a', text: 'hi' }, { timeoutMs: 5_000 });
    await until(() => d.notes.some((n) => n.method === NOTIFICATIONS.SESSION_CLOSED));

    const [spawn] = d.spawns();
    expect(spawn.argv).toEqual(expect.arrayContaining(['--yolo', '--accept-hooks']));
    expect(spawn.argv).not.toContain('--safe-mode');
    expect(spawn.home).toBe(sessionHomePath(d.home, 'a'));
    const sessionConfig = fs.readFileSync(path.join(spawn.home!, 'config.yaml'), 'utf8');
    expect(sessionConfig).toContain('fail_closed: true');
    expect(sessionConfig).toContain('--auto-review-hook');
    // The shared base config is never touched.
    expect(fs.readFileSync(path.join(d.home, 'config.yaml'), 'utf8')).not.toContain('hooks:');
    expect(spawn.reviewSocket).toBeTruthy();
    expect(spawn.reviewToken).toMatch(/^[0-9a-f]{64}$/);

    // Act as Hermes's hook with the env this run got.
    const env = { [AUTO_REVIEW_SOCKET_ENV]: spawn.reviewSocket!, [AUTO_REVIEW_TOKEN_ENV]: spawn.reviewToken! };
    expect(await hookWith(env, JSON.stringify(payload('terminal', { command: 'ls' })))).toEqual({ stdout: '{}', exitCode: 0 });
    const blocked = await hookWith(env, JSON.stringify(payload('terminal', { command: 'rm -rf /' })));
    expect(blocked.exitCode).toBe(2);
    expect(JSON.parse(blocked.stdout).reason).toBe('destructive');
    expect(asked.map((a) => [a.sessionId, a.kind, a.toolName, a.requestId])).toEqual([
      ['a', 'permission', 'terminal', 'call_1'],
      ['a', 'permission', 'terminal', 'call_1'],
    ]);
  });

  it('reaches the review through the session home credentials file when the hook has no env (gateway, ROADMAP 1.13d)', async () => {
    const d = await startDaemon({ hook: true, sessionHomes: true });
    d.client.setRequestHandler(SERVER_METHODS.APPROVAL_REQUEST, async (params) => ({
      kind: 'permission',
      behavior: (params as ApprovalRequestParams).input?.command === 'rm -rf /' ? 'deny' : 'allow',
      reason: 'destructive',
    }));
    await d.client.request(METHODS.QUERY_START, { sessionId: 'g', cwd: d.dir, permissionMode: 'auto' }, { timeoutMs: 5_000 });
    await d.client.request(METHODS.SESSION_ATTACH, { sessionId: 'g' }, { timeoutMs: 5_000 });
    await d.client.request(METHODS.QUERY_SEND, { sessionId: 'g', text: 'hi' }, { timeoutMs: 5_000 });
    await until(() => d.notes.some((n) => n.method === NOTIFICATIONS.SESSION_CLOSED));
    const home = sessionHomePath(d.home, 'g');
    const credentials = path.join(home, 'auto-review.json');
    // The hook command names the file, and the file is private to the owner.
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain(`--credentials`);
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain(credentials);
    expect(fs.statSync(credentials).mode & 0o777).toBe(0o600);
    // No env at all: what a hook inside an already-running gateway sees.
    const allowed = await runAutoReviewHook({
      readStdin: async () => JSON.stringify(payload('terminal', { command: 'ls' })),
      env: {},
      credentialsFile: credentials,
    });
    expect(allowed).toEqual({ stdout: '{}', exitCode: 0 });
    const blocked = await runAutoReviewHook({
      readStdin: async () => JSON.stringify(payload('terminal', { command: 'rm -rf /' })),
      env: {},
      credentialsFile: credentials,
    });
    expect(blocked.exitCode).toBe(2);
    // A missing or unreadable credentials file still blocks.
    const missing = await runAutoReviewHook({
      readStdin: async () => JSON.stringify(payload()),
      env: {},
      credentialsFile: path.join(home, 'nope.json'),
    });
    expect(missing.exitCode).toBe(2);
  });

  it('asks the client that sent the turn without an attach, and blocks after the session leaves auto', async () => {
    const d = await startDaemon({ hook: true, sessionHomes: true });
    d.client.setRequestHandler(SERVER_METHODS.APPROVAL_REQUEST, async () => ({ kind: 'permission', behavior: 'allow' }));
    await d.client.request(METHODS.QUERY_START, { sessionId: 'a', cwd: d.dir, permissionMode: 'auto' }, { timeoutMs: 5_000 });
    await d.client.request(METHODS.QUERY_SEND, { sessionId: 'a', text: 'hi' }, { timeoutMs: 5_000 });
    await until(() => d.notes.some((n) => n.method === NOTIFICATIONS.SESSION_CLOSED));
    const [spawn] = d.spawns();
    const env = { [AUTO_REVIEW_SOCKET_ENV]: spawn.reviewSocket!, [AUTO_REVIEW_TOKEN_ENV]: spawn.reviewToken! };
    // No session/attach (the Cindy adapter never attaches): the client that sent the turn answers.
    expect((await hookWith(env, JSON.stringify(payload()))).exitCode).toBe(0);
    await d.client.request(METHODS.QUERY_SET_PERMISSION_MODE, { sessionId: 'a', mode: 'bypassPermissions' }, { timeoutMs: 5_000 });
    const left = await hookWith(env, JSON.stringify(payload()));
    expect(JSON.parse(left.stdout).reason).toMatch(/no longer in Auto-review/);
  });

  it('blocks once the client that sent the turn has disconnected', async () => {
    const d = await startDaemon({ hook: true, sessionHomes: true });
    d.client.setRequestHandler(SERVER_METHODS.APPROVAL_REQUEST, async () => ({ kind: 'permission', behavior: 'allow' }));
    await d.client.request(METHODS.QUERY_START, { sessionId: 'a', cwd: d.dir, permissionMode: 'auto' }, { timeoutMs: 5_000 });
    await d.client.request(METHODS.QUERY_SEND, { sessionId: 'a', text: 'hi' }, { timeoutMs: 5_000 });
    await until(() => d.notes.some((n) => n.method === NOTIFICATIONS.SESSION_CLOSED));
    const [spawn] = d.spawns();
    const env = { [AUTO_REVIEW_SOCKET_ENV]: spawn.reviewSocket!, [AUTO_REVIEW_TOKEN_ENV]: spawn.reviewToken! };
    d.client.dispose();
    d.socket.destroy();
    // real-wait: the daemon learns of the closed socket asynchronously and exposes no event to await
    await new Promise((r) => setTimeout(r, 100));
    const out = await hookWith(env, JSON.stringify(payload()));
    expect(JSON.parse(out.stdout).reason).toMatch(/not connected/);
  });

  it('with the guard off, a bypassPermissions session gets no hook and no review env', async () => {
    const d = await startDaemon({ hook: true, sessionHomes: true });
    await d.client.request(
      METHODS.QUERY_START,
      { sessionId: 'b', cwd: d.dir, permissionMode: 'bypassPermissions' },
      { timeoutMs: 5_000 },
    );
    await d.client.request(METHODS.QUERY_SEND, { sessionId: 'b', text: 'hi' }, { timeoutMs: 5_000 });
    await until(() => d.notes.some((n) => n.method === NOTIFICATIONS.SESSION_CLOSED));
    const [spawn] = d.spawns();
    // ROADMAP 10.1: Full access always passes `--accept-hooks` now; with the guard off nothing is
    // installed for it to accept, which is what this test pins.
    expect(spawn.argv).toContain('--accept-hooks');
    expect(spawn.reviewToken).toBeNull();
    expect(fs.readFileSync(path.join(spawn.home!, 'config.yaml'), 'utf8')).not.toContain('hooks:');
  });
});
