/**
 * Storage housekeeping — the Prune action (ROADMAP 13.2c, ADR 0014).
 *
 * Deletion is the only irreversible thing in this feature, so these tests pin the guards:
 * owner-confirmed paths only, a fresh plan (never a stale preview), no symlink, no transcript,
 * a live gateway blocks its home, and every refusal is reported with a reason.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pruneStorage,
  readHousekeepingSettings,
  registerHousekeepingHandlers,
  runStartupHousekeeping,
  scanStorage,
  writeHousekeepingSettings,
  type ConversationFacts,
  type HousekeepingRoots,
  type PruneResult,
} from '../housekeeping.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 86_400_000;

let tmp: string;
let roots: HousekeepingRoots;
let settingsFile: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
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

function makeHome(name: string, ageDays: number): string {
  const home = path.join(roots.hermesHome, 'session-homes', name);
  write(path.join(home, 'state.db'), 'transcript');
  write(path.join(home, 'models_dev_cache.json'), 'x'.repeat(2048));
  write(path.join(home, 'models_dev_cache.etag'), 'etag');
  write(path.join(home, 'cache', 'uv', 'wheel.bin'), 'y'.repeat(4096));
  write(path.join(home, 'logs', 'agent.log'), 'z'.repeat(512));
  ageTree(home, ageDays);
  return home;
}

function registry(records: { sessionId: string; hermesSessionId?: string; running?: boolean }[]): void {
  write(path.join(roots.hermesHome, 'hermes-mgr', 'sessions.json'), JSON.stringify(records));
}

function scan(facts?: ConversationFacts) {
  return scanStorage({ roots, settingsFile, now: () => NOW, ...(facts ? { facts } : {}) });
}

function prune(confirmedPaths: readonly string[], deps: Record<string, unknown> = {}): Promise<PruneResult> {
  return pruneStorage({ roots, settingsFile, now: () => NOW, ...deps }, { confirmedPaths });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-prune-'));
  roots = {
    hermesHome: path.join(tmp, '.hermes-cindy'),
    harnessDir: path.join(tmp, '.cindy-harness'),
    appLogDir: path.join(tmp, 'logs'),
  };
  settingsFile = path.join(roots.harnessDir, 'housekeeping.json');
  for (const dir of [roots.hermesHome, roots.harnessDir, roots.appLogDir]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('scanStorage — the Cindy conversation join (13.2c)', () => {
  it('keeps a soft-deleted home but reclaims the bulk inside it', () => {
    const home = makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb', hermesSessionId: 'sdk-b' }]);
    const view = scan({ bySdkSessionId: { 'sdk-b': { status: 'deleted', protected: false } } });
    expect(view.preview.some((d) => d.path === home)).toBe(false);
    const catalog = view.preview.find((d) => d.kind === 'home-model-catalog');
    expect(catalog?.reason).toBe('soft-deleted-home-bulk');
    expect(fs.existsSync(path.join(home, 'state.db'))).toBe(true);
  });

  it('protects every entry of a home whose conversation is open / running / scheduled / pinned', () => {
    makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb', hermesSessionId: 'sdk-b' }]);
    const view = scan({ bySdkSessionId: { 'sdk-b': { status: 'active', protected: true } } });
    expect(view.preview).toEqual([]);
    expect(view.reclaimableItems).toBe(0);
  });

  it('leaves an active conversation home alone without the protected flag', () => {
    makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb', hermesSessionId: 'sdk-b' }]);
    const view = scan({ bySdkSessionId: { 'sdk-b': { status: 'active', protected: false } } });
    expect(view.preview.some((d) => d.kind === 'session-home')).toBe(false);
    expect(view.preview.some((d) => d.kind === 'home-model-catalog')).toBe(true);
  });

  it('plans the catalog etag with the catalog so no stale validator survives', () => {
    const home = makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb' }]);
    const view = scan();
    expect(view.preview.some((d) => d.path === path.join(home, 'models_dev_cache.json'))).toBe(true);
    expect(view.preview.some((d) => d.path === path.join(home, 'models_dev_cache.etag'))).toBe(true);
  });
});
describe('scanStorage — a flushed registry authorises a recent orphan (13.2c)', () => {
  it('plans an orphan home younger than 24 h when sessions.json was written after it', () => {
    const home = makeHome('aaaa-0123456789', 0);
    const when = new Date(NOW - 2 * 60 * 60 * 1000);
    fs.utimesSync(home, when, when);
    for (const name of fs.readdirSync(home)) fs.utimesSync(path.join(home, name), when, when);
    registry([]);
    const regFile = path.join(roots.hermesHome, 'hermes-mgr', 'sessions.json');
    fs.utimesSync(regFile, new Date(NOW - 60_000), new Date(NOW - 60_000));
    const view = scan();
    expect(view.preview.some((d) => d.path === home && d.reason === 'orphan-home')).toBe(true);
  });

  it('keeps an orphan home younger than 24 h when sessions.json is older', () => {
    const home = makeHome('aaaa-0123456789', 0);
    const when = new Date(NOW - 2 * 60 * 60 * 1000);
    fs.utimesSync(home, when, when);
    for (const name of fs.readdirSync(home)) fs.utimesSync(path.join(home, name), when, when);
    registry([]);
    const regFile = path.join(roots.hermesHome, 'hermes-mgr', 'sessions.json');
    fs.utimesSync(regFile, new Date(NOW - 3 * 60 * 60 * 1000), new Date(NOW - 3 * 60 * 60 * 1000));
    const view = scan();
    expect(view.preview.some((d) => d.path === home)).toBe(false);
  });
});

describe('pruneStorage — what it may remove', () => {
  it('removes a confirmed orphan home and reports the freed bytes', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const result = await prune([home]);
    expect(fs.existsSync(home)).toBe(false);
    expect(result.deleted.map((d) => d.path)).toEqual([home]);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    expect(result.prunedAt).toBe(NOW);
  });

  it('removes an orphan home idle past 24 h even at the default 30-day retention', async () => {
    const home = makeHome('aaaa-0123456789', 0);
    const when = new Date(NOW - 25 * 60 * 60 * 1000);
    fs.utimesSync(home, when, when);
    for (const name of fs.readdirSync(home)) fs.utimesSync(path.join(home, name), when, when);
    registry([]);
    expect(readHousekeepingSettings(settingsFile).retentionDays).toBe(30);
    const result = await prune([home]);
    expect(fs.existsSync(home)).toBe(false);
    expect(result.deleted[0]?.reason).toBe('orphan-home');
  });

  it('never removes a transcript, even when the owner confirms its path', async () => {
    const home = makeHome('bbbb-0123456789', 40);
    registry([{ sessionId: 'bbbb' }]);
    const transcript = path.join(home, 'state.db');
    const result = await prune([transcript]);
    expect(fs.existsSync(transcript)).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.skipped.some((d) => d.path === transcript && d.reason === 'transcript-never-pruned')).toBe(true);
  });

  it('removes only the paths the owner confirmed', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    write(path.join(roots.appLogDir, 'dev-terminal (1).log'), 'l'.repeat(300));
    const log = path.join(roots.appLogDir, 'dev-terminal (1).log');
    const old = new Date(NOW - 60 * DAY);
    fs.utimesSync(log, old, old);
    const result = await prune([home]);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(log)).toBe(true);
    expect(result.skipped.some((d) => d.path === log && d.reason === 'not-confirmed')).toBe(true);
  });

  it('re-plans instead of trusting a stale preview', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const stale = scan().preview.map((d) => d.path);
    // The session comes back into the registry between preview and confirm.
    registry([{ sessionId: 'aaaa' }]);
    const result = await prune(stale);
    expect(fs.existsSync(home)).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.skipped.some((d) => d.path === home && d.reason === 'no-longer-eligible')).toBe(true);
  });

  it('refuses a path that became a symlink after the preview', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const link = path.join(roots.hermesHome, 'session-homes', 'cccc-0123456789');
    fs.symlinkSync(home, link);
    const result = await prune([link]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(home)).toBe(true);
    expect(result.deleted).toEqual([]);
  });

  it('refuses a path outside the expected roots', async () => {
    const outside = path.join(tmp, 'precious');
    write(outside, 'keep me');
    const result = await prune([outside]);
    expect(fs.existsSync(outside)).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.skipped.some((d) => d.path === outside)).toBe(true);
  });

  it('reports a path that is already gone without failing the run', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const result = await prune([home, path.join(roots.appLogDir, 'dev-terminal-vanished.log')]);
    expect(fs.existsSync(home)).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.skipped.some((d) => d.reason === 'already-gone')).toBe(true);
  });

  it('keeps a home whose gateway is still running and says why', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const result = await prune([home], { stopGateway: async () => ({ stopped: false, reason: 'timeout' }) });
    expect(fs.existsSync(home)).toBe(true);
    expect(result.skipped.some((d) => d.path === home && d.reason === 'gateway-still-running')).toBe(true);
  });

  it('stops the gateway before removing the home', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const stopped: string[] = [];
    const result = await prune([home], {
      stopGateway: async (target: string) => { stopped.push(target); return { stopped: true, forced: false }; },
    });
    expect(stopped).toEqual([home]);
    expect(fs.existsSync(home)).toBe(false);
    expect(result.deleted).toHaveLength(1);
  });

  it('reads the real gateway.pid file: a dead pid does not block the removal', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    write(path.join(home, 'gateway.pid'), JSON.stringify({ pid: 999999, kind: 'hermes-gateway', hermes_home: home }));
    // Writing the pid file bumps the home's mtime; in a real home it already existed.
    const when = new Date(NOW - 40 * DAY);
    fs.utimesSync(home, when, when);
    fs.utimesSync(path.join(home, 'gateway.pid'), when, when);
    const result = await prune([home]);
    expect(fs.existsSync(home)).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('reports a deletion error instead of throwing, and keeps going', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const log = path.join(roots.appLogDir, 'dev-terminal (1).log');
    write(log, 'l'.repeat(300));
    const old = new Date(NOW - 60 * DAY);
    fs.utimesSync(log, old, old);
    const result = await prune([home, log], {
      remove: (target: string) => { if (target === home) throw new Error('EBUSY'); fs.rmSync(target, { recursive: true }); },
    });
    expect(result.errors).toEqual([{ path: home, message: 'EBUSY' }]);
    expect(fs.existsSync(log)).toBe(false);
    expect(result.deleted.map((d) => d.path)).toEqual([log]);
  });

  it('reports a measured free-space delta alongside the size estimate', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const result = await prune([home]);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.measuredFreedBytes === null || typeof result.measuredFreedBytes === 'number').toBe(true);
  });

  it('does nothing when nothing is confirmed', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const result = await prune([]);
    expect(fs.existsSync(home)).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.freedBytes).toBe(0);
  });
});

describe('registerHousekeepingHandlers — prune and startup (13.2c)', () => {
  function harness(extra: Record<string, unknown> = {}) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const trusted: unknown[] = [];
    registerHousekeepingHandlers(
      { handle: (channel, listener) => { handlers.set(channel, listener); } },
      {
        roots,
        settingsFile,
        assertTrusted: (event) => { trusted.push(event); },
        channels: { SCAN: 'scan', SET_RETENTION: 'set', PRUNE: 'prune', SET_PRUNE_AT_STARTUP: 'startup' },
        ...extra,
      },
    );
    return { handlers, trusted };
  }

  it('prune asserts trust and returns a result', async () => {
    const home = makeHome('aaaa-0123456789', 40);
    registry([]);
    const { handlers, trusted } = harness();
    const result = await handlers.get('prune')!({ ipc: true }, { confirmedPaths: [home] }) as PruneResult;
    expect(trusted).toHaveLength(1);
    expect(result.deleted.map((d) => d.path)).toEqual([home]);
  });

  it('prune refuses a malformed request', async () => {
    const { handlers } = harness();
    await expect(handlers.get('prune')!({}, {})).rejects.toThrow('confirmedPaths must be an array of strings');
    await expect(handlers.get('prune')!({}, { confirmedPaths: [1] })).rejects.toThrow('confirmedPaths must be an array of strings');
  });

  it('set-prune-at-startup persists only an explicit true', async () => {
    const { handlers } = harness();
    const on = await handlers.get('startup')!({}, { enabled: true }) as { settings: { pruneAtStartup: boolean } };
    expect(on.settings.pruneAtStartup).toBe(true);
    expect(readHousekeepingSettings(settingsFile).pruneAtStartup).toBe(true);
    const off = await handlers.get('startup')!({}, { enabled: 'yes' }) as { settings: { pruneAtStartup: boolean } };
    expect(off.settings.pruneAtStartup).toBe(false);
  });

  it('startup prune protects every registered session because no window is open yet', async () => {
    const owned = makeHome('bbbb-0123456789', 40);
    const orphan = makeHome('aaaa-0123456789', 40);
    registry([{ sessionId: 'bbbb' }]);
    writeHousekeepingSettings(settingsFile, { retentionDays: 7, pruneAtStartup: true });
    const result = await runStartupHousekeeping({ roots, settingsFile, now: () => NOW });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(owned, 'models_dev_cache.json'))).toBe(true);
    expect(result?.deleted.map((d) => d.path)).toEqual([orphan]);
  });

  it('startup prune is off by default', async () => {
    const orphan = makeHome('aaaa-0123456789', 40);
    registry([]);
    const result = await runStartupHousekeeping({ roots, settingsFile, now: () => NOW });
    expect(result).toBeNull();
    expect(fs.existsSync(orphan)).toBe(true);
  });
});