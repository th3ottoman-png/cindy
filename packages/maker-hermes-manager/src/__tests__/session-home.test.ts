import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  prepareSessionHome,
  reapOrphanGateways,
  removeSessionHome,
  sessionHomePath,
  sessionHomesRoot,
  stopSessionGateway,
  type GatewayProcessOps,
} from '../session-home.js';

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'session-home-test-'));
  fs.writeFileSync(path.join(base, 'config.yaml'), 'model:\n  default: fake/model\n');
  fs.writeFileSync(path.join(base, '.env'), 'FAKE_VAR=1\n');
  fs.writeFileSync(path.join(base, 'auth.json'), '{}\n');
  fs.mkdirSync(path.join(base, 'skills'));
  fs.writeFileSync(path.join(base, 'skills', 'one.md'), 'skill');
  fs.mkdirSync(path.join(base, 'installs'));
  fs.writeFileSync(path.join(base, 'installs', 'venv-marker'), 'venv');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('sessionHomePath', () => {
  it('is stable, lives under session-homes, and distinguishes ids that sanitize alike', () => {
    const a = sessionHomePath(base, 'abc/def');
    expect(sessionHomePath(base, 'abc/def')).toBe(a);
    expect(path.dirname(a)).toBe(sessionHomesRoot(base));
    expect(sessionHomePath(base, 'abc?def')).not.toBe(a);
    expect(path.basename(a)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('prepareSessionHome', () => {
  it('links shared items, skips missing ones, and writes a regular 0600 config copy', async () => {
    const prepared = await prepareSessionHome(base, 's1');
    expect(prepared.linked.sort()).toEqual(['.env', 'auth.json', 'installs', 'skills']);
    for (const item of prepared.linked) {
      const target = path.join(prepared.home, item);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(target)).toBe(path.join(base, item));
    }
    // A shared item missing from the base home is not created.
    expect(fs.existsSync(path.join(prepared.home, 'plugins'))).toBe(false);

    const config = path.join(prepared.home, 'config.yaml');
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(config, 'utf8')).toBe('model:\n  default: fake/model\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(config).mode & 0o777).toBe(0o600);
      expect(fs.statSync(prepared.home).mode & 0o777).toBe(0o700);
    }
  });

  it('never copies credentials: .env is a link to the base file, not a copy', async () => {
    const { home } = await prepareSessionHome(base, 's1');
    fs.writeFileSync(path.join(base, '.env'), 'FAKE_VAR=2\n');
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe('FAKE_VAR=2\n');
    expect(fs.lstatSync(path.join(home, '.env')).isSymbolicLink()).toBe(true);
  });

  it('is idempotent and picks up base config changes on the next call', async () => {
    const first = await prepareSessionHome(base, 's1');
    await prepareSessionHome(base, 's1');
    fs.writeFileSync(path.join(base, 'config.yaml'), 'model:\n  default: other/model\n');
    const again = await prepareSessionHome(base, 's1');
    expect(again.home).toBe(first.home);
    expect(fs.readFileSync(path.join(again.home, 'config.yaml'), 'utf8')).toContain('other/model');
    expect(fs.readdirSync(again.home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('applies transformConfig (the hook 1.5b-5c uses for shim entries)', async () => {
    const { home } = await prepareSessionHome(base, 's7', {
      transformConfig: (config, ctx) => `${config}# session ${ctx.sessionId}\n`,
    });
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toBe(
      'model:\n  default: fake/model\n# session s7\n',
    );
  });

  it('replaces a symlinked config.yaml with a regular file and leaves its target alone', async () => {
    const { home } = await prepareSessionHome(base, 's1');
    const shared = path.join(base, 'shared-config.yaml');
    fs.writeFileSync(shared, 'shared: true\n');
    fs.rmSync(path.join(home, 'config.yaml'));
    fs.symlinkSync(shared, path.join(home, 'config.yaml'));
    await prepareSessionHome(base, 's1');
    expect(fs.lstatSync(path.join(home, 'config.yaml')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(shared, 'utf8')).toBe('shared: true\n');
  });

  it('leaves a real file or directory the session home already owns, and reports it', async () => {
    const home = sessionHomePath(base, 's1');
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'mine.md'), 'mine');
    const prepared = await prepareSessionHome(base, 's1');
    expect(prepared.skipped).toContain('skills');
    expect(fs.existsSync(path.join(home, 'skills', 'mine.md'))).toBe(true);
    expect(fs.lstatSync(path.join(home, 'skills')).isSymbolicLink()).toBe(false);
  });

  it('refuses the configured daily home, and anything inside it, before touching the filesystem', async () => {
    const daily = path.join(base, 'fake-daily');
    const inside = path.join(daily, 'cindy-never-created');
    await expect(prepareSessionHome(daily, 's1', { dailyHome: daily })).rejects.toThrow(/daily Hermes home/);
    await expect(prepareSessionHome(inside, 's1', { dailyHome: daily })).rejects.toThrow(/daily Hermes home/);
    expect(fs.existsSync(daily)).toBe(false);
  });

  it('rejects shared item names that could escape the home', async () => {
    await expect(prepareSessionHome(base, 's1', { sharedItems: ['../x'] })).rejects.toThrow(/invalid shared item/);
    await expect(prepareSessionHome(base, 's1', { sharedItems: ['config.yaml'] })).rejects.toThrow(/invalid shared item/);
  });
});

describe('removeSessionHome', () => {
  it('removes the session home and its links but never the shared targets', async () => {
    const { home } = await prepareSessionHome(base, 's1');
    await removeSessionHome(base, 's1');
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.readFileSync(path.join(base, '.env'), 'utf8')).toBe('FAKE_VAR=1\n');
    expect(fs.readFileSync(path.join(base, 'skills', 'one.md'), 'utf8')).toBe('skill');
    expect(fs.readFileSync(path.join(base, 'installs', 'venv-marker'), 'utf8')).toBe('venv');
  });

  it('is a no-op for a home that does not exist', async () => {
    await expect(removeSessionHome(base, 'never-created')).resolves.toBeUndefined();
  });
});

describe('stopSessionGateway', () => {
  function pidFile(home: string, record: Record<string, unknown>): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'gateway.pid'), JSON.stringify(record));
  }

  function fakeOps(opts: { command?: string | null; diesOnTerm?: boolean; alive?: boolean }) {
    const state = { alive: opts.alive ?? true, signals: [] as string[] };
    const ops: GatewayProcessOps = {
      isAlive: () => state.alive,
      commandOf: async () => (opts.command === undefined ? '/x/python3 -m hermes_cli.main gateway run' : opts.command),
      kill: (_pid, signal) => {
        state.signals.push(signal);
        if (signal === 'SIGKILL' || opts.diesOnTerm !== false) state.alive = false;
      },
      sleep: async () => undefined,
    };
    return { ops, state };
  }

  it('reports no-pid-file when the home has none', async () => {
    const home = path.join(base, 'h');
    fs.mkdirSync(home);
    expect(await stopSessionGateway(home, fakeOps({}).ops)).toEqual({ stopped: false, reason: 'no-pid-file' });
  });

  it('refuses a record that is not a hermes gateway, names another home, or is not running', async () => {
    const home = path.join(base, 'h');
    pidFile(home, { pid: 4242, kind: 'something-else', hermes_home: home });
    expect(await stopSessionGateway(home, fakeOps({}).ops)).toMatchObject({ reason: 'not-a-gateway' });
    pidFile(home, { pid: 1, kind: 'hermes-gateway', hermes_home: home });
    expect(await stopSessionGateway(home, fakeOps({}).ops)).toMatchObject({ reason: 'not-a-gateway' });
    pidFile(home, { pid: 4242, kind: 'hermes-gateway', hermes_home: path.join(base, 'other') });
    expect(await stopSessionGateway(home, fakeOps({}).ops)).toMatchObject({ reason: 'wrong-home' });
    pidFile(home, { pid: 4242, kind: 'hermes-gateway', hermes_home: home });
    expect(await stopSessionGateway(home, fakeOps({ alive: false }).ops)).toMatchObject({ reason: 'not-running' });
  });

  it('never signals a pid whose command is not Hermes (stale pid reuse)', async () => {
    const home = path.join(base, 'h');
    pidFile(home, { pid: 4242, kind: 'hermes-gateway', hermes_home: home });
    const { ops, state } = fakeOps({ command: '/usr/bin/vim notes.txt' });
    expect(await stopSessionGateway(home, ops)).toEqual({ stopped: false, reason: 'not-hermes' });
    expect(state.signals).toEqual([]);
  });

  it('stops a gateway with SIGTERM', async () => {
    const home = path.join(base, 'h');
    pidFile(home, { pid: 4242, kind: 'hermes-gateway', hermes_home: home });
    const { ops, state } = fakeOps({});
    expect(await stopSessionGateway(home, ops)).toEqual({ stopped: true, forced: false });
    expect(state.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const home = path.join(base, 'h');
    pidFile(home, { pid: 4242, kind: 'hermes-gateway', hermes_home: home });
    const { ops, state } = fakeOps({ diesOnTerm: false });
    expect(await stopSessionGateway(home, ops, 0)).toEqual({ stopped: true, forced: true });
    expect(state.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('reapOrphanGateways', () => {
  it('stops gateways of session homes that are not registered and keeps registered ones', async () => {
    const keepHome = (await prepareSessionHome(base, 'keep')).home;
    const dropHome = (await prepareSessionHome(base, 'drop')).home;
    for (const home of [keepHome, dropHome]) {
      fs.writeFileSync(
        path.join(home, 'gateway.pid'),
        JSON.stringify({ pid: home === keepHome ? 1111 : 2222, kind: 'hermes-gateway', hermes_home: home }),
      );
    }
    const killed: number[] = [];
    const ops: GatewayProcessOps = {
      isAlive: (pid) => !killed.includes(pid),
      commandOf: async () => 'python3 -m hermes_cli.main gateway run',
      kill: (pid) => {
        killed.push(pid);
      },
      sleep: async () => undefined,
    };
    const reaped = await reapOrphanGateways(base, ['keep'], ops);
    expect(reaped).toEqual([path.basename(dropHome)]);
    expect(killed).toEqual([2222]);
    expect(fs.existsSync(dropHome)).toBe(true); // homes are kept; only the process is reaped
  });

  it('returns nothing when there is no session-homes directory', async () => {
    expect(await reapOrphanGateways(base, [])).toEqual([]);
  });
});
