import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '../client.js';
import { HermesManager, type HermesManagerOptions } from '../hermes-manager.js';
import { METHODS, NOTIFICATIONS, type RpcNotification } from '../protocol.js';
import { sessionHomePath } from '../session-home.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));

interface Spawn {
  home: string | null;
  probe: string | null;
  argv: string[];
}

interface Harness {
  manager: HermesManager;
  client: RpcClient;
  notes: RpcNotification[];
  dir: string;
  home: string;
  envLog: string;
}

let current: Harness | null = null;

async function startHarness(
  sessionHomes: HermesManagerOptions['sessionHomes'],
  beforeStart?: (home: string) => void,
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mgr-homes-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'model:\n  default: fake/default-model\n  provider: fake-provider\n_config_version: 1\n',
  );
  fs.writeFileSync(path.join(home, '.env'), 'FAKE_VAR=1\n');
  beforeStart?.(home);
  const envLog = path.join(dir, 'spawns.ndjson');
  process.env.FAKE_RECORD_ENV = envLog;
  const socketPath = path.join(dir, 'm.sock');
  const manager = new HermesManager({
    socketPath,
    hermesHome: home,
    hermesBin: process.execPath,
    hermesExtraArgs: [FIXTURE],
    registryFile: path.join(home, 'hermes-mgr', 'sessions.json'),
    ...(sessionHomes ? { sessionHomes } : {}),
  });
  await manager.start();
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  const notes: RpcNotification[] = [];
  const client = new RpcClient(socket, { onNotification: (n) => notes.push(n) });
  await client.hello({ timeoutMs: 5_000 });
  return { manager, client, notes, dir, home, envLog };
}

function spawns(h: Harness): Spawn[] {
  if (!fs.existsSync(h.envLog)) return [];
  return fs
    .readFileSync(h.envLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Spawn);
}

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runTurn(h: Harness, sessionId: string, env?: Record<string, string>): Promise<void> {
  const before = h.notes.filter((n) => n.method === NOTIFICATIONS.SESSION_CLOSED).length;
  await h.client.request(
    METHODS.QUERY_START,
    { sessionId, cwd: h.dir, permissionMode: 'bypassPermissions', ...(env ? { env } : {}) },
    { timeoutMs: 5_000 },
  );
  await h.client.request(METHODS.QUERY_SEND, { sessionId, text: 'hi' }, { timeoutMs: 5_000 });
  await until(() => h.notes.filter((n) => n.method === NOTIFICATIONS.SESSION_CLOSED).length > before);
}

afterEach(async () => {
  await current?.manager.stop();
  current?.client.dispose();
  delete process.env.FAKE_RECORD_ENV;
  if (current) fs.rmSync(current.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  current = null;
});

describe('HermesManager per-session homes (fake hermes)', () => {
  describe('disabled (default)', () => {
    beforeEach(async () => {
      current = await startHarness(undefined);
    });

    it('keeps every turn in the shared home and creates no session homes', async () => {
      const h = current!;
      await runTurn(h, 'a');
      await runTurn(h, 'b');
      expect(spawns(h).map((s) => s.home)).toEqual([h.home, h.home]);
      expect(fs.existsSync(path.join(h.home, 'session-homes'))).toBe(false);
    });
  });

  describe('enabled', () => {
    beforeEach(async () => {
      current = await startHarness({ prewarmGateway: false });
    });

    it('runs each session in its own home, with its own session env, never the shared or daily home', async () => {
      const h = current!;
      await runTurn(h, 'a', { CINDY_PROBE: 'sess-a' });
      await runTurn(h, 'b', { CINDY_PROBE: 'sess-b' });
      const turns = spawns(h);
      expect(turns).toHaveLength(2);
      expect(turns[0].home).toBe(sessionHomePath(h.home, 'a'));
      expect(turns[1].home).toBe(sessionHomePath(h.home, 'b'));
      expect(turns[0].home).not.toBe(turns[1].home);
      expect(turns.map((t) => t.probe)).toEqual(['sess-a', 'sess-b']);
      for (const t of turns) {
        expect(t.home).not.toBe(h.home);
        expect(t.home!.startsWith(path.join(h.home, 'session-homes') + path.sep)).toBe(true);
      }
    });

    it('reuses the same home for a session across turns, so resume stays inside it', async () => {
      const h = current!;
      await runTurn(h, 'a');
      const closedBefore = h.notes.filter((n) => n.method === NOTIFICATIONS.SESSION_CLOSED).length;
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 'a', text: 'again' }, { timeoutMs: 5_000 });
      await until(() => h.notes.filter((n) => n.method === NOTIFICATIONS.SESSION_CLOSED).length > closedBefore);
      const turns = spawns(h);
      expect(turns).toHaveLength(2);
      expect(turns[0].home).toBe(turns[1].home);
      expect(turns[0].home).toBe(sessionHomePath(h.home, 'a'));
    });

    it('links the shared credentials file instead of copying it and generates a regular config', async () => {
      const h = current!;
      await runTurn(h, 'a');
      const home = sessionHomePath(h.home, 'a');
      expect(fs.lstatSync(path.join(home, '.env')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(home, 'config.yaml')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain('fake/default-model');
    });

    it('query/close removes the session home but leaves the shared files', async () => {
      const h = current!;
      await runTurn(h, 'a');
      const home = sessionHomePath(h.home, 'a');
      expect(fs.existsSync(home)).toBe(true);
      await h.client.request(METHODS.QUERY_CLOSE, { sessionId: 'a' }, { timeoutMs: 5_000 });
      expect(fs.existsSync(home)).toBe(false);
      expect(fs.readFileSync(path.join(h.home, '.env'), 'utf8')).toBe('FAKE_VAR=1\n');
    });
  });

  describe('enabled with prewarm', () => {
    beforeEach(async () => {
      current = await startHarness({});
    });

    it('starts the session gateway at query/start in the session home with the session env', async () => {
      const h = current!;
      await h.client.request(
        METHODS.QUERY_START,
        { sessionId: 'a', cwd: h.dir, permissionMode: 'bypassPermissions', env: { CINDY_PROBE: 'sess-a' } },
        { timeoutMs: 5_000 },
      );
      await until(() => spawns(h).some((s) => s.argv.includes('gateway') && s.argv.includes('ensure')));
      const warm = spawns(h).find((s) => s.argv.includes('gateway'))!;
      expect(warm.home).toBe(sessionHomePath(h.home, 'a'));
      expect(warm.probe).toBe('sess-a');
    });
  });

  describe('orphan homes at startup', () => {
    it('removes idle homes no registered session owns, keeps recent ones', async () => {
      let idle = '';
      let recent = '';
      current = await startHarness({ prewarmGateway: false, orphanHomeMinAgeMs: 60_000 }, (home) => {
        idle = sessionHomePath(home, 'old-session');
        recent = sessionHomePath(home, 'new-session');
        for (const dir of [idle, recent]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(idle, 'state.db'), 'x');
        const past = new Date(Date.now() - 10 * 60_000);
        for (const entry of [idle, path.join(idle, 'state.db')]) fs.utimesSync(entry, past, past);
      });
      expect(fs.existsSync(idle)).toBe(false);
      expect(fs.existsSync(recent)).toBe(true);
    });
  });
});
