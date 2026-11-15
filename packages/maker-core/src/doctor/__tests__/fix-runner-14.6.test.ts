import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_PACKS,
  applyFix,
  createLkgSnapshot,
  createNodeContext,
  createRegistry,
  listLkgSnapshots,
  previewFix,
  runChecks,
  runFix,
  type DoctorContext,
  type DoctorExecResult,
  type DoctorPack,
} from '../index.js';

const tempDirs: string[] = [];

async function makeTempSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-fix-'));
  tempDirs.push(root);

  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const repoRoot = path.join(root, 'repo');

  await Promise.all([
    fs.mkdir(path.join(hermesHome, 'session-homes'), { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts', 'reviewer'), { recursive: true }),
    fs.mkdir(path.join(userDataDir, 'hermes-mgr'), { recursive: true }),
    fs.mkdir(repoRoot, { recursive: true }),
  ]);

  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'cindy', packageManager: 'pnpm@10.33.2+sha512.abc' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'providers.yaml'),
    'providers:\n  - id: lmstudio\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'routing.yaml'),
    'routes:\n  local-small:\n    provider: lmstudio\n    model: google/gemma-4-26b-a4b-qat\nrules:\n  title: local-small\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'guardrails.yaml'),
    'policy: enforce\ndisabled: []\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'web-budget.yaml'),
    'max_searches_per_session: 25\ntool_names: [web_search]\n',
    'utf8',
  );
  await fs.writeFile(path.join(harnessDir, 'plugins.json'), '{"disabled":[]}\n', 'utf8');
  await fs.writeFile(path.join(harnessDir, 'hermes-sessions.json'), '{"sessions":{}}\n', 'utf8');
  await fs.writeFile(
    path.join(harnessDir, 'experts', 'reviewer', 'expert.md'),
    '---\nname: Reviewer\nagent: hermes\nmodel: local-small\ntoolsets: [file]\n---\n\nReview code carefully.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'experts', 'reviewer', 'tools.yaml'),
    'mcp_servers:\n  allow: [cindy_docs]\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(hermesHome, 'config.yaml'),
    'model:\n  default: google/gemma-4-26b-a4b-qat\n  provider: lmstudio\ncustom_providers:\n  - name: lmstudio\n    base_url: http://127.0.0.1:1234/v1\n',
    'utf8',
  );

  return { root, home, hermesHome, harnessDir, userDataDir, repoRoot };
}

function makeDoctorCtx(
  s: Awaited<ReturnType<typeof makeTempSandbox>>,
  overrides: Partial<DoctorContext> = {},
): DoctorContext {
  const noopExec = async (): Promise<DoctorExecResult> => ({ code: 0, stdout: '', stderr: '' });
  const base = createNodeContext({
    home: s.home,
    hermesHome: s.hermesHome,
    harnessDir: s.harnessDir,
    userDataDir: s.userDataDir,
    repoRoot: s.repoRoot,
    hermesPinnedVersion: '0.22.7',
    appRunning: false,
  });
  return {
    ...base,
    exec: noopExec,
    ...overrides,
  };
}

