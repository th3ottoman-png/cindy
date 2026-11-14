import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** A FIFO can only be created on POSIX; the planner guard itself is covered platform-free. */
const itPosix = process.platform === 'win32' ? it.skip : it;

import {
  defaultHousekeepingFile,
  readHousekeepingSettings,
  registerHousekeepingHandlers,
  scanStorage,
  writeHousekeepingSettings,
  type HousekeepingRoots,
} from '../housekeeping.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 86_400_000;

let tmp: string;
let roots: HousekeepingRoots;
let settingsFile: string;

/** Ages a directory and its direct entries, which is what the home idle notion reads. */
function age(target: string, ageDays: number): void {
  const when = new Date(NOW - ageDays * DAY);
  fs.utimesSync(target, when, when);
  for (const name of fs.readdirSync(target)) {
    const full = path.join(target, name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) continue;
    fs.utimesSync(full, when, when);
  }
}

function ageTree(target: string, ageDays: number): void {
  const when = new Date(NOW - ageDays * DAY);
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(full);
      fs.utimesSync(full, when, when);
    }
  }
  fs.utimesSync(target, when, when);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** A home with a transcript, a catalog, a uv cache and logs. */
function makeHome(name: string, ageDays: number): string {
  const home = path.join(roots.hermesHome, 'session-homes', name);
  write(path.join(home, 'state.db'), 'transcript');
  write(path.join(home, 'models_dev_cache.json'), 'x'.repeat(2048));
  write(path.join(home, 'cache', 'uv', 'wheel.bin'), 'y'.repeat(4096));
  write(path.join(home, 'logs', 'agent.log'), 'z'.repeat(512));
  ageTree(home, ageDays);
  return home;
}

function registry(records: { sessionId: string; running?: boolean }[]): void {
  write(path.join(roots.hermesHome, 'hermes-mgr', 'sessions.json'), JSON.stringify(records));
}

