import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseNdjsonEvents,
  selectNewestRealHermesFixture,
  type HermesStreamEvent,
} from '../../agents/hermes/event-shapes.js';
import {
  ALL_PACKS,
  createLkgSnapshot,
  createNodeContext,
  createRegistry,
  evaluateHermesCanaryContracts,
  parseHelpFlags,
  resolveHermesCanaryRoute,
  runChecks,
  runCliHelpCanary,
  runHermesCanary,
  ADAPTER_CLI_FLAGS,
  diffHelpFlags,
  type DoctorContext,
  type DoctorExecResult,
} from '../index.js';
import type { EndpointProbe } from '../../providers/discovery.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'packages', 'maker-hermes-manager', 'src', '__tests__', 'fixtures');

const tempDirs: string[] = [];

async function makeTempSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-canary-test-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const binDir = path.join(root, 'bin');
  const tmpDir = path.join(root, 'tmp');

  await Promise.all([
    fs.mkdir(path.join(hermesHome, 'installs'), { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts'), { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(binDir, { recursive: true }),
    fs.mkdir(tmpDir, { recursive: true }),
  ]);

  // Plant credentials + config in hermesHome that the canary must NEVER copy or link.
  await fs.writeFile(path.join(hermesHome, '.env'), 'SECRET_SHOULD_NEVER_BE_LINKED=1\n', 'utf8');
  await fs.writeFile(path.join(hermesHome, 'auth.json'), '{"secret":"no"}\n', 'utf8');
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), 'model:\n  default: deepseek-flash\n', 'utf8');
  await fs.writeFile(path.join(hermesHome, 'installs', 'marker'), 'venv-ok\n', 'utf8');

  const launcher = path.join(binDir, 'hermes-cindy');
  await fs.writeFile(
    launcher,
    `#!/usr/bin/env bash\nexport HERMES_HOME="${hermesHome}"\nexec hermes "$@"\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  const underlying = path.join(binDir, 'hermes');
  await fs.writeFile(underlying, '#!/usr/bin/env bash\necho "fake hermes"\n', {
    encoding: 'utf8',
    mode: 0o755,
  });

  return { root, home, hermesHome, harnessDir, userDataDir, binDir, tmpDir, launcher, underlying };
}

function makeStubContext(
  sandbox: Awaited<ReturnType<typeof makeTempSandbox>>,
  overrides: Partial<DoctorContext> & {
    execMap?: Record<string, DoctorExecResult | ((args: string[]) => DoctorExecResult)>;
    probeMap?: Record<string, EndpointProbe>;
  } = {},
): DoctorContext {
  const base = createNodeContext({
    home: sandbox.home,
    hermesHome: sandbox.hermesHome,
    harnessDir: sandbox.harnessDir,
    userDataDir: sandbox.userDataDir,
    repoRoot: REPO_ROOT,
    hermesPinnedVersion: '0.22.7',
    pnpmPinnedVersion: '10.33.2',
    env: {
      PATH: sandbox.binDir,
      HOME: sandbox.home,
      TOKENHUB_API_KEY: 'test-key-in-env-only',
    },
  });

  const execMap = overrides.execMap ?? {};
  const probeMap = overrides.probeMap ?? {};

  return {
    ...base,
    host: { node: '22.23.4', platform: 'darwin' },
    platform: 'darwin',
    arch: 'arm64',
    statfs: async () => ({ bavail: 20 * 1024 * 1024, bsize: 4096 }),
    loadNativeSqlite: () => undefined,
    exec: async (cmd, args) => {
      const key = path.basename(cmd);
      const handler = execMap[cmd] ?? execMap[key];
      if (!handler) {
        return { code: null, stdout: '', stderr: `spawn ${cmd} ENOENT` };
      }
      return typeof handler === 'function' ? handler(args) : handler;
    },
    probe: async (entry) => {
      return (
        probeMap[entry.id] ?? {
          id: entry.id,
          status: 'offline',
          models: [],
          latencyMs: 5,
          error: 'mock offline',
        }
      );
    },
    ...overrides,
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('Hermes canary contracts (ROADMAP 14.7)', () => {
  it('passes all five contracts against both stored real fixtures (0.22.5 and 0.23.0)', async () => {
    const fixtures = ['real-hermes-0.22.5.ndjson', 'real-hermes-0.23.0.ndjson'] as const;
    expect(selectNewestRealHermesFixture([...fixtures])).toBe('real-hermes-0.23.0.ndjson');

    const agentLog =
      '2026-11-15 10:00:00,000 INFO [s1] agent.conversation_loop: API call #1: model=qwen3-8b provider=lmstudio in=1024 out=6 total=1030 latency=0.2s\n';

    for (const file of fixtures) {
      const raw = await fs.readFile(path.join(FIXTURE_DIR, file), 'utf8');
      const refEvents = parseNdjsonEvents(raw);
      // Mirror a canary turn carrying CINDY_CANARY_OK while preserving exact fixture schema
      const candidateEvents: HermesStreamEvent[] = refEvents.map((ev) => {
        if (ev.type === 'text') return { ...ev, text: 'CINDY_CANARY_OK' };
        if (ev.type === 'result') return { ...ev, text: 'CINDY_CANARY_OK' };
        return { ...ev };
      });

      const res = evaluateHermesCanaryContracts({
        candidateEvents,
        referenceEvents: refEvents,
        referenceLabel: file,
        agentLogText: agentLog,
        launchRun: { exitCode: 0, stderr: '', events: candidateEvents },
      });

      expect(res.passed).toBe(true);
      expect(res.verdict).toBe('safe to bump pin');
      expect(res.contracts).toHaveLength(5);
      expect(res.contracts.every((c) => c.ok)).toBe(true);
      expect(res.notCovered.map((n) => n.note)).toEqual([
        'not covered — re-probe per HANDOVER §3',
        'not covered — re-probe per HANDOVER §3',
        'not covered — re-probe per HANDOVER §3',
      ]);
    }
  });

  it('fails cleanly when session_id is removed, shapes drift, agent.log lacks API call, launch fails, or reply token is missing', async () => {
    const raw = await fs.readFile(path.join(FIXTURE_DIR, 'real-hermes-0.23.0.ndjson'), 'utf8');
    const refEvents = parseNdjsonEvents(raw);

    // 1. Mutate result to remove session_id
    const noSid = refEvents.map((ev) => {
      if (ev.type !== 'result') return ev;
      const copy = { ...ev };
      delete copy.session_id;
      return copy;
    });
    const rNoSid = evaluateHermesCanaryContracts({
      candidateEvents: noSid,
      referenceEvents: refEvents,
      referenceLabel: 'real-hermes-0.23.0.ndjson',
      agentLogText: 'agent.conversation_loop: API call #1: model=m provider=p in=10 out=2',
      launchRun: { exitCode: 0, stderr: '', events: noSid },
    });
    expect(rNoSid.passed).toBe(false);
    expect(rNoSid.failedIds).toContain('result-session-id');
    expect(rNoSid.failedIds).toContain('event-shapes');
    expect(rNoSid.verdict).toContain('do not bump:');

    // 2. Empty session_id on result still passes key-type shape, fails result-session-id + reply-token
    const emptySid = refEvents.map((ev) =>
      ev.type === 'result' ? { ...ev, session_id: '', text: 'wrong answer' } : ev,
    );
    const rEmptySid = evaluateHermesCanaryContracts({
      candidateEvents: emptySid,
      referenceEvents: refEvents,
      referenceLabel: 'real-hermes-0.23.0.ndjson',
      agentLogText: '',
      launchRun: { exitCode: 2, stderr: 'unrecognized arguments: --safe-mode', events: emptySid },
    });
    expect(rEmptySid.passed).toBe(false);
    expect(rEmptySid.failedIds).toEqual([
      'result-session-id',
      'agent-log-api-call',
      'safe-mode-custom-provider',
      'canary-reply-token',
    ]);
  });
});

describe('Hermes canary runner & route resolution (ROADMAP 14.7)', () => {
  it('defaults to local-small, falls back to first online local provider, skips when offline, and gates --paid', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      [
        'providers:',
        '  - id: lmstudio-local',
        '    kind: lmstudio',
        '    baseUrl: http://127.0.0.1:1234',
        '  - id: ollama-local',
        '    kind: ollama',
        '    baseUrl: http://127.0.0.1:11434',
        '  - id: tokenhub',
        '    kind: openai-compatible',
        '    baseUrl: https://api.example.invalid/v1',
        '    keyEnv: TOKENHUB_API_KEY',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      [
        'routes:',
        '  local-small: { provider: ollama-local, model: llama3.2 }',
        '  gemma-local: { provider: lmstudio-local, model: gemma-4 }',
        '  cheap-api: { provider: tokenhub, model: deepseek-flash }',
        'rules:',
        '  title: local-small',
      ].join('\n'),
      'utf8',
    );

    // Offline local endpoints -> skip
    const offlineCtx = makeStubContext(sandbox);
    const skipped = await resolveHermesCanaryRoute(offlineCtx);
    expect(skipped.kind).toBe('skip');

    // local-small offline, lmstudio-local online -> falls back to gemma-local
    const fallbackCtx = makeStubContext(sandbox, {
      probeMap: {
        'lmstudio-local': { id: 'lmstudio-local', status: 'online', models: ['gemma-4'], latencyMs: 4 },
      },
    });
    const fallback = await resolveHermesCanaryRoute(fallbackCtx);
    expect(fallback).toMatchObject({
      kind: 'ok',
      route: {
        routeName: 'gemma-local',
        providerId: 'lmstudio-local',
        model: 'gemma-4',
        baseUrl: 'http://127.0.0.1:1234/v1',
        local: true,
      },
    });

    // API route without --paid -> refused
    const noPaid = await resolveHermesCanaryRoute(fallbackCtx, { modelRoute: 'cheap-api' });
    expect(noPaid.kind).toBe('refused');

    // --paid without confirmation -> refused; with confirmation -> ok + cost note
    const unconfirmed = await resolveHermesCanaryRoute(fallbackCtx, {
      modelRoute: 'cheap-api',
      paid: true,
      confirmPaid: async () => false,
    });
    expect(unconfirmed.kind).toBe('refused');

    const confirmed = await resolveHermesCanaryRoute(fallbackCtx, {
      modelRoute: 'cheap-api',
      paid: true,
      confirmPaid: async (req) => {
        expect(req.expectedCost).toContain('deepseek-flash');
        return true;
      },
    });
    expect(confirmed.kind).toBe('ok');
    if (confirmed.kind === 'ok') {
      expect(confirmed.route.local).toBe(false);
    }
  });

  it('uses isolated throwaway HERMES_HOME (installs symlink only, no .env/auth.json), writes canary record, and deletes temp home', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      'providers:\n  - id: lmstudio-local\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      'routes:\n  local-small: { provider: lmstudio-local, model: qwen3-8b }\nrules:\n  title: local-small\n',
      'utf8',
    );

    const refRaw = await fs.readFile(path.join(FIXTURE_DIR, 'real-hermes-0.23.0.ndjson'), 'utf8');
    const refLines = parseNdjsonEvents(refRaw).map((ev) => {
      if (ev.type === 'text') return JSON.stringify({ ...ev, text: 'CINDY_CANARY_OK' });
      if (ev.type === 'result') return JSON.stringify({ ...ev, text: 'CINDY_CANARY_OK' });
      return JSON.stringify(ev);
    });

    let observedHome: string | null = null;
    let observedArgs: string[] = [];
    let hadEnvFile = true;
    let hadAuthFile = true;
    let installsWasSymlink = false;

    const ctx = makeStubContext(sandbox, {
      execMap: {
        'hermes-cindy': { code: 0, stdout: 'Hermes Agent v0.23.1\n', stderr: '' },
      },
      probeMap: {
        'lmstudio-local': { id: 'lmstudio-local', status: 'online', models: ['qwen3-8b'], latencyMs: 3 },
      },
    });

    const configBefore = await fs.readFile(path.join(sandbox.hermesHome, 'config.yaml'), 'utf8');

    const res = await runHermesCanary(ctx, {
      tmpDir: sandbox.tmpDir,
      spawnTurn: async (req) => {
        observedHome = req.hermesHome;
        observedArgs = req.args;
        expect(req.binPath).toBe(sandbox.underlying); // unwrapped from hermes-cindy!
        const entries = await fs.readdir(req.hermesHome);
        hadEnvFile = entries.includes('.env');
        hadAuthFile = entries.includes('auth.json');
        const instStat = await fs.lstat(path.join(req.hermesHome, 'installs'));
        installsWasSymlink = instStat.isSymbolicLink();

        const logsDir = path.join(req.hermesHome, 'logs');
        await fs.mkdir(logsDir, { recursive: true });
        await fs.writeFile(
          path.join(logsDir, 'agent.log'),
          '2026-11-15 10:00:00,000 INFO [s1] agent.conversation_loop: API call #1: model=qwen3-8b provider=custom in=800 out=4 total=804\n',
          'utf8',
        );
        return { exitCode: 0, stdout: refLines.join('\n') + '\n', stderr: '' };
      },
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('passed');
    expect(res.verdict).toBe('safe to bump pin');
    expect(observedHome).not.toBeNull();
    expect(observedHome!.startsWith(sandbox.tmpDir)).toBe(true);
    expect(observedArgs).toContain('--safe-mode');
    expect(observedArgs).toContain('--provider');
    expect(observedArgs).toContain('custom');
    expect(observedArgs).toContain('--base-url');
    expect(hadEnvFile).toBe(false);
    expect(hadAuthFile).toBe(false);
    expect(installsWasSymlink).toBe(true);

    // Throwaway dir must be deleted afterwards
    const remainingTmp = await fs.readdir(sandbox.tmpDir);
    expect(remainingTmp).toEqual([]);

    // Real hermesHome config.yaml untouched
    expect(await fs.readFile(path.join(sandbox.hermesHome, 'config.yaml'), 'utf8')).toBe(configBefore);

    // Persisted canary record
    expect(res.recordPath).toBe(path.join(sandbox.harnessDir, 'doctor', 'canary', 'hermes-0.23.1.json'));
    const saved = JSON.parse(await fs.readFile(res.recordPath!, 'utf8'));
    expect(saved.passed).toBe(true);
    expect(saved.version).toBe('0.23.1');
  });
});

describe('CLI help-diff canary for claude/codex/pi (ROADMAP 14.7)', () => {
  it('parses help flags without prose false positives and flags removed adapter flags', async () => {
    const sampleHelp = [
      'Options:',
      '  -c, --continue                        Continue recent session',
      '      --settings <file-or-json>         Settings JSON (see --print)',
      '  --allowedTools, --allowed-tools <t>   Allowed tools',
      '                                        --fake-wrapped-flag foo)',
      '  --model <model>                       Model name',
    ].join('\n');
    expect(parseHelpFlags(sampleHelp)).toEqual([
      '--allowed-tools',
      '--allowedTools',
      '--continue',
      '--model',
      '--settings',
    ]);

    const diff = diffHelpFlags(
      ['--config', '--disable', '--legacy-flag'],
      ['--config', '--new-flag'],
      'codex',
    );
    expect(diff.added).toEqual(['--new-flag']);
    expect(diff.removed).toEqual(['--disable', '--legacy-flag']);
    expect(diff.brokenAdapterFlags).toEqual([
      { flag: '--disable', source: 'packages/maker-core/src/agents/codex/index.ts' },
    ]);
  });

  it('stores per-version help snapshot, reports no-change on repeat, and fails when adapter flag disappears', async () => {
    const sandbox = await makeTempSandbox();
    const claudeBin = path.join(sandbox.binDir, 'claude');
    await fs.writeFile(claudeBin, '#!/usr/bin/env sh\n', { encoding: 'utf8', mode: 0o755 });

    let currentVersion = '2.1.310';
    let includeSettingsFlag = true;

    const buildHelp = () => {
      const adapterFlags = ADAPTER_CLI_FLAGS.claude
        .map((e) => e.flag)
        .filter((f) => includeSettingsFlag || f !== '--settings');
      return ['Usage: claude [options]', 'Options:', ...adapterFlags.map((f) => `  ${f} <val>   desc`)].join('\n');
    };

    const ctx = makeStubContext(sandbox, {
      execMap: {
        claude: (args) => {
          if (args.includes('--version')) {
            return { code: 0, stdout: `${currentVersion} (Claude Code)\n`, stderr: '' };
          }
          return { code: 0, stdout: buildHelp(), stderr: '' };
        },
      },
    });

    // 1. Baseline run
    const r1 = await runCliHelpCanary(ctx, 'claude');
    expect(r1.ok).toBe(true);
    expect(r1.status).toBe('baseline');
    expect(r1.snapshotPath).toBe(path.join(sandbox.harnessDir, 'doctor', 'canary', 'claude-help-2.1.310.txt'));

    // 2. Second run on same version -> no-change
    const r2 = await runCliHelpCanary(ctx, 'claude');
    expect(r2.ok).toBe(true);
    expect(r2.status).toBe('no-change');
    expect(r2.verdict).toContain('no change');

    // 3. Upgrade removes `--settings` (used by flag-settings.ts) -> fail!
    currentVersion = '2.1.320';
    includeSettingsFlag = false;
    const r3 = await runCliHelpCanary(ctx, 'claude');
    expect(r3.ok).toBe(false);
    expect(r3.status).toBe('failed');
    expect(r3.removed).toEqual(['--settings']);
    expect(r3.brokenAdapterFlags).toEqual([
      { flag: '--settings', source: 'packages/maker-core/src/agents/claude-code/flag-settings.ts' },
    ]);
    expect(r3.verdict).toContain('do not bump');
  });
});

describe('runtimesPack canary-fresh and runtime.changed checks (ROADMAP 14.7)', () => {
  it('evaluates runtime.hermes.canary-fresh across missing, passed, and failed states', async () => {
    const sandbox = await makeTempSandbox();
    const ctx = makeStubContext(sandbox, {
      execMap: {
        'hermes-cindy': { code: 0, stdout: 'Hermes Agent v0.23.1\n', stderr: '' },
      },
    });
    const registry = createRegistry(ALL_PACKS);

    // No record yet -> warn
    const warnReport = await runChecks(registry, ctx, { only: ['runtimes'] });
    const byWarn = new Map(warnReport.results.map((r) => [r.id, r]));
    expect(byWarn.get('runtime.hermes.canary-fresh')?.severity).toBe('warn');
    expect(byWarn.get('runtime.hermes.canary-fresh')?.summary).toContain('0.23.1');

    // Passed record -> ok
    const canaryDir = path.join(sandbox.harnessDir, 'doctor', 'canary');
    await fs.mkdir(canaryDir, { recursive: true });
    await fs.writeFile(
      path.join(canaryDir, 'hermes-0.23.1.json'),
      JSON.stringify({
        version: '0.23.1',
        at: '2026-11-15T12:00:00.000Z',
        route: { routeName: 'local-small', providerId: 'lmstudio-local', model: 'qwen3-8b', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
        passed: true,
        verdict: 'safe to bump pin',
        contracts: [{ id: 'event-shapes', ok: true, detail: 'ok', docRef: 'HANDOVER' }],
        notCovered: [],
      }),
      'utf8',
    );
    const okReport = await runChecks(registry, ctx, { only: ['runtime.hermes.canary-fresh'] });
    expect(okReport.results[0]?.severity).toBe('ok');
    expect(okReport.results[0]?.summary).toContain('canary passed for Hermes 0.23.1');

    // Failed record -> fail
    await fs.writeFile(
      path.join(canaryDir, 'hermes-0.23.1.json'),
      JSON.stringify({
        version: '0.23.1',
        at: '2026-11-15T12:05:00.000Z',
        route: { routeName: 'local-small', providerId: 'lmstudio-local', model: 'qwen3-8b', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
        passed: false,
        verdict: 'do not bump: result-session-id',
        contracts: [{ id: 'result-session-id', ok: false, detail: 'missing', docRef: 'HANDOVER' }],
        notCovered: [],
      }),
      'utf8',
    );
    const failReport = await runChecks(registry, ctx, { only: ['runtime.hermes.canary-fresh'] });
    expect(failReport.results[0]?.severity).toBe('fail');
    expect(failReport.results[0]?.summary).toContain('result-session-id');
  });

  it('warns on runtime.<name>.changed when installed version differs from latest LKG snapshot versions.json', async () => {
    const sandbox = await makeTempSandbox();
    const claudeBin = path.join(sandbox.binDir, 'claude');
    await fs.writeFile(claudeBin, '#!/usr/bin/env sh\n', { encoding: 'utf8', mode: 0o755 });

    let claudeVersion = '2.1.296';
    let hermesVersion = '0.23.0';

    const makeCtx = () =>
      makeStubContext(sandbox, {
        execMap: {
          'hermes-cindy': () => ({ code: 0, stdout: `Hermes Agent v${hermesVersion}\n`, stderr: '' }),
          claude: () => ({ code: 0, stdout: `${claudeVersion} (Claude Code)\n`, stderr: '' }),
        },
      });

    // Capture baseline LKG snapshot at claude 2.1.296 & hermes 0.23.0
    await createLkgSnapshot(makeCtx(), { reason: 'baseline' });

    const registry = createRegistry(ALL_PACKS);
    const unchanged = await runChecks(registry, makeCtx(), { only: ['runtime.claude.changed', 'runtime.hermes.changed'] });
    expect(unchanged.results.every((r) => r.severity === 'ok')).toBe(true);

    // Upgrade Claude -> 2.1.300, keep Hermes 0.23.0
    claudeVersion = '2.1.300';
    const drifted = await runChecks(registry, makeCtx(), { only: ['runtime.claude.changed', 'runtime.hermes.changed'] });
    const byId = new Map(drifted.results.map((r) => [r.id, r]));
    expect(byId.get('runtime.claude.changed')?.severity).toBe('warn');
    expect(byId.get('runtime.claude.changed')?.summary).toMatch(/Claude Code changed 2\.1\.296 → 2\.1\.300 since \d{4}-\d{2}-\d{2}; run the canary/);
    expect(byId.get('runtime.claude.changed')?.action).toBe('pnpm run doctor canary --runtime claude');
    expect(byId.get('runtime.hermes.changed')?.severity).toBe('ok');
  });
});
