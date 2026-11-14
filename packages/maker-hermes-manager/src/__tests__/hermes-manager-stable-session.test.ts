/**
 * ROADMAP 1.14 — the agent's context must survive an app restart.
 *
 * The fixture's `home-scoped` behaviour models the real CLI: a session lives in
 * HERMES_HOME's own store, so `--resume` only resolves inside the home that created
 * it. These tests restart the real daemon on the same home and registry, which is
 * what an app restart does.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '../client.js';
import { HermesManager } from '../hermes-manager.js';
import { METHODS, NOTIFICATIONS, type RpcNotification } from '../protocol.js';
import { sessionHomePath, type HermesSessionRecord } from '../index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));

interface Ctx {
  dir: string;
  home: string;
  registryFile: string;
  envLog: string;
  notes: RpcNotification[];
  boots: number;
}

interface Harness {
  manager: HermesManager;
  client: RpcClient;
  ctx: Ctx;
}

let current: Harness | null = null;

function newCtx(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mgr-114-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'model:\n  default: fake/default-model\n  provider: fake-provider\n_config_version: 1\n',
  );
  return {
    dir,
    home,
    registryFile: path.join(home, 'hermes-mgr', 'sessions.json'),
    envLog: path.join(dir, 'spawns.ndjson'),
    notes: [],
    boots: 0,
  };
}

async function connect(ctx: Ctx): Promise<Harness> {
  ctx.boots += 1;
  process.env.FAKE_RECORD_ENV = ctx.envLog;
  const socketPath = path.join(ctx.dir, `m-${ctx.boots}.sock`);
  const manager = new HermesManager({
    socketPath,
    hermesHome: ctx.home,
    hermesBin: process.execPath,
    hermesExtraArgs: [FIXTURE],
    registryFile: ctx.registryFile,
    sessionHomes: { prewarmGateway: false },
  });
  await manager.start();
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  const client = new RpcClient(socket, { onNotification: (n) => ctx.notes.push(n) });
  await client.hello({ timeoutMs: 5_000 });
  return { manager, client, ctx };
}

/** Stops the daemon and starts a new one on the same home + registry: an app restart. */
async function restart(h: Harness): Promise<Harness> {
  await h.manager.stop();
  h.client.dispose();
  return connect(h.ctx);
}

function spawns(ctx: Ctx): Array<{ home: string | null; argv: string[] }> {
  if (!fs.existsSync(ctx.envLog)) return [];
  return fs.readFileSync(ctx.envLog, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { home: string | null; argv: string[] });
}

function chatSpawns(ctx: Ctx): Array<{ home: string | null; argv: string[] }> {
  return spawns(ctx).filter((s) => !s.argv.includes('gateway'));
}

function records(ctx: Ctx): HermesSessionRecord[] {
  return JSON.parse(fs.readFileSync(ctx.registryFile, 'utf8')) as HermesSessionRecord[];
}

function boundId(ctx: Ctx, sessionId: string): string {
  return records(ctx).find((r) => r.sessionId === sessionId)?.hermesSessionId ?? '';
}

function events(ctx: Ctx): Array<{ type?: string; subtype?: string; text?: string }> {
  return ctx.notes
    .filter((n) => n.method === NOTIFICATIONS.QUERY_EVENT)
    .map((n) => (n.params as { event?: { type?: string; subtype?: string; text?: string } }).event ?? {});
}

function resumeResets(ctx: Ctx): number {
  return events(ctx).filter((e) => e.type === 'hermes-mgr' && e.subtype === 'resume-reset').length;
}