function scan(protectedIds: string[] = []) {
  return scanStorage({ roots, settingsFile, now: () => NOW, protectedSessionIds: () => protectedIds });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-housekeeping-'));
  roots = {
    hermesHome: path.join(tmp, '.hermes-cindy'),
    harnessDir: path.join(tmp, '.cindy-harness'),
    appLogDir: path.join(tmp, 'logs'),
  };
  settingsFile = path.join(roots.harnessDir, 'housekeeping.json');
  fs.mkdirSync(roots.hermesHome, { recursive: true });
  fs.mkdirSync(roots.harnessDir, { recursive: true });
  fs.mkdirSync(roots.appLogDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('housekeeping settings file', () => {
  it('defaults when the file is missing or corrupt', () => {
    expect(readHousekeepingSettings(settingsFile)).toEqual({ retentionDays: 30, pruneAtStartup: false });
    write(settingsFile, '{not json');
    expect(readHousekeepingSettings(settingsFile)).toEqual({ retentionDays: 30, pruneAtStartup: false });
  });
  it('round-trips through an atomic write and clamps the minimum', () => {
    const written = writeHousekeepingSettings(settingsFile, { retentionDays: 14, pruneAtStartup: false });
    expect(written.retentionDays).toBe(14);
    expect(readHousekeepingSettings(settingsFile)).toEqual({ retentionDays: 14, pruneAtStartup: false });
    expect(writeHousekeepingSettings(settingsFile, { retentionDays: 2, pruneAtStartup: false }).retentionDays).toBe(7);
    expect(fs.readdirSync(roots.harnessDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('never turns pruneAtStartup on by accident', () => {
    write(settingsFile, JSON.stringify({ retentionDays: 20, pruneAtStartup: 'yes' }));
    expect(readHousekeepingSettings(settingsFile).pruneAtStartup).toBe(false);
  });
  it('resolves the default file under the harness dir', () => {
    expect(defaultHousekeepingFile('/home/x')).toBe(path.join('/home/x', '.cindy-harness', 'housekeeping.json'));
  });
});

describe('scanStorage — buckets', () => {
  it('measures homes, catalogs, cache, backups and logs', () => {
    makeHome('aaaa-0123456789', 40);
    makeHome('bbbb-0123456789', 2);
    registry([{ sessionId: 'aaaa' }, { sessionId: 'bbbb' }]);
    write(path.join(roots.hermesHome, 'cache', 'uv', 'w.bin'), 'a'.repeat(1000));
    ageTree(path.join(roots.hermesHome, 'cache'), 40);
    write(path.join(roots.harnessDir, 'routing.yaml.bak-old'), 'old');
    fs.utimesSync(path.join(roots.harnessDir, 'routing.yaml.bak-old'), new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
    write(path.join(roots.appLogDir, 'dev-terminal (1).log'), 'l'.repeat(300));
    fs.utimesSync(path.join(roots.appLogDir, 'dev-terminal (1).log'), new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));

    const view = scan();
    expect(view.sessionHomes.count).toBe(2);
    expect(view.sessionHomes.totalBytes).toBeGreaterThan(0);
    expect(view.modelCatalogCopies.count).toBe(2);
    expect(view.modelCatalogCopies.totalBytes).toBe(4096);
    expect(view.hermesUvCache.totalBytes).toBe(1000);
    expect(view.harnessBackups.count).toBe(1);
    expect(view.devTerminalLogs.count).toBe(1);
    expect(view.devTerminalLogs.totalBytes).toBe(300);
    expect(view.truncated).toBe(false);
    expect(view.scannedAt).toBe(NOW);
  });
  it('survives missing roots without throwing', () => {
    const view = scanStorage({
      roots: { hermesHome: path.join(tmp, 'nope'), harnessDir: path.join(tmp, 'nope2'), appLogDir: path.join(tmp, 'nope3') },
      settingsFile,
      now: () => NOW,
    });
    expect(view.sessionHomes).toEqual({ count: 0, totalBytes: 0 });
    expect(view.preview).toEqual([]);
    expect(view.estimatedFreedBytes).toBe(0);
  });
  it('reports a lower bound when the scan budget is exhausted', () => {
    makeHome('aaaa-0123456789', 40);
    const view = scanStorage({ roots, settingsFile, now: () => NOW, budgetMs: -1 });
    expect(view.truncated).toBe(true);
  });
});

describe('scanStorage — preview follows ADR 0014', () => {
  it('plans an orphan home for removal but keeps a registered one', () => {
    makeHome('aaaa-0123456789', 40);
    makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb' }]);
    const view = scan();
    expect(view.orphanHomes.count).toBe(1);
    const whole = view.preview.filter((d) => d.kind === 'session-home');
    expect(whole).toHaveLength(1);
    expect(whole[0]!.path).toContain('aaaa-0123456789');
    expect(whole[0]!.reason).toBe('orphan-home');
  });
  it('does not double-count an orphan home and the bulk inside it', () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const view = scan();
    const whole = view.preview.find((d) => d.kind === 'session-home');
    expect(whole).toBeDefined();
    // The whole home goes, so nothing inside it may be listed (or counted) again.
    expect(view.preview.filter((d) => d.path.startsWith(home + path.sep))).toEqual([]);
    expect(view.estimatedFreedBytes).toBe(whole!.sizeBytes);
    expect(view.reclaimableItems).toBe(1);
  });
  it('never plans a transcript, even inside an orphan home', () => {
    makeHome('aaaa-0123456789', 40);
    registry([]);
    const view = scan();
    expect(view.preview.some((d) => d.path.endsWith('state.db'))).toBe(false);
  });
  it('plans idle catalog copies inside a registered home', () => {
    makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb' }]);
    const view = scan();
    const catalog = view.preview.find((d) => d.kind === 'home-model-catalog');
    expect(catalog?.reason).toBe('recreatable-home-bulk');
    expect(catalog?.sizeBytes).toBe(2048);
  });
  it('keeps a recent home out of the preview entirely', () => {
    makeHome('bbbb-0123456789', 3);
    registry([{ sessionId: 'bbbb' }]);
    expect(scan().preview).toEqual([]);
  });
  it('protects the bulk of a running session', () => {
    makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb', running: true }]);
    expect(scan().preview).toEqual([]);
  });
  it('protects the bulk of a session the caller reports as open', () => {
    makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb' }]);
    expect(scan(['bbbb']).preview).toEqual([]);
  });
  it('never follows a symlinked installs directory', () => {
    const home = makeHome('aaaa-0123456789', 40);
    const outside = path.join(tmp, 'outside-venv');
    write(path.join(outside, 'big.bin'), 'q'.repeat(5000));
    fs.symlinkSync(outside, path.join(home, 'installs'));
    age(home, 40);
    registry([]);
    const view = scan();
    expect(view.preview.some((d) => d.path.includes('outside-venv'))).toBe(false);
    // Only the home's own bytes: 10 transcript + 2048 catalog + 4096 uv + 512 log. The 5000-byte
    // file behind the symlink must not be counted.
    expect(view.sessionHomes.totalBytes).toBe(6666);
  });
  it('keeps the newest backup of each base file and plans the older ones', () => {
    for (const [name, days] of [['routing.yaml.bak-a', 90], ['routing.yaml.bak-b', 40]] as const) {
      const file = path.join(roots.harnessDir, name);
      write(file, 'backup');
      fs.utimesSync(file, new Date(NOW - days * DAY), new Date(NOW - days * DAY));
    }
    const view = scan();
    expect(view.preview.filter((d) => d.kind === 'harness-backup').map((d) => path.basename(d.path))).toEqual(['routing.yaml.bak-a']);
  });
  itPosix('plans an old dev-terminal log but never the fifo', () => {
    const old = path.join(roots.appLogDir, 'dev-terminal (1).log');
    write(old, 'x');
    fs.utimesSync(old, new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
    const fifo = path.join(roots.appLogDir, 'dev-terminal.log.fifo');
    execFileSync('mkfifo', [fifo]);
    const view = scan();
    expect(view.preview.some((d) => d.path === old)).toBe(true);
    expect(view.preview.some((d) => d.path === fifo)).toBe(false);
  });
  it('treats a home as idle when only its SQLite -shm sidecar was touched', () => {
    // Opening state.db refreshes state.db-shm even with no turn, so the raw newest mtime would
    // make every home look used today and retention would never fire (observed live 2026-11-14).
    const home = makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb' }]);
    fs.writeFileSync(path.join(home, 'state.db-shm'), 'shm');
    // Creating the sidecar bumps the directory mtime; in the real home it already existed.
    const old = new Date(NOW - 40 * DAY);
    fs.utimesSync(home, old, old);
    const view = scan();
    const catalog = view.preview.find((d) => d.kind === 'home-model-catalog');
    expect(catalog?.reason).toBe('recreatable-home-bulk');
  });
  it('honours a shorter retention from the settings file', () => {
    makeHome('aaaa-0123456789', 20);
    registry([]);
    writeHousekeepingSettings(settingsFile, { retentionDays: 14, pruneAtStartup: false });
    const view = scan();
    expect(view.settings.retentionDays).toBe(14);
    expect(view.preview.some((d) => d.kind === 'session-home')).toBe(true);
  });
});

describe('registerHousekeepingHandlers', () => {
  function harness() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const trusted: unknown[] = [];
    registerHousekeepingHandlers(
      { handle: (channel, listener) => { handlers.set(channel, listener); } },
      {
        roots,
        settingsFile,
        assertTrusted: (event) => { trusted.push(event); },
        channels: { SCAN: 'scan', SET_RETENTION: 'set' },
      },
    );
    return { handlers, trusted };
  }

  it('scan asserts trust and returns a view', async () => {
    makeHome('aaaa-0123456789', 40);
    registry([]);
    const { handlers, trusted } = harness();
    const view = await handlers.get('scan')!({ ipc: true }) as ReturnType<typeof scan>;
    expect(trusted).toHaveLength(1);
    expect(view.sessionHomes.count).toBe(1);
    expect(view.reclaimableItems).toBeGreaterThan(0);
  });

  it('set-retention persists, clamps and re-scans', async () => {
    makeHome('aaaa-0123456789', 20);
    registry([]);
    const { handlers } = harness();
    const view = await handlers.get('set')!({}, { retentionDays: 14 }) as ReturnType<typeof scan>;
    expect(view.settings.retentionDays).toBe(14);
    expect(readHousekeepingSettings(settingsFile).retentionDays).toBe(14);
    expect(view.preview.some((d) => d.kind === 'session-home')).toBe(true);
    const clamped = await handlers.get('set')!({}, { retentionDays: 1 }) as ReturnType<typeof scan>;
    expect(clamped.settings.retentionDays).toBe(7);
  });

  it('set-retention refuses a non-number', async () => {
    const { handlers } = harness();
    await expect(handlers.get('set')!({}, { retentionDays: '14' })).rejects.toThrow('retentionDays must be a number');
    await expect(handlers.get('set')!({}, undefined)).rejects.toThrow('retentionDays must be a number');
  });
});
