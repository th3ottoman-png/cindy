import { describe, expect, it, vi } from 'vitest';
import { ServiceSupervisor, type ChildHandle } from '../serviceSupervisor.js';
import type { ExecFn } from '../devServerDiscovery.js';

function makeChild(pid = 4242): ChildHandle & {
  killed: string[];
  exitFns: Array<(code: number | null, signal: string | null) => void>;
  dataFns: Array<(chunk: string) => void>;
  emitExit: (code?: number | null, signal?: string | null) => void;
  emitData: (chunk: string) => void;
} {
  const exitFns: Array<(code: number | null, signal: string | null) => void> = [];
  const dataFns: Array<(chunk: string) => void> = [];
  const killed: string[] = [];
  return {
    pid,
    killed,
    exitFns,
    dataFns,
    on: (event, cb) => {
      if (event === 'exit') exitFns.push(cb);
    },
    onData: (cb) => {
      dataFns.push(cb);
    },
    kill: (signal) => {
      killed.push(signal);
    },
    emitExit: (code = 0, signal = null) => {
      for (const fn of [...exitFns]) fn(code, signal);
    },
    emitData: (chunk) => {
      for (const fn of [...dataFns]) fn(chunk);
    },
  };
}

const LSOF_EMPTY: ExecFn = async () => ({ stdout: 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n', stderr: '' });

function lsofWith(port: number): ExecFn {
  return async (cmd) => {
    if (cmd === 'lsof') {
      return {
        stdout: `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 111 u 1u IPv4 0 0t0 TCP 127.0.0.1:${port} (LISTEN)\n`,
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('ServiceSupervisor.start (ROADMAP 11.6)', () => {
  it('validates spec input and fails closed', async () => {
    const sup = new ServiceSupervisor({ execFn: LSOF_EMPTY, now: () => 1000 });
    await expect(sup.start({ name: '', command: 'x' })).resolves.toMatchObject({ ok: false });
    await expect(sup.start({ name: 'web', command: '' })).resolves.toMatchObject({ ok: false });
    await expect(sup.start({ name: 'web', command: 'x', port: 99999 })).resolves.toMatchObject({ ok: false });
  });

  it('refuses to spawn onto an already-taken port', async () => {
    const spawnFn = vi.fn();
    const sup = new ServiceSupervisor({ spawnFn, execFn: lsofWith(5173), now: () => 1000 });
    const res = await sup.start({ name: 'web', command: 'npx vite --port 5173', port: 5173 });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('already in use') });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns, captures logs, and lists the service as running', async () => {
    const child = makeChild();
    const sup = new ServiceSupervisor({
      spawnFn: () => child,
      execFn: LSOF_EMPTY,
      now: () => 1000,
    });
    const res = await sup.start({ name: 'web', command: 'npx vite --port 5173', cwd: '/tmp/x', port: 5173 });
    expect(res).toMatchObject({ ok: true, pid: 4242 });
    child.emitData('  VITE ready in 100 ms\n\n  ➜  Local: http://localhost:5173/\n');
    const { services } = await sup.list();
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      id: 'svc:svc-1',
      name: 'web',
      pid: 4242,
      ports: [5173],
      running: true,
      source: 'supervised',
      manageable: true,
    });
    const logs = sup.getLogs(res.id as string);
    expect(logs).toMatchObject({ ok: true, lines: expect.arrayContaining([expect.stringContaining('VITE ready')]) });
  });

  it('marks spawn failure without throwing', async () => {
    const sup = new ServiceSupervisor({
      spawnFn: () => {
        throw new Error('bad cwd');
      },
      execFn: LSOF_EMPTY,
      now: () => 1000,
    });
    const res = await sup.start({ name: 'web', command: 'true' });
    expect(res).toMatchObject({ ok: false, error: 'bad cwd' });
  });
});

describe('ServiceSupervisor.stop/restart (ROADMAP 11.6)', () => {
  it('stops gracefully with SIGTERM and reports not forced', async () => {
    const child = makeChild();
    const alive = new Set([4242]);
    const sup = new ServiceSupervisor({
      spawnFn: () => child,
      killFn: (pid, signal) => {
        child.killed.push(signal);
        if (signal === 'SIGTERM') {
          alive.delete(pid);
          child.emitExit(0, null);
        }
      },
      isAliveFn: (pid) => alive.has(pid),
      execFn: LSOF_EMPTY,
      now: () => 1000,
      graceMs: 10,
    });
    const started = await sup.start({ name: 'web', command: 'node server.js' });
    const res = await sup.stop(started.id as string);
    expect(res).toMatchObject({ ok: true, forced: false });
    expect(child.killed).toEqual(['SIGTERM']);
    const { services } = await sup.list();
    expect(services[0].running).toBe(false);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const child = makeChild();
    const sup = new ServiceSupervisor({
      spawnFn: () => child,
      killFn: (pid, signal) => {
        child.killed.push(signal);
        if (signal === 'SIGKILL') child.emitExit(null, 'SIGKILL');
      },
      isAliveFn: () => true,
      execFn: LSOF_EMPTY,
      now: () => 1000,
      graceMs: 5,
    });
    const started = await sup.start({ name: 'stubborn', command: 'node server.js' });
    const res = await sup.stop(started.id as string);
    expect(res).toMatchObject({ ok: true, forced: true });
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('restarts by reusing the stored spec', async () => {
    const first = makeChild(1111);
    const second = makeChild(2222);
    const spawned: string[] = [];
    const sup = new ServiceSupervisor({
      spawnFn: (command) => {
        spawned.push(command);
        return spawned.length === 1 ? first : second;
      },
      killFn: (pid, signal) => {
        const target = pid === 1111 ? first : second;
        target.killed.push(signal);
        target.emitExit(0, null);
      },
      isAliveFn: () => false,
      execFn: LSOF_EMPTY,
      now: () => 1000,
      graceMs: 5,
    });
    const started = await sup.start({ name: 'web', command: 'node server.js' });
    const restarted = await sup.restart(started.id as string);
    expect(restarted.ok).toBe(true);
    expect(spawned).toEqual(['node server.js', 'node server.js']);
    const { services } = await sup.list();
    expect(services).toHaveLength(1);
    expect(services[0].pid).toBe(2222);
  });

  it('returns a clear error for unknown ids', async () => {
    const sup = new ServiceSupervisor({ execFn: LSOF_EMPTY });
    await expect(sup.stop('svc-nope')).resolves.toMatchObject({ ok: false });
    await expect(sup.restart('svc-nope')).resolves.toMatchObject({ ok: false });
    expect(sup.getLogs('svc-nope')).toMatchObject({ ok: false });
  });
});

describe('ServiceSupervisor discovery merge (ROADMAP 11.6)', () => {
  const LSOF_VITE: ExecFn = async (cmd) => {
    if (cmd === 'lsof') {
      return {
        stdout:
          'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n' +
          'node 7777 u 1u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)\n',
        stderr: '',
      };
    }
    return { stdout: ' 7777 /opt/node/bin/node /work/node_modules/.bin/vite --port 3000\n', stderr: '' };
  };

  it('lists externally started dev servers as discovered and manageable', async () => {
    const sup = new ServiceSupervisor({ execFn: LSOF_VITE, now: () => 1000, discoveryCacheMs: 60_000 });
    const { services } = await sup.list();
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      id: 'ext:7777',
      pid: 7777,
      ports: [3000],
      running: true,
      source: 'discovered',
      manageable: true,
    });
  });

  it('refuses to terminate a discovered pid whose command changed', async () => {
    const killFn = vi.fn();
    const sup = new ServiceSupervisor({ execFn: LSOF_VITE, killFn, now: () => 1000, graceMs: 5 });
    const res = await sup.terminateDiscovered(7777, 'postgres -D /data');
    expect(res).toMatchObject({ ok: false });
    expect(killFn).not.toHaveBeenCalled();
  });
});
