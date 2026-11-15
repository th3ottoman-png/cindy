import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CLI_SCRIPT = path.join(REPO_ROOT, 'scripts', 'cindy-doctor.mjs');

const tempDirs: string[] = [];

async function runDoctorCli(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...extraEnv,
      },
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const error = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof error.code === 'number' ? error.code : 2,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function setupCliSandbox(options: { includePi?: boolean; hermesVersion?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-cli-'));
  tempDirs.push(root);

  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const fakeRepo = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');

  await Promise.all([
    fs.mkdir(hermesHome, { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts'), { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(fakeRepo, { recursive: true }),
    fs.mkdir(binDir, { recursive: true }),
  ]);

  await fs.writeFile(
    path.join(fakeRepo, 'package.json'),
    JSON.stringify({ name: 'cindy', packageManager: 'pnpm@10.33.2+sha512.abc' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(binDir, 'pnpm'),
    '#!/bin/sh\necho "10.33.2"\n',
    { encoding: 'utf8', mode: 0o755 },
  );
  const hermesVer = options.hermesVersion ?? '0.23.0';
  await fs.writeFile(
    path.join(binDir, 'hermes-cindy'),
    `#!/bin/sh\nexport HERMES_HOME="${hermesHome}"\nif [ "$1" = "--version" ]; then echo "Hermes Agent v${hermesVer}"; exit 0; fi\n`,
    { encoding: 'utf8', mode: 0o755 },
  );

  if (options.includePi) {
    const piBin = path.join(fakeRepo, 'apps', 'pi-bin', `${process.platform}-${process.arch}`, 'pi');
    await fs.mkdir(path.dirname(piBin), { recursive: true });
    await fs.writeFile(
      piBin,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.0.2"; exit 0; fi\n',
      { encoding: 'utf8', mode: 0o755 },
    );
  }

  return {
    root,
    home,
    hermesHome,
    harnessDir,
    userDataDir,
    fakeRepo,
    binDir,
    baseArgs: [
      '--home',
      home,
      '--hermes-home',
      hermesHome,
      '--harness-dir',
      harnessDir,
      '--user-data',
      userDataDir,
      '--repo-root',
      fakeRepo,
    ],
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('scripts/cindy-doctor.mjs CLI (ROADMAP 14.2)', () => {
  it('runs with hidden temp-path flags, prints valid JSON, and exits 0 with warns only', async () => {
    const s = await setupCliSandbox({ includePi: true, hermesVersion: '0.23.0' });
    const res = await runDoctorCli([...s.baseArgs, '--json'], {
      PATH: s.binDir,
      HOME: s.home,
    });

    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.counts.fail).toBe(0);
    expect(report.counts.warn).toBeGreaterThanOrEqual(1);
    const byId = new Map(report.results.map((r: { id: string; severity: string; summary: string }) => [r.id, r]));
    expect(byId.get('runtime.hermes.pin')).toMatchObject({
      severity: 'warn',
      summary: 'Hermes 0.23.0 installed, pin is 0.22.7',
    });
    expect(byId.get('runtime.pi.present')).toMatchObject({
      severity: 'ok',
    });
  });

  it('supports --only and --all filters cleanly', async () => {
    const s = await setupCliSandbox();
    const res = await runDoctorCli([...s.baseArgs, '--all', '--only', 'env.node,runtime.hermes.pin', '--json'], {
      PATH: s.binDir,
      HOME: s.home,
    });

    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.results.map((r: { id: string }) => r.id)).toEqual([
      'env.node',
      'runtime.hermes.pin',
    ]);
  });

  it('exits 1 when a check fails and exits 2 on invalid CLI arguments', async () => {
    const s = await setupCliSandbox();
    await fs.rm(s.userDataDir, { recursive: true, force: true });

    const failRes = await runDoctorCli([...s.baseArgs, '--only', 'env.paths'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(failRes.code).toBe(1);
    expect(failRes.stdout).toContain('FAIL  env.paths');

    const badArgRes = await runDoctorCli([...s.baseArgs, '--not-a-real-flag'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(badArgRes.code).toBe(2);
    expect(badArgRes.stderr).toContain('--not-a-real-flag');
  });

  it('documents and accepts --include-api', async () => {
    const helpRes = await runDoctorCli(['--help']);
    expect(helpRes.code).toBe(0);
    expect(helpRes.stdout).toContain('--include-api');

    const s = await setupCliSandbox({ includePi: true, hermesVersion: '0.23.0' });
    const flagRes = await runDoctorCli([...s.baseArgs, '--include-api', '--only', 'env.node', '--json'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(flagRes.code).toBe(0);
  });

  it('supports snapshot, snapshots, and rollback --file --yes subcommands cleanly', async () => {
    const s = await setupCliSandbox({ includePi: true, hermesVersion: '0.23.0' });
    await fs.writeFile(
      path.join(s.harnessDir, 'providers.yaml'),
      'providers:\n  - id: lmstudio\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
      'utf8',
    );
    const routingPath = path.join(s.harnessDir, 'routing.yaml');
    const originalRouting = 'routes:\n  local-small:\n    provider: lmstudio\n    model: qwen\nrules:\n  title: local-small\n';
    await fs.writeFile(routingPath, originalRouting, 'utf8');

    const snapRes = await runDoctorCli(
      [...s.baseArgs, 'snapshot', '--reason', 'cli-test', '--json'],
      { PATH: s.binDir, HOME: s.home },
    );
    expect(snapRes.code).toBe(0);
    const created = JSON.parse(snapRes.stdout);
    expect(created.manifest.reason).toBe('cli-test');
    expect(created.stamp).toBeTruthy();

    const listRes = await runDoctorCli([...s.baseArgs, 'snapshots', '--json'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(listRes.code).toBe(0);
    const list = JSON.parse(listRes.stdout);
    expect(list).toHaveLength(1);
    expect(list[0].stamp).toBe(created.stamp);

    // Break routing.yaml and verify rollback requires --yes in non-TTY, then succeeds with --yes
    await fs.writeFile(routingPath, 'default: [broken\n', 'utf8');
    const noYesRes = await runDoctorCli(
      [...s.baseArgs, 'rollback', created.stamp, '--file', 'harness/routing.yaml'],
      { PATH: s.binDir, HOME: s.home },
    );
    expect(noYesRes.code).toBe(1);
    expect(await fs.readFile(routingPath, 'utf8')).toBe('default: [broken\n');

    const yesRes = await runDoctorCli(
      [...s.baseArgs, 'rollback', created.stamp, '--file', 'harness/routing.yaml', '--yes', '--json'],
      { PATH: s.binDir, HOME: s.home },
    );
    expect(yesRes.code).toBe(0);
    const rolled = JSON.parse(yesRes.stdout);
    expect(rolled.ok).toBe(true);
    expect(await fs.readFile(routingPath, 'utf8')).toBe(originalRouting);
    expect(rolled.movedAside.some((p: string) => path.basename(p).startsWith('routing.yaml.pre-rollback-'))).toBe(true);
  });

  it('supports fix <fixId> [--target] [--yes] with confirm gating and fix-log.jsonl', async () => {
    const s = await setupCliSandbox({ includePi: true, hermesVersion: '0.23.0' });
    await fs.writeFile(
      path.join(s.harnessDir, 'providers.yaml'),
      'providers:\n  - id: lmstudio\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
      'utf8',
    );
    const routingPath = path.join(s.harnessDir, 'routing.yaml');
    const originalRouting = 'routes:\n  local-small:\n    provider: lmstudio\n    model: qwen\nrules:\n  title: local-small\n';
    await fs.writeFile(routingPath, originalRouting, 'utf8');

    const snapRes = await runDoctorCli(
      [...s.baseArgs, 'snapshot', '--reason', 'cli-fix-test', '--json'],
      { PATH: s.binDir, HOME: s.home },
    );
    expect(snapRes.code).toBe(0);

    // Break routing.yaml; fix without --yes in non-TTY must refuse without touching disk
    await fs.writeFile(routingPath, 'routes: [broken\n', 'utf8');
    const declined = await runDoctorCli(
      [...s.baseArgs, 'fix', 'fix.config.restore-lkg', '--target', 'harness/routing.yaml'],
      { PATH: s.binDir, HOME: s.home },
    );
    expect(declined.code).toBe(1);
    expect(await fs.readFile(routingPath, 'utf8')).toBe('routes: [broken\n');

    // Apply with --yes restores cleanly and writes fix-log.jsonl
    const applied = await runDoctorCli(
      [...s.baseArgs, 'fix', 'fix.config.restore-lkg', '--target', 'harness/routing.yaml', '--yes', '--json'],
      { PATH: s.binDir, HOME: s.home },
    );
    expect(applied.code).toBe(0);
    const parsed = JSON.parse(applied.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.rolledBack).toBe(false);
    expect(await fs.readFile(routingPath, 'utf8')).toBe(originalRouting);

    const logLines = (await fs.readFile(path.join(s.harnessDir, 'doctor', 'fix-log.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0]!).fixId).toBe('fix.config.restore-lkg');

    // Unknown fix exits 2
    const unknown = await runDoctorCli([...s.baseArgs, 'fix', 'fix.not.real'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(unknown.code).toBe(2);
  });

  it('supports canary --runtime claude (baseline + no-change) and usage validation (ROADMAP 14.7)', async () => {
    const s = await setupCliSandbox({ includePi: true, hermesVersion: '0.23.1' });
    const claudeBin = path.join(s.binDir, 'claude');
    await fs.writeFile(
      claudeBin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "2.1.310 (Claude Code)"; exit 0; fi',
        'if [ "$1" = "--help" ]; then',
        '  echo "Usage: claude [options]"',
        '  echo "Options:"',
        '  for f in --add-dir --allow-dangerously-skip-permissions --allowedTools --append-system-prompt --debug --debug-file --disallowedTools --effort --fork-session --include-partial-messages --mcp-config --model --permission-mode --plugin-dir --resume --session-id --setting-sources --settings --strict-mcp-config --tools; do',
        '    echo "  $f"',
        '  done',
        '  exit 0',
        'fi',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 },
    );

    const first = await runDoctorCli([...s.baseArgs, 'canary', '--runtime', 'claude'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('status=baseline');

    const second = await runDoctorCli([...s.baseArgs, 'canary', '--runtime', 'claude', '--json'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(second.code).toBe(0);
    const parsedSecond = JSON.parse(second.stdout);
    expect(parsedSecond.status).toBe('no-change');
    expect(parsedSecond.ok).toBe(true);

    // Missing or bad --runtime exits 2
    const badRuntime = await runDoctorCli([...s.baseArgs, 'canary'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(badRuntime.code).toBe(2);

    // --paid on non-hermes exits 2
    const paidNonHermes = await runDoctorCli([...s.baseArgs, 'canary', '--runtime', 'claude', '--paid'], {
      PATH: s.binDir,
      HOME: s.home,
    });
    expect(paidNonHermes.code).toBe(2);
  });

  it('supports canary --runtime hermes end-to-end against local mock endpoint and fake hermes (ROADMAP 14.7)', async () => {
    const s = await setupCliSandbox({ hermesVersion: '0.23.1' });

    // Start ephemeral mock LM Studio server
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen3-8b' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      await fs.writeFile(
        path.join(s.harnessDir, 'providers.yaml'),
        `providers:\n  - id: lmstudio-local\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:${port}\n`,
        'utf8',
      );
      await fs.writeFile(
        path.join(s.harnessDir, 'routing.yaml'),
        'routes:\n  local-small: { provider: lmstudio-local, model: qwen3-8b }\nrules:\n  title: local-small\n',
        'utf8',
      );

      // Install fake hermes wrapper + node script honoring HERMES_HOME
      const fakeHermesJs = path.join(s.root, 'fake-hermes-canary.mjs');
      await fs.writeFile(
        fakeHermesJs,
        [
          "import * as fs from 'node:fs';",
          "import * as path from 'node:path';",
          "if (process.argv.includes('--version')) { console.log('Hermes Agent v0.23.1'); process.exit(0); }",
          "const home = process.env.HERMES_HOME;",
          "const logsDir = path.join(home, 'logs');",
          "fs.mkdirSync(logsDir, { recursive: true });",
          "fs.writeFileSync(path.join(logsDir, 'agent.log'), '2026-11-15 10:00:00,000 INFO [c1] agent.conversation_loop: API call #1: model=qwen3-8b provider=custom in=100 out=4 total=104\\n');",
          "console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'qwen3-8b', session_id: '', timestamp: Date.now() }));",
          "console.log(JSON.stringify({ type: 'text', text: 'CINDY_CANARY_OK', timestamp: Date.now() }));",
          "console.log(JSON.stringify({ type: 'result', session_id: 'canary-sess-1', exit_code: 0, text: 'CINDY_CANARY_OK', tokens: { input: 100, output: 4, total: 104, cache_read: 0, cache_write: 0 }, duration_ms: 10, timestamp: Date.now() }));",
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(s.binDir, 'hermes'),
        `#!/bin/sh\nexec "${process.execPath}" "${fakeHermesJs}" "$@"\n`,
        { encoding: 'utf8', mode: 0o755 },
      );
      await fs.writeFile(
        path.join(s.binDir, 'hermes-cindy'),
        `#!/bin/sh\nexport HERMES_HOME="${s.hermesHome}"\nexec hermes "$@"\n`,
        { encoding: 'utf8', mode: 0o755 },
      );

      const passArgs = [
        '--home', s.home,
        '--hermes-home', s.hermesHome,
        '--harness-dir', s.harnessDir,
        '--user-data', s.userDataDir,
        '--repo-root', REPO_ROOT,
      ];
      const passRes = await runDoctorCli([...passArgs, 'canary', '--runtime', 'hermes'], {
        PATH: `${s.binDir}:/bin:/usr/bin`,
        HOME: s.home,
      });
      expect(passRes.code).toBe(0);
      expect(passRes.stdout).toContain('PASS  event-shapes');
      expect(passRes.stdout).toContain('Verdict: safe to bump pin');
      expect(passRes.stdout).toContain('not covered — re-probe per HANDOVER §3');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
