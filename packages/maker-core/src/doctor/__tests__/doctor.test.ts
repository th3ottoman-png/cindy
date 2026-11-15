/**
 * Doctor core unit tests: registry, runner, ordering, timeouts, dependencies,
 * needs, counts, and deterministic formatting (ROADMAP 14.1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_TIMEOUT_MS,
  createRegistry,
  formatReportJson,
  formatReportMarkdown,
  formatReportText,
  runChecks,
  type CheckRunOutput,
  type DoctorCheck,
  type DoctorContext,
  type DoctorPack,
} from '../index.js';

function makeContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  let tick = Date.UTC(2026, 10, 15, 14, 2, 0);
  const controller = new AbortController();
  return {
    paths: {
      home: '/Users/tester',
      hermesHome: '/Users/tester/.hermes-cindy',
      harnessDir: '/Users/tester/.cindy-harness',
      userDataDir: '/Users/tester/Library/Application Support/CindyGlobal-dev2-private',
      repoRoot: '/Users/tester/Cindy',
      socketPath: '/tmp/hermes-mgr.sock',
    },
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
      readdir: vi.fn(),
      access: vi.fn(),
    } as unknown as DoctorContext['fs'],
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    probe: vi.fn(),
    now: () => {
      const current = new Date(tick);
      tick += 5;
      return current;
    },
    signal: controller.signal,
    host: { node: 'v22.23.4', platform: 'darwin' },
    ...overrides,
  };
}

function makeCheck(
  id: string,
  layer: DoctorCheck['layer'],
  run: DoctorCheck['run'] = async () => ({ severity: 'ok', summary: `${id} ok` }),
  extra: Partial<Omit<DoctorCheck, 'id' | 'layer' | 'run'>> = {},
): DoctorCheck {
  return {
    id,
    layer,
    title: extra.title ?? id,
    cost: extra.cost ?? 'instant',
    ...extra,
    run,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createRegistry (ROADMAP 14.1)', () => {
  it('registers checks and fixes across packs and looks them up by id', () => {
    const check = makeCheck('env.node', 'environment');
    const fix = {
      id: 'fix.config.restore-lkg',
      title: 'Restore LKG config',
      risk: 'moves-files' as const,
      needsAppClosed: true,
      recheck: ['config.routing'],
      preview: async () => ({ fixId: 'fix.config.restore-lkg', steps: [], touches: [] }),
      apply: async () => ({ ok: true, rolledBack: false, message: 'done', recheck: [] }),
    };

    const registry = createRegistry([{ name: 'env', checks: [check], fixes: [fix] }]);

    expect(registry.checks).toHaveLength(1);
    expect(registry.fixes).toHaveLength(1);
    expect(registry.getCheck('env.node')?.id).toBe('env.node');
    expect(registry.getFix('fix.config.restore-lkg')?.id).toBe('fix.config.restore-lkg');
    expect(registry.getCheck('missing')).toBeUndefined();
    expect(registry.getFix('missing')).toBeUndefined();
  });

  it('rejects duplicate check ids across packs', () => {
    const p1: DoctorPack = { checks: [makeCheck('env.node', 'environment')] };
    const p2: DoctorPack = { checks: [makeCheck('env.node', 'environment')] };

    expect(() => createRegistry([p1, p2])).toThrow(/duplicate.*env\.node/i);
  });

  it('rejects duplicate fix ids', () => {
    const fix = {
      id: 'fix.proc.kill-orphans',
      title: 'Kill orphans',
      risk: 'kills-process' as const,
      needsAppClosed: false,
      recheck: ['proc.orphans'],
      preview: async () => ({ fixId: 'fix.proc.kill-orphans', steps: [], touches: [] }),
      apply: async () => ({ ok: true, rolledBack: false, message: 'done', recheck: [] }),
    };

    expect(() =>
      createRegistry([
        { checks: [], fixes: [fix] },
        { checks: [], fixes: [fix] },
      ]),
    ).toThrow(/duplicate.*fix\.proc\.kill-orphans/i);
  });

  it('rejects empty ids', () => {
    expect(() => createRegistry([{ checks: [makeCheck('   ', 'environment')] }])).toThrow();
  });
});

describe('runChecks ordering, filtering and concurrency (ROADMAP 14.1)', () => {
  it('always outputs results in fixed layer order then registration order', async () => {
    const registry = createRegistry([
      {
        checks: [
          makeCheck('data.sqlite', 'data'),
          makeCheck('proc.daemon', 'processes'),
          makeCheck('env.first', 'environment'),
          makeCheck('endpoint.local', 'endpoints'),
          makeCheck('config.routing', 'config'),
          makeCheck('runtime.hermes', 'runtimes'),
          makeCheck('env.second', 'environment'),
        ],
      },
    ]);

    const report = await runChecks(registry, makeContext());

    expect(report.results.map((r) => r.id)).toEqual([
      'env.first',
      'env.second',
      'runtime.hermes',
      'config.routing',
      'endpoint.local',
      'proc.daemon',
      'data.sqlite',
    ]);
  });

  it('filters by layer name or check id via only and filters by cost', async () => {
    const registry = createRegistry([
      {
        checks: [
          makeCheck('env.node', 'environment', undefined, { cost: 'instant' }),
          makeCheck('config.routing', 'config', undefined, { cost: 'fast' }),
          makeCheck('config.slow', 'config', undefined, { cost: 'slow' }),
          makeCheck('data.sqlite', 'data', undefined, { cost: 'fast' }),
        ],
      },
    ]);

    const onlyConfigFast = await runChecks(registry, makeContext(), {
      only: ['config'],
      cost: ['instant', 'fast'],
    });
    expect(onlyConfigFast.results.map((r) => r.id)).toEqual(['config.routing']);

    const onlyId = await runChecks(registry, makeContext(), {
      only: ['data.sqlite', 'env.node'],
    });
    expect(onlyId.results.map((r) => r.id)).toEqual(['env.node', 'data.sqlite']);
  });

  it('caps parallel check execution at 4 by default and keeps deterministic output order', async () => {
    let active = 0;
    let maxActive = 0;
    const checks: DoctorCheck[] = [];
    for (let i = 0; i < 7; i += 1) {
      checks.push(
        makeCheck(`env.c${i}`, 'environment', async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          await Promise.resolve();
          active -= 1;
          return { severity: 'ok', summary: `c${i}` };
        }),
      );
    }

    const report = await runChecks(createRegistry([{ checks }]), makeContext());

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(report.results.map((r) => r.id)).toEqual([
      'env.c0',
      'env.c1',
      'env.c2',
      'env.c3',
      'env.c4',
      'env.c5',
      'env.c6',
    ]);
  });
});

describe('runChecks fail-closed error, timeout, dependsOn, needs and counts', () => {
  it('maps thrown and rejected checks to fail with check crashed and never throws', async () => {
    const registry = createRegistry([
      {
        checks: [
          makeCheck('env.async-throw', 'environment', async () => {
            throw new Error('disk exploded');
          }),
          makeCheck('env.sync-throw', 'environment', (() => {
            throw new Error('sync boom');
          }) as unknown as DoctorCheck['run']),
        ],
      },
    ]);

    const report = await runChecks(registry, makeContext());

    expect(report.results[0].severity).toBe('fail');
    expect(report.results[0].summary).toBe('check crashed: disk exploded');
    expect(report.results[1].severity).toBe('fail');
    expect(report.results[1].summary).toBe('check crashed: sync boom');
    expect(report.counts).toEqual({ ok: 0, warn: 0, fail: 2, skip: 0 });
  });

  it('converts discoverChecks failures into diagnostic fail results while still running static checks', async () => {
    const registry = createRegistry([
      {
        name: 'broken-discovery',
        checks: [makeCheck('env.static-ok', 'environment', async () => ({ severity: 'ok', summary: 'static ran' }))],
        discoverChecks: async () => {
          throw new Error('discovery exploded');
        },
      },
    ]);

    const report = await runChecks(registry, makeContext());

    expect(report.results.map((r) => [r.id, r.severity, r.summary])).toEqual([
      ['env.static-ok', 'ok', 'static ran'],
      ['broken-discovery.discover', 'fail', 'check discovery crashed: discovery exploded'],
    ]);
    expect(report.counts).toEqual({ ok: 1, warn: 0, fail: 1, skip: 0 });
  });

  it('times out checks according to cost tier (500ms / 3000ms / 30000ms)', async () => {
    vi.useFakeTimers();

    const neverResolves = () => new Promise<CheckRunOutput>(() => {});
    const registry = createRegistry([
      {
        checks: [
          makeCheck('env.instant-hang', 'environment', neverResolves, { cost: 'instant' }),
          makeCheck('config.fast-hang', 'config', neverResolves, { cost: 'fast' }),
          makeCheck('data.slow-hang', 'data', neverResolves, { cost: 'slow' }),
        ],
      },
    ]);

    const pending = runChecks(registry, makeContext());
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS.slow + 50);
    const report = await pending;

    expect(report.results.map((r) => [r.id, r.severity, r.summary])).toEqual([
      ['env.instant-hang', 'fail', 'check timed out after 500 ms'],
      ['config.fast-hang', 'fail', 'check timed out after 3000 ms'],
      ['data.slow-hang', 'fail', 'check timed out after 30000 ms'],
    ]);
  });

  it('skips dependents when dependsOn failed or skipped and runs them on ok/warn', async () => {
    const skippedRun = vi.fn(async () => ({ severity: 'ok' as const, summary: 'should not run' }));
    const skippedChainRun = vi.fn(async () => ({ severity: 'ok' as const, summary: 'should not run' }));
    const okDependentRun = vi.fn(async () => ({ severity: 'ok' as const, summary: 'ran after warn' }));

    const registry = createRegistry([
      {
        checks: [
          makeCheck('env.bad', 'environment', async () => ({ severity: 'fail', summary: 'missing root' })),
          makeCheck('env.warn', 'environment', async () => ({ severity: 'warn', summary: 'old version' })),
          makeCheck('runtime.needs-bad', 'runtimes', skippedRun, { dependsOn: ['env.bad'] }),
          makeCheck('config.needs-skipped', 'config', skippedChainRun, { dependsOn: ['runtime.needs-bad'] }),
          makeCheck('runtime.needs-warn', 'runtimes', okDependentRun, { dependsOn: ['env.warn'] }),
        ],
      },
    ]);

    const report = await runChecks(registry, makeContext());

    expect(skippedRun).not.toHaveBeenCalled();
    expect(skippedChainRun).not.toHaveBeenCalled();
    expect(okDependentRun).toHaveBeenCalledTimes(1);

    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    expect(byId['runtime.needs-bad'].severity).toBe('skip');
    expect(byId['runtime.needs-bad'].summary).toBe('skipped: env.bad failed');
    expect(byId['config.needs-skipped'].severity).toBe('skip');
    expect(byId['config.needs-skipped'].summary).toBe('skipped: runtime.needs-bad skipped');
    expect(byId['runtime.needs-warn'].severity).toBe('ok');
  });

  it('enforces needs app-closed and app-running in both directions', async () => {
    const closedOnly = vi.fn(async () => ({ severity: 'ok' as const, summary: 'closed ok' }));
    const runningOnly = vi.fn(async () => ({ severity: 'ok' as const, summary: 'running ok' }));

    const registry = createRegistry([
      {
        checks: [
          makeCheck('config.needs-closed', 'config', closedOnly, { needs: ['app-closed'] }),
          makeCheck('proc.needs-running', 'processes', runningOnly, { needs: ['app-running'] }),
        ],
      },
    ]);

    const whileRunning = await runChecks(registry, makeContext({ appRunning: true }));
    expect(closedOnly).not.toHaveBeenCalled();
    expect(runningOnly).toHaveBeenCalledTimes(1);
    expect(whileRunning.results[0].severity).toBe('skip');
    expect(whileRunning.results[0].summary).toContain('app is running');
    expect(whileRunning.results[1].severity).toBe('ok');

    closedOnly.mockClear();
    runningOnly.mockClear();

    const whileClosed = await runChecks(registry, makeContext({ appRunning: false }));
    expect(closedOnly).toHaveBeenCalledTimes(1);
    expect(runningOnly).not.toHaveBeenCalled();
    expect(whileClosed.results[0].severity).toBe('ok');
    expect(whileClosed.results[1].severity).toBe('skip');
    expect(whileClosed.results[1].summary).toContain('app is closed');
  });

  it('tallies severity counts accurately across all outcomes', async () => {
    const registry = createRegistry([
      {
        checks: [
          makeCheck('env.ok', 'environment', async () => ({ severity: 'ok', summary: 'ok' })),
          makeCheck('runtime.warn', 'runtimes', async () => ({ severity: 'warn', summary: 'warn' })),
          makeCheck('config.fail', 'config', async () => ({ severity: 'fail', summary: 'fail', action: 'fix it' })),
          makeCheck('data.skip', 'data', async () => ({ severity: 'ok', summary: 'ok' }), {
            dependsOn: ['config.fail'],
          }),
        ],
      },
    ]);

    const report = await runChecks(registry, makeContext());
    expect(report.counts).toEqual({ ok: 1, warn: 1, fail: 1, skip: 1 });
  });
});

describe('report formatters (ROADMAP 14.1)', () => {
  it('formats deterministic plain-English text with failures first and no ANSI/emoji', async () => {
    const registry = createRegistry([
      {
        checks: [
          makeCheck('env.node', 'environment', async () => ({
            severity: 'ok',
            summary: 'Node v22.23.4',
          })),
          makeCheck('runtime.hermes.pin', 'runtimes', async () => ({
            severity: 'warn',
            summary: 'Hermes 0.23.0 installed, pin is 0.22.7',
            action: 'pnpm doctor canary --runtime hermes',
          })),
          makeCheck('config.routing', 'config', async () => ({
            severity: 'fail',
            summary: 'route "local-small" names provider "lmstudio" — not in providers.yaml',
            action: 'pnpm doctor fix fix.config.restore-lkg --target harness/routing.yaml',
          })),
          makeCheck('proc.daemon', 'processes', async () => ({
            severity: 'skip',
            summary: 'app is closed and no socket file exists',
          })),
        ],
      },
    ]);

    const report = await runChecks(registry, makeContext());
    const text = formatReportText(report);

    expect(text).toBe(
      [
        'Cindy doctor · 2026-11-15 14:02 · 4 checks · 1 ok · 1 warn · 1 fail · 1 skip',
        '',
        'FAIL  config.routing      route "local-small" names provider "lmstudio" — not in providers.yaml',
        '      → pnpm doctor fix fix.config.restore-lkg --target harness/routing.yaml',
        'WARN  runtime.hermes.pin  Hermes 0.23.0 installed, pin is 0.22.7',
        '      → pnpm doctor canary --runtime hermes',
        'OK    env.node            Node v22.23.4',
        'SKIP  proc.daemon         app is closed and no socket file exists',
      ].join('\n'),
    );

    // Determinism check: identical inputs produce identical output
    expect(formatReportText(report)).toBe(text);
    // No ANSI escape codes
    expect(text).not.toMatch(/\u001b\[/);

    const parsedJson = JSON.parse(formatReportJson(report));
    expect(parsedJson.counts).toEqual({ ok: 1, warn: 1, fail: 1, skip: 1 });
    expect(parsedJson.results).toHaveLength(4);

    const md = formatReportMarkdown(report);
    expect(md).toContain('# Cindy Doctor Report');
    expect(md).toContain('`config.routing`');
    expect(md).toContain('pnpm doctor fix fix.config.restore-lkg');
  });
});
