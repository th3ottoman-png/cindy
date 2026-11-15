import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_PACKS,
  createNodeContext,
  createRegistry,
  runChecks,
  type DoctorContext,
  type DoctorExecResult,
} from '../index.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (
  file: string,
  opts?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  exec(sql: string): unknown;
  close(): void;
};

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function makeTempSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-14-4-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const repoRoot = path.join(root, 'repo');

  await Promise.all([
    fs.mkdir(path.join(hermesHome, 'session-homes'), { recursive: true }),
    fs.mkdir(path.join(hermesHome, 'hermes-mgr'), { recursive: true }),
    fs.mkdir(path.join(hermesHome, 'logs'), { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts'), { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(path.join(repoRoot, 'apps', 'desktop', 'logs'), { recursive: true }),
  ]);

  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'cindy', packageManager: 'pnpm@10.33.2+sha512.abc' }),
    'utf8',
  );

  return { root, home, hermesHome, harnessDir, userDataDir, repoRoot };
}

function makeDoctorContext(
  sandbox: Awaited<ReturnType<typeof makeTempSandbox>>,
  overrides: Partial<DoctorContext> = {},
): DoctorContext {
  const base = createNodeContext({
    home: sandbox.home,
    hermesHome: sandbox.hermesHome,
    harnessDir: sandbox.harnessDir,
    userDataDir: sandbox.userDataDir,
    repoRoot: sandbox.repoRoot,
    env: { PATH: process.env.PATH ?? '', ...overrides.env },
    appRunning: false,
  });
  return {
    ...base,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

async function startLocalJsonServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
  return { baseUrl: `http://127.0.0.1:${addr.port}` };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn().catch(() => undefined);
  }
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('14.4 endpoints, processes, and data doctor packs', () => {
  describe('endpoints pack', () => {
    it('probes local endpoints and skips API endpoints unless includeApi is true', async () => {
      const sandbox = await makeTempSandbox();
      const lm = await startLocalJsonServer((req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'gemma-local' }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await fs.writeFile(
        path.join(sandbox.harnessDir, 'providers.yaml'),
        [
          'providers:',
          '  - id: lmstudio-local',
          '    kind: lmstudio',
          `    baseUrl: ${lm.baseUrl}`,
          '    capabilities: { tools: false, vision: true }',
          '  - id: cloud-api',
          '    kind: openai-compatible',
          '    baseUrl: https://api.example.test/v1',
          '    keyEnv: CLOUD_API_KEY',
          '    capabilities: { tools: true, vision: false }',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(sandbox.harnessDir, 'routing.yaml'),
        [
          'routes:',
          '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
          '  cloud-main: { provider: cloud-api, model: deepseek-v4 }',
          'rules:',
          '  chat.default: local-small',
          '  recap: cloud-main',
        ].join('\n'),
        'utf8',
      );

      const apiFetchSpy = vi.fn(async () => {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const wrappedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://api.example.test')) {
          return apiFetchSpy();
        }
        return globalThis.fetch(input, init);
      }) as typeof fetch;

      const ctxNoApi = makeDoctorContext(sandbox, {
        env: { PATH: process.env.PATH ?? '', CLOUD_API_KEY: 'sk-test-token' },
        fetchImpl: wrappedFetch,
      });

      const registry = createRegistry(ALL_PACKS);
      const reportNoApi = await runChecks(registry, ctxNoApi, { only: ['endpoints'] });
      const byIdNoApi = new Map(reportNoApi.results.map((r) => [r.id, r]));

      expect(byIdNoApi.get('endpoint.lmstudio-local')?.severity).toBe('ok');
      expect(byIdNoApi.get('endpoint.cloud-api')?.severity).toBe('skip');
      expect(byIdNoApi.get('endpoint.cloud-api')?.summary).toContain('--include-api');
      expect(apiFetchSpy).not.toHaveBeenCalled();
      expect(byIdNoApi.get('endpoint.routes')?.severity).toBe('ok');

      const ctxWithApi = makeDoctorContext(sandbox, {
        includeApi: true,
        env: { PATH: process.env.PATH ?? '', CLOUD_API_KEY: 'sk-test-token' },
        fetchImpl: wrappedFetch,
      });
      const reportWithApi = await runChecks(registry, ctxWithApi, { only: ['endpoints'] });
      const byIdWithApi = new Map(reportWithApi.results.map((r) => [r.id, r]));

      expect(apiFetchSpy).toHaveBeenCalledTimes(1);
      expect(byIdWithApi.get('endpoint.cloud-api')?.severity).toBe('ok');
      expect(byIdWithApi.get('endpoint.routes')?.severity).toBe('ok');
    });

    it('fails used offline endpoints, warns unused offline endpoints, and lists alternatives for blocked routes', async () => {
      const sandbox = await makeTempSandbox();
      const lm = await startLocalJsonServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen3-8b' }] }));
      });
      // Bind then immediately close a port so connections fail with ECONNREFUSED fast.
      const closed = await startLocalJsonServer((_req, res) => res.end());
      await cleanups.pop()!();

      await fs.writeFile(
        path.join(sandbox.harnessDir, 'providers.yaml'),
        [
          'providers:',
          '  - id: lmstudio-local',
          '    kind: lmstudio',
          `    baseUrl: ${lm.baseUrl}`,
          '    capabilities: { tools: false, vision: true }',
          '  - id: ollama-used',
          '    kind: ollama',
          `    baseUrl: ${closed.baseUrl}`,
          '    capabilities: { tools: true, vision: false }',
          '  - id: llamacpp-unused',
          '    kind: llamacpp',
          `    baseUrl: ${closed.baseUrl}`,
          '    capabilities: { tools: false, vision: false }',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(sandbox.harnessDir, 'routing.yaml'),
        [
          'routes:',
          '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
          '  ollama-main: { provider: ollama-used, model: llama3.2 }',
          'rules:',
          '  summary: local-small',
          '  chat.default: ollama-main',
        ].join('\n'),
        'utf8',
      );

      const ctx = makeDoctorContext(sandbox);
      const report = await runChecks(createRegistry(ALL_PACKS), ctx, { only: ['endpoints'] });
      const byId = new Map(report.results.map((r) => [r.id, r]));

      expect(byId.get('endpoint.lmstudio-local')?.severity).toBe('ok');
      expect(byId.get('endpoint.ollama-used')?.severity).toBe('fail');
      expect(byId.get('endpoint.llamacpp-unused')?.severity).toBe('warn');

      const routes = byId.get('endpoint.routes');
      expect(routes?.severity).toBe('fail');
      expect(routes?.detail).toContain('chat.default');
      expect(routes?.detail).toContain('local-small');

      // Also verify remote/API alternatives carry [paid] when includeApi is enabled.
      await fs.writeFile(
        path.join(sandbox.harnessDir, 'providers.yaml'),
        [
          'providers:',
          '  - id: lmstudio-local',
          '    kind: lmstudio',
          `    baseUrl: ${lm.baseUrl}`,
          '    capabilities: { tools: false, vision: true }',
          '  - id: ollama-used',
          '    kind: ollama',
          `    baseUrl: ${closed.baseUrl}`,
          '    capabilities: { tools: true, vision: false }',
          '  - id: cloud-api',
          '    kind: openai-compatible',
          '    baseUrl: https://api.example.test/v1',
          '    keyEnv: CLOUD_API_KEY',
          '    capabilities: { tools: true, vision: false }',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(sandbox.harnessDir, 'routing.yaml'),
        [
          'routes:',
          '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
          '  ollama-main: { provider: ollama-used, model: llama3.2 }',
          '  cloud-route: { provider: cloud-api, model: deepseek-v4 }',
          'rules:',
          '  summary: local-small',
          '  chat.default: ollama-main',
          '  recap: cloud-route',
        ].join('\n'),
        'utf8',
      );
      const paidCtx = makeDoctorContext(sandbox, {
        includeApi: true,
        env: { PATH: process.env.PATH ?? '', CLOUD_API_KEY: 'sk-test-token' },
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url.startsWith('https://api.example.test')) {
            return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return globalThis.fetch(input, init);
        }) as typeof fetch,
      });
      const paidReport = await runChecks(createRegistry(ALL_PACKS), paidCtx, { only: ['endpoint.routes'] });
      expect(paidReport.results[0]?.severity).toBe('fail');
      expect(paidReport.results[0]?.detail).toContain('cloud-route (cloud-api/deepseek-v4 [paid])');
    });
  });

  describe('processes pack', () => {
    it('reports proc.app and validates live unix socket handshake + stale socket in proc.daemon', async () => {
      const sandbox = await makeTempSandbox();
      const sockDir = path.join(sandbox.userDataDir, 'hermes-mgr');
      await fs.mkdir(sockDir, { recursive: true });
      const socketPath = path.join(sockDir, 'hermes-mgr.sock');

      // 1. Live unix socket stub answering protocol/hello + config/status
      const server = net.createServer((conn) => {
        let buf = '';
        conn.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const req = JSON.parse(line) as { id: string; method: string };
            if (req.method === 'protocol/hello') {
              conn.write(
                `${JSON.stringify({ type: 'response', id: req.id, ok: true, result: { protocolVersion: 1, serverVersion: '0.3.2' } })}\n`,
              );
            } else if (req.method === 'config/status') {
              conn.write(
                `${JSON.stringify({ type: 'response', id: req.id, ok: true, result: { installedVersion: '0.23.0', pinnedVersion: '0.22.7', matches: false } })}\n`,
              );
            }
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

      const ctxRunning = makeDoctorContext(sandbox, {
        appRunning: undefined,
        exec: async (cmd): Promise<DoctorExecResult> => {
          if (cmd === 'ps') {
            return {
              code: 0,
              stdout: '  101     1 /Applications/Cindy.app/Contents/MacOS/Electron --user-data-dir=foo\n',
              stderr: '',
            };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      });

      const reportOk = await runChecks(createRegistry(ALL_PACKS), ctxRunning, {
        only: ['proc.app', 'proc.daemon'],
      });
      const okById = new Map(reportOk.results.map((r) => [r.id, r]));
      expect(okById.get('proc.app')?.severity).toBe('ok');
      expect(okById.get('proc.app')?.evidence?.running).toBe(true);
      expect(okById.get('proc.daemon')?.severity).toBe('ok');
      expect(okById.get('proc.daemon')?.summary).toContain('0.3.2');

      // 2. Close server while leaving a regular/socket file in place -> stale socket FAIL
      await cleanups.pop()!();
      await fs.writeFile(socketPath, '', 'utf8');

      const reportStale = await runChecks(createRegistry(ALL_PACKS), ctxRunning, {
        only: ['proc.daemon'],
      });
      expect(reportStale.results[0]?.severity).toBe('fail');
      expect(reportStale.results[0]?.summary.toLowerCase()).toContain('stale');
      expect(reportStale.results[0]?.fixIds).toContain('fix.proc.stale-socket');

      // 3. Remove socket & report app closed -> skip
      await fs.rm(socketPath, { force: true });
      const ctxClosed = makeDoctorContext(sandbox, {
        appRunning: undefined,
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      });
      const reportClosed = await runChecks(createRegistry(ALL_PACKS), ctxClosed, {
        only: ['proc.app', 'proc.daemon'],
      });
      const closedById = new Map(reportClosed.results.map((r) => [r.id, r]));
      expect(closedById.get('proc.app')?.evidence?.running).toBe(false);
      expect(closedById.get('proc.daemon')?.severity).toBe('skip');
    });

    it('detects orphaned processes, unexpected port holders, and broken MCP commands', async () => {
      const sandbox = await makeTempSandbox();
      const homeUnderSessions = path.join(sandbox.hermesHome, 'session-homes', 'abc-1234567890');
      await fs.mkdir(homeUnderSessions, { recursive: true });

      const validBin = path.join(sandbox.root, 'ok-mcp');
      await fs.writeFile(validBin, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 });

      await fs.writeFile(
        path.join(sandbox.hermesHome, 'config.yaml'),
        [
          'model:',
          '  default: qwen3-8b',
          'mcp_servers:',
          '  good-mcp:',
          `    command: "${validBin}"`,
          '  broken-mcp:',
          '    command: "/nonexistent/bin/missing-mcp"',
          '  disabled-mcp:',
          '    command: "/nonexistent/bin/disabled-mcp"',
          '    disabled: true',
        ].join('\n'),
        'utf8',
      );

      const ctx = makeDoctorContext(sandbox, {
        exec: async (cmd, args): Promise<DoctorExecResult> => {
          if (cmd === 'ps') {
            return {
              code: 0,
              stdout: [
                '  4242     1 /opt/homebrew/bin/hermes-cindy gateway',
                '  4243   500 /opt/homebrew/bin/hermes-cindy chat',
              ].join('\n'),
              stderr: '',
            };
          }
          if (cmd === 'lsof' && args.includes('cwd')) {
            return {
              code: 0,
              stdout: `p4242\nfcwd\nn${homeUnderSessions}\n`,
              stderr: '',
            };
          }
          if (cmd === 'lsof' && args.some((a) => a.startsWith('-i'))) {
            return {
              code: 0,
              stdout: [
                'COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
                'python3   9911 turko  10u  IPv4 0x123      0t0  TCP 127.0.0.1:1234 (LISTEN)',
              ].join('\n'),
              stderr: '',
            };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      });

      const report = await runChecks(createRegistry(ALL_PACKS), ctx, { only: ['processes'] });
      const byId = new Map(report.results.map((r) => [r.id, r]));

      expect(byId.get('proc.orphans')?.severity).toBe('warn');
      expect(byId.get('proc.orphans')?.summary).toContain('4242');
      expect(byId.get('proc.orphans')?.fixIds).toContain('fix.proc.kill-orphans');

      expect(byId.get('proc.ports')?.severity).toBe('warn');
      expect(byId.get('proc.ports')?.detail).toContain('1234');
      expect(byId.get('proc.ports')?.detail).toContain('python3');

      // macOS lsof truncates "LM Studio" to "LM\x20Stu"; verify expected holder stays ok.
      const lmCtx = makeDoctorContext(sandbox, {
        exec: async (cmd, args): Promise<DoctorExecResult> => {
          if (cmd === 'lsof' && args.some((a) => a.startsWith('-i'))) {
            return {
              code: 0,
              stdout: [
                'COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
                'LM\\x20Stu 12741 turko  10u  IPv4 0x123      0t0  TCP *:1234 (LISTEN)',
              ].join('\n'),
              stderr: '',
            };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      const lmPortsReport = await runChecks(createRegistry(ALL_PACKS), lmCtx, { only: ['proc.ports'] });
      expect(lmPortsReport.results[0]?.severity).toBe('ok');

      expect(byId.get('proc.mcp.good-mcp')?.severity).toBe('ok');
      expect(byId.get('proc.mcp.broken-mcp')?.severity).toBe('fail');
      expect(byId.get('proc.mcp.disabled-mcp')?.severity).toBe('ok');
    });
  });

  describe('data pack', () => {
    it('runs read-only quick_check on SQLite without altering mtime and detects corruption', async () => {
      const sandbox = await makeTempSandbox();
      const dbPath = path.join(sandbox.userDataDir, 'cindy-local-v1.db');
      const db = new Database(dbPath);
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('ok');");
      db.close();

      const beforeStat = await fs.stat(dbPath);
      const ctx = makeDoctorContext(sandbox);
      const okReport = await runChecks(createRegistry(ALL_PACKS), ctx, { only: ['data.sqlite'] });
      const afterStat = await fs.stat(dbPath);

      expect(okReport.results[0]?.severity).toBe('ok');
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

      await fs.writeFile(dbPath, Buffer.from('not a valid sqlite database at all'));
      const badReport = await runChecks(createRegistry(ALL_PACKS), ctx, { only: ['data.sqlite'] });
      expect(badReport.results[0]?.severity).toBe('fail');
    });

    it('checks state.db of 20 newest session homes, session registry, storage thresholds, and fatal log patterns', async () => {
      const sandbox = await makeTempSandbox();
      const sessionHomesDir = path.join(sandbox.hermesHome, 'session-homes');

      // 22 homes: #0..#21. Oldest (#0, #1) should NOT be inspected because cap is 20 newest.
      const registryEntries: Array<{ sessionId: string; hermesSessionId: string; running: boolean }> = [];
      const baseTime = 1_700_000_000_000;
      for (let i = 0; i < 22; i += 1) {
        const sid = `sess-${String(i).padStart(2, '0')}`;
        const homeName = `${sid}-0123456789`;
        const homeDir = path.join(sessionHomesDir, homeName);
        await fs.mkdir(homeDir, { recursive: true });
        const dbFile = path.join(homeDir, 'state.db');
        if (i === 0 || i === 20) {
          await fs.writeFile(dbFile, Buffer.from('corrupt sqlite header'));
        } else {
          const sdb = new Database(dbFile);
          sdb.exec('CREATE TABLE kv (k TEXT);');
          sdb.close();
        }
        const mtimeSec = (baseTime + i * 10_000) / 1000;
        await fs.utimes(dbFile, mtimeSec, mtimeSec);
        await fs.utimes(homeDir, mtimeSec, mtimeSec);
        registryEntries.push({ sessionId: sid, hermesSessionId: `h-${sid}`, running: false });
      }
      // Also include a missing session home in sessions.json
      registryEntries.push({ sessionId: 'sess-missing', hermesSessionId: 'h-missing', running: false });

      await fs.writeFile(
        path.join(sandbox.hermesHome, 'hermes-mgr', 'sessions.json'),
        JSON.stringify(registryEntries),
        'utf8',
      );

      await fs.writeFile(
        path.join(sandbox.hermesHome, 'logs', 'agent.log'),
        [
          'INFO started ok',
          'ERROR database disk image is malformed token=Bearer sk-secret1234567890abcdef',
          'INFO continuing',
        ].join('\n'),
        'utf8',
      );

      // Inject large file size via ctx.lstat for one directory entry so storage exceeds threshold without huge disk writes
      const realLstat = fs.lstat;
      const ctx = makeDoctorContext(sandbox, {
        lstat: async (p) => {
          const st = await realLstat(p);
          if (String(p).includes('sess-21-0123456789/state.db')) {
            return {
              ...st,
              size: 9 * 1024 * 1024 * 1024,
              isSymbolicLink: () => false,
              isDirectory: () => false,
              isFile: () => true,
            } as unknown as Awaited<ReturnType<typeof fs.lstat>>;
          }
          return st;
        },
      });

      const report = await runChecks(createRegistry(ALL_PACKS), ctx, { only: ['data'] });
      const byId = new Map(report.results.map((r) => [r.id, r]));

      const hermesState = byId.get('data.hermes-state');
      expect(hermesState?.severity).toBe('warn');
      expect(hermesState?.summary).toContain('sess-20');
      expect(hermesState?.detail).not.toContain('sess-00');

      const reg = byId.get('data.registry');
      expect(reg?.severity).toBe('warn');
      expect(reg?.detail).toContain('sess-missing');

      const storage = byId.get('data.storage');
      expect(storage?.severity).toBe('warn');
      expect(storage?.action).toBe('Settings → Storage');

      const logs = byId.get('data.logs');
      expect(logs?.severity).toBe('warn');
      expect(logs?.detail).toContain('database disk image is malformed');
      expect(logs?.detail).not.toContain('sk-secret1234567890abcdef');
    });
  });
});