async function readFixLog(harnessDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(harnessDir, 'doctor', 'fix-log.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('Cindy Doctor fix runner and initial fixes (ROADMAP 14.6)', () => {
  it('preview() has zero filesystem or signal side effects for all three fixes', async () => {
    const s = await makeTempSandbox();
    const ctx = makeDoctorCtx(s);
    await createLkgSnapshot(ctx, { reason: 'baseline' });
    await fs.writeFile(path.join(s.harnessDir, 'routing.yaml'), 'routes: [broken\n', 'utf8');

    const snapshotTree = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (cur: string) => {
        const entries = (await fs.readdir(cur, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        for (const entry of entries) {
          const full = path.join(cur, entry.name);
          const st = await fs.lstat(full);
          if (entry.isDirectory()) {
            out.push(`D:${full}`);
            await walk(full);
          } else {
            const buf = st.isFile() ? await fs.readFile(full) : Buffer.alloc(0);
            out.push(`F:${full}:${st.size}:${st.mtimeMs}:${buf.toString('hex')}`);
          }
        }
      };
      await walk(dir);
      return out;
    };

    const beforeTree = await snapshotTree(s.root);
    const signalSpy = vi.fn();
    const fsOps: string[] = [];
    const trackedFs: DoctorContext['fs'] = {
      readFile: ((...args: Parameters<DoctorContext['fs']['readFile']>) => {
        fsOps.push(`readFile:${String(args[0])}`);
        return ctx.fs.readFile(...args);
      }) as DoctorContext['fs']['readFile'],
      stat: (p) => {
        fsOps.push(`stat:${String(p)}`);
        return ctx.fs.stat(p);
      },
      readdir: ((...args: Parameters<DoctorContext['fs']['readdir']>) => {
        fsOps.push(`readdir:${String(args[0])}`);
        return ctx.fs.readdir(...args);
      }) as DoctorContext['fs']['readdir'],
      access: (p, mode) => {
        fsOps.push(`access:${String(p)}`);
        return ctx.fs.access(p, mode);
      },
    };

    const previewCtx = makeDoctorCtx(s, { fs: trackedFs });
    const orphanCtx = makeDoctorCtx(s, {
      fs: trackedFs,
      sendSignal: signalSpy,
      exec: async (cmd): Promise<DoctorExecResult> => {
        if (cmd === 'ps') {
          return { code: 0, stdout: '  4242     1 sleep 600\n', stderr: '' };
        }
        if (cmd === 'lsof') {
          return {
            code: 0,
            stdout: `p4242\nfcwd\nn${path.join(s.hermesHome, 'session-homes', 's1')}\n`,
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const registry = createRegistry(ALL_PACKS);

    const p1 = await previewFix(registry, previewCtx, 'fix.config.restore-lkg', {
      target: 'harness/routing.yaml',
    });
    expect(p1.ok).toBe(true);
    if (p1.ok) {
      expect(p1.plan.touches).toContain(path.join(s.harnessDir, 'routing.yaml'));
      expect(p1.plan.steps.length).toBeGreaterThan(0);
    }

    const p2 = await previewFix(registry, orphanCtx, 'fix.proc.kill-orphans');
    expect(p2.ok).toBe(true);
    if (p2.ok) {
      expect(p2.plan.touches).toContain('pid:4242');
    }

    const p3 = await previewFix(registry, previewCtx, 'fix.proc.stale-socket');
    expect(p3.ok).toBe(true);

    const afterTree = await snapshotTree(s.root);
    expect(afterTree).toEqual(beforeTree);
    expect(fsOps.length).toBeGreaterThan(0);
    expect(signalSpy).not.toHaveBeenCalled();
  });

  it('rolls back atomically on failing re-check and appends fix-log.jsonl', async () => {
    const s = await makeTempSandbox();
    const ctx = makeDoctorCtx(s);
    const routingPath = path.join(s.harnessDir, 'routing.yaml');
    const originalRouting = await fs.readFile(routingPath, 'utf8');

    const badFixPack: DoctorPack = {
      name: 'bad-fix-test',
      checks: [],
      fixes: [
        {
          id: 'fix.test.break-routing',
          title: 'Write invalid routing to trigger rollback',
          risk: 'moves-files',
          needsAppClosed: false,
          recheck: ['config.routing'],
          async preview() {
            return {
              fixId: 'fix.test.break-routing',
              target: 'harness/routing.yaml',
              steps: ['Write broken YAML to harness/routing.yaml'],
              touches: [routingPath],
            };
          },
          async apply() {
            await fs.writeFile(routingPath, 'routes:\n  broken: [invalid\n', 'utf8');
            return {
              ok: true,
              rolledBack: false,
              message: 'Wrote routing.yaml',
              recheck: [],
            };
          },
        },
      ],
    };

    const registry = createRegistry([...ALL_PACKS, badFixPack]);
    const outcome = await runFix(registry, ctx, 'fix.test.break-routing', {
      confirm: async () => true,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.recheck.some((r) => r.id === 'config.routing' && r.severity === 'fail')).toBe(true);

    // File must be restored byte-exactly to pre-fix contents
    expect(await fs.readFile(routingPath, 'utf8')).toBe(originalRouting);

    // pre-fix snapshot created, fix-log.jsonl recorded
    const snaps = await listLkgSnapshots(ctx);
    expect(snaps.some((snap) => snap.manifest?.reason === 'pre-fix:fix.test.break-routing')).toBe(true);

    const log = await readFixLog(s.harnessDir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      fixId: 'fix.test.break-routing',
      target: 'harness/routing.yaml',
      ok: false,
      rolledBack: true,
    });
    expect((log[0] as { recheckCounts: { fail: number } }).recheckCounts.fail).toBe(1);
  });

  it('refuses fixes requiring app closed when appRunning is true, while allowing harness restore', async () => {
    const s = await makeTempSandbox();
    const closedCtx = makeDoctorCtx(s, { appRunning: false });
    await createLkgSnapshot(closedCtx, { reason: 'baseline' });

    const sockPath = path.join(s.userDataDir, 'hermes-mgr', 'hermes-mgr.sock');
    await fs.writeFile(sockPath, '', 'utf8');

    const registry = createRegistry(ALL_PACKS);
    const runningCtx = makeDoctorCtx(s, { appRunning: true });

    const sockOutcome = await runFix(registry, runningCtx, 'fix.proc.stale-socket', {
      confirm: async () => true,
    });
    expect(sockOutcome.ok).toBe(false);
    expect(sockOutcome.rolledBack).toBe(false);
    expect(sockOutcome.message.toLowerCase()).toContain('closed');
    await expect(fs.stat(sockPath)).resolves.toBeDefined();

    // hermes/config.yaml restore also refused while running
    await fs.writeFile(path.join(s.hermesHome, 'config.yaml'), 'model: [broken\n', 'utf8');
    const hermesOutcome = await runFix(registry, runningCtx, 'fix.config.restore-lkg', {
      target: 'hermes/config.yaml',
      confirm: async () => true,
    });
    expect(hermesOutcome.ok).toBe(false);
    expect(hermesOutcome.message.toLowerCase()).toContain('closed');
    expect(await fs.readFile(path.join(s.hermesHome, 'config.yaml'), 'utf8')).toBe('model: [broken\n');

    // Harness-only restore IS allowed while Cindy app runs (needed for 14.8 UI fix)
    const routingPath = path.join(s.harnessDir, 'routing.yaml');
    const goodRouting = await fs.readFile(routingPath, 'utf8');
    await fs.writeFile(path.join(s.hermesHome, 'config.yaml'), 'model:\n  default: google/gemma-4-26b-a4b-qat\n  provider: lmstudio\ncustom_providers:\n  - name: lmstudio\n    base_url: http://127.0.0.1:1234/v1\n', 'utf8');
    await fs.writeFile(routingPath, 'routes: [broken\n', 'utf8');

    const harnessOutcome = await runFix(registry, runningCtx, 'fix.config.restore-lkg', {
      target: 'harness/routing.yaml',
      confirm: async () => true,
    });
    expect(harnessOutcome.ok).toBe(true);
    expect(harnessOutcome.rolledBack).toBe(false);
    expect(await fs.readFile(routingPath, 'utf8')).toBe(goodRouting);
  });

  it('fix.config.restore-lkg skips invalid newer snapshots and restores the newest valid copy', async () => {
    const s = await makeTempSandbox();
    const routingPath = path.join(s.harnessDir, 'routing.yaml');
    const goodRouting = await fs.readFile(routingPath, 'utf8');

    const ctxT1 = makeDoctorCtx(s, { now: () => new Date('2026-11-15T10:00:00.000Z') });
    await createLkgSnapshot(ctxT1, { reason: 'good-t1' });

    // Create a newer snapshot (t2) whose routing.yaml is broken
    await fs.writeFile(
      routingPath,
      'routes:\n  local-small:\n    provider: nonexistent-provider\n    model: x\n',
      'utf8',
    );
    const ctxT2 = makeDoctorCtx(s, { now: () => new Date('2026-11-15T11:00:00.000Z') });
    await createLkgSnapshot(ctxT2, { reason: 'broken-t2' });

    // Break syntax on disk at t3
    await fs.writeFile(routingPath, 'routes:\n  bad: [unterminated\n', 'utf8');
    const ctxT3 = makeDoctorCtx(s, { now: () => new Date('2026-11-15T12:00:00.000Z') });

    const registry = createRegistry(ALL_PACKS);
    const preview = await previewFix(registry, ctxT3, 'fix.config.restore-lkg', {
      target: 'harness/routing.yaml',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.plan.steps.join('\n')).toContain('2026-11-15T10-00-00.000Z');
    const outcome = await applyFix(registry, ctxT3, preview.plan);
    expect(outcome.ok).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(await fs.readFile(routingPath, 'utf8')).toBe(goodRouting);

    const log = await readFixLog(s.harnessDir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      fixId: 'fix.config.restore-lkg',
      target: 'harness/routing.yaml',
      ok: true,
      rolledBack: false,
    });
  });

  it('fix.proc.kill-orphans re-verifies pids at apply time and escalates SIGTERM to SIGKILL', async () => {
    const s = await makeTempSandbox();
    const s1 = path.join(s.hermesHome, 'session-homes', 's1');
    const s2 = path.join(s.hermesHome, 'session-homes', 's2');
    await Promise.all([fs.mkdir(s1, { recursive: true }), fs.mkdir(s2, { recursive: true })]);
    const s1Real = await fs.realpath(s1);
    const s2Real = await fs.realpath(s2);

    let phase: 'preview' | 'apply' | 'recheck' = 'preview';
    const alivePids = new Set([4242, 4243]);
    const signals: Array<{ pid: number; signal: string | number }> = [];

    const ctx = makeDoctorCtx(s, {
      orphanGraceMs: 5,
      sleep: async () => {},
      sendSignal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        if (sig === 0) {
          if (!alivePids.has(pid)) {
            const err = new Error('ESRCH') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          }
          return;
        }
        if (sig === 'SIGKILL') {
          alivePids.delete(pid);
          phase = 'recheck';
        }
      },
      exec: async (cmd): Promise<DoctorExecResult> => {
        if (cmd === 'ps') {
          if (phase === 'preview') {
            return {
              code: 0,
              stdout: ['  4242     1 sleep 600', '  4243     1 hermes-cindy chat'].join('\n'),
              stderr: '',
            };
          }
          if (phase === 'apply') {
            return {
              code: 0,
              // 4243 stopped being orphaned (ppid 500), 4244 appeared newly, only 4242 remains
              stdout: [
                '  4242     1 sleep 600',
                '  4243   500 hermes-cindy chat',
                '  4244     1 sleep 900',
              ].join('\n'),
              stderr: '',
            };
          }
          return { code: 0, stdout: '  4243   500 hermes-cindy chat\n', stderr: '' };
        }
        if (cmd === 'lsof') {
          return {
            code: 0,
            stdout: [
              `p4242\nfcwd\nn${s1Real}`,
              `p4243\nfcwd\nn${s2Real}`,
              `p4244\nfcwd\nn${s1Real}`,
            ].join('\n') + '\n',
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const registry = createRegistry(ALL_PACKS);
    const preview = await previewFix(registry, ctx, 'fix.proc.kill-orphans');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.plan.touches).toEqual(['pid:4242', 'pid:4243']);

    phase = 'apply';
    const outcome = await applyFix(registry, ctx, preview.plan);
    expect(outcome.ok).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.recheck[0]?.severity).toBe('ok');

    // Only pid 4242 was killed (SIGTERM -> poll(0) -> SIGKILL); 4243 and 4244 untouched
    const killedPids = new Set(signals.map((ev) => ev.pid));
    expect(killedPids).toEqual(new Set([4242]));
    expect(signals.some((ev) => ev.pid === 4242 && ev.signal === 'SIGTERM')).toBe(true);
    expect(signals.some((ev) => ev.pid === 4242 && ev.signal === 'SIGKILL')).toBe(true);
  });

  it('fix.proc.stale-socket moves stale unix socket aside and refuses live listener', async () => {
    const s = await makeTempSandbox();
    const sockPath = path.join(s.userDataDir, 'hermes-mgr', 'hermes-mgr.sock');
    const registry = createRegistry(ALL_PACKS);

    // Bind a live unix socket first -> fix must refuse
    const server = net.createServer((conn) => {
      conn.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          const req = JSON.parse(line) as { id?: string; method?: string };
          if (req.method === 'protocol/hello') {
            conn.write(`${JSON.stringify({ type: 'response', id: req.id, ok: true, result: { serverVersion: '0.3.2' } })}\n`);
          } else {
            conn.write(`${JSON.stringify({ type: 'response', id: req.id, ok: true, result: {} })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const ctx = makeDoctorCtx(s, { appRunning: false });
      const liveOutcome = await runFix(registry, ctx, 'fix.proc.stale-socket', {
        confirm: async () => true,
      });
      expect(liveOutcome.ok).toBe(false);
      await expect(fs.lstat(sockPath)).resolves.toBeDefined();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Leave a stale socket file behind -> fix moves it aside
    await fs.writeFile(sockPath, '', 'utf8');
    const ctxClosed = makeDoctorCtx(s, { appRunning: false });
    const staleOutcome = await runFix(registry, ctxClosed, 'fix.proc.stale-socket', {
      confirm: async () => true,
    });
    expect(staleOutcome.ok).toBe(true);
    expect(staleOutcome.rolledBack).toBe(false);
    await expect(fs.lstat(sockPath)).rejects.toThrow();

    const entries = await fs.readdir(path.dirname(sockPath));
    expect(entries.some((name) => name.startsWith('hermes-mgr.sock.stale-'))).toBe(true);
  });
});