function closedCount(ctx: Ctx): number {
  return ctx.notes.filter((n) => n.method === NOTIFICATIONS.SESSION_CLOSED).length;
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function start(h: Harness, sessionId: string, resume?: string): Promise<void> {
  await h.client.request(
    METHODS.QUERY_START,
    {
      sessionId,
      cwd: h.ctx.dir,
      permissionMode: 'bypassPermissions',
      ...(resume ? { resumeHermesSessionId: resume } : {}),
    },
    { timeoutMs: 5_000 },
  );
}

async function turn(h: Harness, sessionId: string, text = 'hi'): Promise<void> {
  const before = closedCount(h.ctx);
  await h.client.request(METHODS.QUERY_SEND, { sessionId, text }, { timeoutMs: 5_000 });
  await until(() => closedCount(h.ctx) > before);
}

beforeEach(() => {
  process.env.FAKE_BEHAVIOR = 'home-scoped';
});

afterEach(async () => {
  await current?.manager.stop();
  current?.client.dispose();
  delete process.env.FAKE_BEHAVIOR;
  delete process.env.FAKE_RECORD_ENV;
  if (current) fs.rmSync(current.ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  current = null;
});

describe('HermesManager stable daemon session (ROADMAP 1.14)', () => {
  // The defect this row fixes was reproduced here before the fix: two per-start daemon ids
  // gave two homes, and the second turn reported exactly one resume-reset and answered 'fresh'.
  // What must survive the fix is the safety net itself — an unresolvable id still replays.
  it('still replays fresh when no home holds the resume id, instead of failing the turn', async () => {
    current = await connect(newCtx());
    const ctx = current.ctx;
    await start(current, 'cindy-conv1', 'ghost-session-id');
    await turn(current, 'cindy-conv1');

    expect(resumeResets(ctx)).toBe(1);
    expect(events(ctx).some((e) => e.type === 'text' && e.text === 'fresh')).toBe(true);
    expect(boundId(ctx, 'cindy-conv1')).toBeTruthy();
    expect(closedCount(ctx)).toBe(1);
  }, 30_000);

  it('keeps the home and the context across a restart when the daemon id is stable', async () => {
    current = await connect(newCtx());
    const ctx = current.ctx;
    await start(current, 'cindy-conv1');
    await turn(current, 'cindy-conv1');
    const hermesId = boundId(ctx, 'cindy-conv1');
    const home = sessionHomePath(ctx.home, 'cindy-conv1');
    expect(fs.existsSync(path.join(home, 'fake-sessions.json'))).toBe(true);

    current = await restart(current);
    expect(fs.existsSync(home)).toBe(true);
    await start(current, 'cindy-conv1', hermesId);
    await turn(current, 'cindy-conv1', 'again');

    const homes = chatSpawns(ctx).map((s) => s.home);
    expect(homes).toEqual([home, home]);
    expect(resumeResets(ctx)).toBe(0);
    expect(events(ctx).some((e) => e.type === 'text' && e.text === 'resumed')).toBe(true);
    expect(chatSpawns(ctx)[1].argv).toContain('--resume');
  }, 30_000);

  it('adopts an existing record on a repeated query/start instead of refusing it', async () => {
    current = await connect(newCtx());
    const ctx = current.ctx;
    await start(current, 'cindy-conv1');
    await turn(current, 'cindy-conv1');
    const hermesId = boundId(ctx, 'cindy-conv1');
    const seqBefore = records(ctx).find((r) => r.sessionId === 'cindy-conv1')!.lastSeq;

    await start(current, 'cindy-conv1', hermesId);
    expect(boundId(ctx, 'cindy-conv1')).toBe(hermesId);
    expect(records(ctx).filter((r) => r.sessionId === 'cindy-conv1')).toHaveLength(1);
    expect(records(ctx).find((r) => r.sessionId === 'cindy-conv1')!.lastSeq).toBe(seqBefore);
  }, 30_000);

  it('re-applies the start fields on adopt but keeps the frozen launch route', async () => {
    current = await connect(newCtx());
    const ctx = current.ctx;
    await start(current, 'cindy-conv1');
    await turn(current, 'cindy-conv1');
    const launchBefore = records(ctx).find((r) => r.sessionId === 'cindy-conv1')!.launch;
    expect(launchBefore).toBeTruthy();

    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-114-cwd-'));
    try {
      await current.client.request(
        METHODS.QUERY_START,
        { sessionId: 'cindy-conv1', cwd: otherCwd, model: 'fake/other-model', permissionMode: 'bypassPermissions' },
        { timeoutMs: 5_000 },
      );
      const rec = records(ctx).find((r) => r.sessionId === 'cindy-conv1')!;
      expect(rec.cwd).toBe(otherCwd);
      expect(rec.model).toBe('fake/other-model');
      expect(rec.launch).toEqual(launchBefore);
    } finally {
      fs.rmSync(otherCwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('still refuses a second start while a turn is running', async () => {
    process.env.FAKE_BEHAVIOR = 'slow';
    current = await connect(newCtx());
    await start(current, 'cindy-busy');
    await current.client.request(METHODS.QUERY_SEND, { sessionId: 'cindy-busy', text: 'hi' }, { timeoutMs: 5_000 });
    await until(() => spawns(current!.ctx).some((s) => s.argv.includes('chat')));
    await expect(
      current.client.request(METHODS.QUERY_START, { sessionId: 'cindy-busy', cwd: current.ctx.dir }, { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ rpcError: { code: 'SESSION_ALREADY_EXISTS' } });
    await current.client.request(METHODS.QUERY_INTERRUPT, { sessionId: 'cindy-busy' }, { timeoutMs: 5_000 });
  }, 30_000);

  // Measured live 2026-11-14 on Hermes 0.23.0: a session is bound to a profile identity derived
  // from its home path, so renaming a legacy home makes `--resume` fail with `profile_mismatch`
  // and the turn ERRORS instead of resetting. The upgrade therefore leaves legacy homes alone:
  // one final reset, then a stable home. See docs/evidence/1.14-cross-restart-context-live-proof.md.
  it('leaves a legacy home untouched and still answers the upgrade turn', async () => {
    current = await connect(newCtx());
    const ctx = current.ctx;
    await start(current, 'legacy-uuid');
    await turn(current, 'legacy-uuid');
    const hermesId = boundId(ctx, 'legacy-uuid');
    const legacyHome = sessionHomePath(ctx.home, 'legacy-uuid');

    current = await restart(current);
    await start(current, 'cindy-conv1', hermesId);
    await turn(current, 'cindy-conv1', 'after upgrade');

    expect(fs.existsSync(path.join(legacyHome, 'fake-sessions.json'))).toBe(true);
    expect(records(ctx).some((r) => r.sessionId === 'legacy-uuid')).toBe(true);
    expect(fs.existsSync(sessionHomePath(ctx.home, 'cindy-conv1'))).toBe(true);
    expect(resumeResets(ctx)).toBe(1);
    expect(closedCount(ctx)).toBe(2);
  }, 30_000);
});
