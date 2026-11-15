import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DoctorPack } from '@cindy/maker-core/doctor';

import { DesktopDoctorHost, registerDoctorHandlers } from '../doctor';
import { MAKER_INVOKE } from '../channels';
import { IpcHarness } from './helpers/ipcHarness';

const tempDirs: string[] = [];

async function makeTempEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-doctor-test-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const repoRoot = path.join(root, 'repo');

  await Promise.all([
    fs.mkdir(hermesHome, { recursive: true }),
    fs.mkdir(harnessDir, { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(repoRoot, { recursive: true }),
  ]);

  // Seed files allowed in LKG snapshots so createLkgSnapshot works cleanly
  await fs.writeFile(
    path.join(harnessDir, 'routing.yaml'),
    'routes:\n  local-small:\n    provider: lmstudio\n    model: qwen3-8b\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'providers.yaml'),
    'providers:\n  - id: lmstudio\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
    'utf8',
  );

  return { root, home, hermesHome, harnessDir, userDataDir, repoRoot };
}

function makePack(options: { initialBroken?: boolean; needsAppClosed?: boolean } = {}): {
  pack: DoctorPack;
  state: { broken: boolean };
} {
  const state = { broken: options.initialBroken ?? false };
  const pack: DoctorPack = {
    name: 'fake-doctor-pack',
    checks: [
      {
        id: 'config.fake-route',
        layer: 'config',
        title: 'Fake route integrity',
        cost: 'instant',
        run: async () => ({
          severity: state.broken ? 'fail' : 'ok',
          summary: state.broken ? 'Broken route detected' : 'Routes valid',
          action: state.broken ? 'Run doctor fix' : undefined,
          fixIds: state.broken ? ['fix.fake-route'] : undefined,
        }),
      },
      {
        id: 'data.fake-ok',
        layer: 'data',
        title: 'Fake fast ok check',
        cost: 'fast',
        run: async () => ({
          severity: 'ok',
          summary: 'SQLite ok',
        }),
      },
      {
        id: 'runtimes.slow-probe',
        layer: 'runtimes',
        title: 'Fake slow probe',
        cost: 'slow',
        run: async () => ({
          severity: 'ok',
          summary: 'Runtime probe ok',
        }),
      },
    ],
    fixes: [
      {
        id: 'fix.fake-route',
        title: 'Repair broken route',
        risk: 'moves-files',
        needsAppClosed: Boolean(options.needsAppClosed),
        recheck: ['config.fake-route'],
        preview: async (ctx) => ({
          fixId: 'fix.fake-route',
          steps: ['Reset broken flag cleanly'],
          touches: [path.join(ctx.paths.harnessDir, 'routing.yaml')],
          requiresAppClosed: Boolean(options.needsAppClosed),
        }),
        apply: async () => {
          state.broken = false;
          return {
            ok: true,
            rolledBack: false,
            message: 'Repaired broken route',
            recheck: [],
          };
        },
      },
    ],
  };

  return { pack, state };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('DesktopDoctorHost & IPC handlers (ROADMAP 14.8)', () => {
  it('registers all maker:doctor:* handlers and enforces trust checks', async () => {
    const env = await makeTempEnv();
    const { pack } = makePack({ initialBroken: true });
    const host = new DesktopDoctorHost({
      home: env.home,
      hermesHome: env.hermesHome,
      harnessDir: env.harnessDir,
      userDataDir: env.userDataDir,
      repoRoot: env.repoRoot,
      hostNode: '22.23.4',
      loadNativeSqlite: () => {},
      sqliteQuickCheck: () => ['ok'],
      packs: [pack],
    });

    const harness = new IpcHarness();
    const assertTrusted = vi.fn();
    registerDoctorHandlers(harness, { host, assertTrusted });

    const initialState = await harness.invoke(MAKER_INVOKE.DOCTOR_GET_STATE);
    expect(assertTrusted).toHaveBeenCalledTimes(1);
    expect(initialState).toMatchObject({
      hasFailure: false,
      running: false,
      runOnStart: true,
    });

    const report = (await harness.invoke(MAKER_INVOKE.DOCTOR_RUN, {})) as {
      counts: { ok: number; fail: number };
      results: Array<{ id: string }>;
    };
    // Default run omits slow check
    expect(report.counts).toMatchObject({ ok: 1, fail: 1 });
    expect(report.results.some((r) => r.id === 'runtimes.slow-probe')).toBe(false);

    const plan = await harness.invoke(MAKER_INVOKE.DOCTOR_FIX_PREVIEW, {
      fixId: 'fix.fake-route',
    });
    expect(plan).toMatchObject({ fixId: 'fix.fake-route' });

    const outcome = (await harness.invoke(MAKER_INVOKE.DOCTOR_FIX_APPLY, { plan })) as {
      ok: boolean;
      rolledBack: boolean;
      message: string;
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.message).toContain('Repaired broken route');

    const postFixState = (await harness.invoke(MAKER_INVOKE.DOCTOR_GET_STATE)) as {
      hasFailure: boolean;
      report: { counts: { fail: number; ok: number } } | null;
    };
    expect(postFixState.hasFailure).toBe(false);
    expect(postFixState.report?.counts.fail).toBe(0);

    const manualSnap = await harness.invoke(MAKER_INVOKE.DOCTOR_SNAPSHOT, { reason: 'manual-test' });
    expect(manualSnap).toMatchObject({ reason: 'manual-test' });
    const snapshots = (await harness.invoke(MAKER_INVOKE.DOCTOR_SNAPSHOTS)) as Array<{
      manifest: { reason: string } | null;
    }>;
    expect(snapshots.some((s) => s.manifest?.reason === 'manual-test')).toBe(true);
  });

  it('persists run_on_start in doctor.yaml and skips startup run when disabled', async () => {
    const env = await makeTempEnv();
    const { pack } = makePack({ initialBroken: true });
    const pushEvents: Array<{ runOnStart: boolean; hasFailure: boolean }> = [];

    const host = new DesktopDoctorHost({
      home: env.home,
      hermesHome: env.hermesHome,
      harnessDir: env.harnessDir,
      userDataDir: env.userDataDir,
      repoRoot: env.repoRoot,
      packs: [pack],
      onStateChanged: (s) => pushEvents.push({ runOnStart: s.runOnStart, hasFailure: s.hasFailure }),
    });

    const updated = await host.setConfig({ runOnStart: false });
    expect(updated.runOnStart).toBe(false);
    const yamlText = await fs.readFile(path.join(env.harnessDir, 'doctor', 'doctor.yaml'), 'utf8');
    expect(yamlText).toContain('run_on_start: false');

    const skippedReport = await host.runStartupOnce();
    expect(skippedReport).toBeNull();
    expect((await host.getState()).report).toBeNull();
    expect(pushEvents.length).toBeGreaterThan(0);
  });

  it('schedules startup check after 20s, takes daily snapshot once per 24h on 0 fails, and sets dot on fail', async () => {
    vi.useFakeTimers();
    let nowMs = Date.UTC(2026, 10, 15, 10, 0, 0);
    const env = await makeTempEnv();
    const { pack, state } = makePack({ initialBroken: true });
    const pushed: boolean[] = [];

    const host = new DesktopDoctorHost({
      home: env.home,
      hermesHome: env.hermesHome,
      harnessDir: env.harnessDir,
      userDataDir: env.userDataDir,
      repoRoot: env.repoRoot,
      packs: [pack],
      now: () => new Date(nowMs),
      onStateChanged: (s) => {
        pushed.push(s.hasFailure);
      },
    });

    // 1. Failing startup run -> sets dot, does NOT save daily LKG snapshot
    host.scheduleStartupRun(); // defaults to 20_000 ms
    await vi.advanceTimersByTimeAsync(19_999);
    expect((await host.getState()).report).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    const failState = await host.getState();
    expect(failState.hasFailure).toBe(true);
    expect(pushed).toContain(true);
    expect(await host.listSnapshots()).toHaveLength(0);

    // 2. Fix route and re-run startup pass -> 0 fails triggers daily snapshot
    state.broken = false;
    await host.runStartupOnce();
    const healthyState = await host.getState();
    expect(healthyState.hasFailure).toBe(false);
    expect(healthyState.lastStartupSnapshotAt).not.toBeNull();
    let snaps = await host.listSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.manifest?.reason).toBe('daily');

    // 3. Another startup pass 2 hours later does NOT create a second daily snapshot
    nowMs += 2 * 60 * 60 * 1000;
    await host.runStartupOnce();
    snaps = await host.listSnapshots();
    expect(snaps).toHaveLength(1);
  });
});
