import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
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
import { environmentPack } from '../packs/environment.js';
import { runtimesPack } from '../packs/runtimes.js';

const tempDirs: string[] = [];

async function makeTempSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-14-2-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const repoRoot = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');

  await Promise.all([
    fs.mkdir(hermesHome, { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts'), { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(repoRoot, { recursive: true }),
    fs.mkdir(binDir, { recursive: true }),
  ]);

  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'cindy', packageManager: 'pnpm@10.33.2+sha512.abc' }),
    'utf8',
  );

  const launcher = path.join(binDir, 'hermes-cindy');
  await fs.writeFile(
    launcher,
    `#!/usr/bin/env bash\nexport HERMES_HOME="${hermesHome}"\nexec hermes "$@"\n`,
    { encoding: 'utf8', mode: 0o755 },
  );

  return { root, home, hermesHome, harnessDir, userDataDir, repoRoot, binDir, launcher };
}

function makeStubContext(
  sandbox: Awaited<ReturnType<typeof makeTempSandbox>>,
  overrides: Partial<DoctorContext> & {
    execMap?: Record<string, DoctorExecResult | ((args: string[]) => DoctorExecResult)>;
    execCalls?: Array<{ cmd: string; args: string[] }>;
  } = {},
): DoctorContext {
  const base = createNodeContext({
    home: sandbox.home,
    hermesHome: sandbox.hermesHome,
    harnessDir: sandbox.harnessDir,
    userDataDir: sandbox.userDataDir,
    repoRoot: sandbox.repoRoot,
    hermesPinnedVersion: '0.22.7',
    pnpmPinnedVersion: '10.33.2',
    env: {
      PATH: sandbox.binDir,
      HOME: sandbox.home,
    },
  });

  const execCalls = overrides.execCalls ?? [];
  const execMap = overrides.execMap ?? {};

  return {
    ...base,
    host: { node: '22.23.4', platform: 'darwin' },
    platform: 'darwin',
    arch: 'arm64',
    statfs: async () => ({ bavail: 20 * 1024 * 1024, bsize: 4096 }), // ~80 GiB
    loadNativeSqlite: () => undefined,
    exec: async (cmd, args) => {
      execCalls.push({ cmd, args });
      const key = path.basename(cmd);
      const handler = execMap[cmd] ?? execMap[key];
      if (!handler) {
        return { code: null, stdout: '', stderr: `spawn ${cmd} ENOENT` };
      }
      return typeof handler === 'function' ? handler(args) : handler;
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

describe('environment pack (ROADMAP 14.2)', () => {
  it('passes all env.* checks in a healthy Node 22 sandbox without executing hermes-cindy', async () => {
    const sandbox = await makeTempSandbox();
    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const ctx = makeStubContext(sandbox, {
      execCalls,
      execMap: {
        pnpm: { code: 0, stdout: '10.33.2\n', stderr: '' },
      },
    });

    const registry = createRegistry([environmentPack]);
    const report = await runChecks(registry, ctx);

    expect(report.counts.fail).toBe(0);
    expect(report.counts.warn).toBe(0);
    expect(report.results.map((r) => `${r.id}:${r.severity}`)).toEqual([
      'env.node:ok',
      'env.pnpm:ok',
      'env.native-sqlite:ok',
      'env.paths:ok',
      'env.disk:ok',
      'env.hermes-home:ok',
    ]);
    // env.hermes-home must inspect the launcher text, never run it
    expect(execCalls.some((c) => path.basename(c.cmd) === 'hermes-cindy')).toBe(false);
  });

  it('reports fail on non-22 Node, warn on pnpm mismatch, and fail on ABI error for better-sqlite3', async () => {
    const sandbox = await makeTempSandbox();
    const ctx = makeStubContext(sandbox, {
      host: { node: '20.11.1', platform: 'darwin' },
      execMap: {
        pnpm: { code: 0, stdout: '9.15.0\n', stderr: '' },
      },
      loadNativeSqlite: () => {
        throw new Error(
          'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 132.',
        );
      },
    });

    const registry = createRegistry([environmentPack]);
    const report = await runChecks(registry, ctx);
    const byId = new Map(report.results.map((r) => [r.id, r]));

    expect(byId.get('env.node')?.severity).toBe('fail');
    expect(byId.get('env.node')?.action).toContain('node@22');

    expect(byId.get('env.pnpm')?.severity).toBe('warn');
    expect(byId.get('env.pnpm')?.summary).toContain('10.33.2');

    expect(byId.get('env.native-sqlite')?.severity).toBe('fail');
    expect(byId.get('env.native-sqlite')?.action).toContain('pnpm rebuild better-sqlite3');
  });

  it('fails env.paths when a required directory is missing and warns/fails env.disk below 5 GB / 1 GB', async () => {
    const sandbox = await makeTempSandbox();
    await fs.rm(sandbox.userDataDir, { recursive: true, force: true });

    const registry = createRegistry([environmentPack]);

    const ctxWarnDisk = makeStubContext(sandbox, {
      execMap: { pnpm: { code: 0, stdout: '10.33.2\n', stderr: '' } },
      // 2 GiB free (< 5 GB threshold -> warn)
      statfs: async () => ({ bavail: 2 * 1024 * 256, bsize: 4096 }),
    });
    const rWarn = await runChecks(registry, ctxWarnDisk, { only: ['env.paths', 'env.disk'] });
    expect(rWarn.results.find((r) => r.id === 'env.paths')?.severity).toBe('fail');
    expect(rWarn.results.find((r) => r.id === 'env.paths')?.detail).toContain(sandbox.userDataDir);
    expect(rWarn.results.find((r) => r.id === 'env.disk')?.severity).toBe('warn');
    expect(rWarn.results.find((r) => r.id === 'env.disk')?.action).toContain('Storage');

    const ctxFailDisk = makeStubContext(sandbox, {
      // 512 MiB free (< 1 GB threshold -> fail)
      statfs: async () => ({ bavail: 512 * 256, bsize: 4096 }),
    });
    const rFail = await runChecks(registry, ctxFailDisk, { only: ['env.disk'] });
    expect(rFail.results[0]?.severity).toBe('fail');
  });

  it('fails env.hermes-home when hermes-cindy points HERMES_HOME to the daily home or is missing', async () => {
    const sandbox = await makeTempSandbox();
    const dailyLeaf = ['.', 'hermes'].join('');
    await fs.writeFile(
      sandbox.launcher,
      `#!/usr/bin/env bash\nexport HERMES_HOME="$HOME/${dailyLeaf}"\nexec hermes "$@"\n`,
      { encoding: 'utf8', mode: 0o755 },
    );

    const registry = createRegistry([environmentPack]);
    const reportDaily = await runChecks(registry, makeStubContext(sandbox), { only: ['env.hermes-home'] });
    expect(reportDaily.results[0]?.severity).toBe('fail');
    expect(reportDaily.results[0]?.summary).toContain('daily Hermes home');

    await fs.rm(sandbox.launcher, { force: true });
    const reportMissing = await runChecks(registry, makeStubContext(sandbox), { only: ['env.hermes-home'] });
    expect(reportMissing.results[0]?.severity).toBe('fail');
    expect(reportMissing.results[0]?.summary).toContain('not found');
  });
});

describe('runtimes pack (ROADMAP 14.2)', () => {
  it('parses Hermes 0.23.0 vs pin 0.22.7 as warn and passes bundled claude/codex/pi versions', async () => {
    const sandbox = await makeTempSandbox();
    const claudeBin = path.join(sandbox.repoRoot, 'apps', 'claude-code-bin', 'darwin-arm64', 'claude');
    const codexBin = path.join(sandbox.repoRoot, 'apps', 'codex-package-bin', 'darwin-arm64', 'bin', 'codex');
    const piBin = path.join(sandbox.repoRoot, 'apps', 'pi-bin', 'darwin-arm64', 'pi');

    for (const bin of [claudeBin, codexBin, piBin]) {
      await fs.mkdir(path.dirname(bin), { recursive: true });
      await fs.writeFile(bin, '#!/usr/bin/env sh\n', { encoding: 'utf8', mode: 0o755 });
    }

    const ctx = makeStubContext(sandbox, {
      execMap: {
        'hermes-cindy': {
          code: 0,
          stdout: 'Hermes Agent v0.23.0 (2026.9.24) · stable\nInstall directory: ~/.hermes-cindy\n',
          stderr: '',
        },
        claude: { code: 0, stdout: '2.1.296 (Claude Code)\n', stderr: '' },
        codex: { code: 0, stdout: 'codex-cli 0.159.2\n', stderr: '' },
        pi: { code: 0, stdout: '1.0.2\n', stderr: '' },
      },
    });

    const registry = createRegistry([runtimesPack]);
    const report = await runChecks(registry, ctx);
    const byId = new Map(report.results.map((r) => [r.id, r]));

    expect(byId.get('runtime.hermes.present')?.severity).toBe('ok');
    expect(byId.get('runtime.hermes.present')?.summary).toContain('0.23.0');
    expect(byId.get('runtime.hermes.pin')?.severity).toBe('warn');
    expect(byId.get('runtime.hermes.pin')?.summary).toBe('Hermes 0.23.0 installed, pin is 0.22.7');
    expect(byId.get('runtime.hermes.pin')?.action).toContain('canary --runtime hermes');
    expect(byId.get('runtime.claude.present')?.severity).toBe('ok');
    expect(byId.get('runtime.codex.present')?.severity).toBe('ok');
    expect(byId.get('runtime.pi.present')?.severity).toBe('ok');
  });

  it('skips missing optional runtimes when unused, and fails when a roster expert or imported agent uses them', async () => {
    const sandbox = await makeTempSandbox();
    const ctxUnused = makeStubContext(sandbox, {
      execMap: {
        'hermes-cindy': { code: 0, stdout: 'Hermes Agent v0.22.7\n', stderr: '' },
      },
    });

    const registry = createRegistry([runtimesPack]);
    const rUnused = await runChecks(registry, ctxUnused);
    const byIdUnused = new Map(rUnused.results.map((r) => [r.id, r]));

    expect(byIdUnused.get('runtime.hermes.pin')?.severity).toBe('ok');
    expect(byIdUnused.get('runtime.claude.present')?.severity).toBe('skip');
    expect(byIdUnused.get('runtime.codex.present')?.severity).toBe('skip');
    expect(byIdUnused.get('runtime.pi.present')?.severity).toBe('skip');
    expect(byIdUnused.get('runtime.pi.present')?.summary).toBe('not used');

    // Add a Pi expert and an imported Claude agent
    const piExpertDir = path.join(sandbox.harnessDir, 'experts', 'pi-helper');
    await fs.mkdir(piExpertDir, { recursive: true });
    await fs.writeFile(
      path.join(piExpertDir, 'expert.md'),
      '---\nname: Pi Helper\nagent: pi\n---\nHelp with Pi.\n',
      'utf8',
    );
    const claudeAgentsDir = path.join(sandbox.home, '.claude', 'agents');
    await fs.mkdir(claudeAgentsDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeAgentsDir, 'reviewer.md'),
      '---\nname: Reviewer\ntools: Read\n---\nReview code.\n',
      'utf8',
    );

    const rUsed = await runChecks(registry, ctxUnused);
    const byIdUsed = new Map(rUsed.results.map((r) => [r.id, r]));
    expect(byIdUsed.get('runtime.pi.present')?.severity).toBe('fail');
    expect(byIdUsed.get('runtime.pi.present')?.summary).toContain('pi-helper');
    expect(byIdUsed.get('runtime.claude.present')?.severity).toBe('fail');
    expect(byIdUsed.get('runtime.codex.present')?.severity).toBe('skip');
  });

  it('skips runtime.hermes.pin if runtime.hermes.present fails', async () => {
    const sandbox = await makeTempSandbox();
    await fs.rm(sandbox.launcher, { force: true });

    const registry = createRegistry(ALL_PACKS);
    const report = await runChecks(registry, makeStubContext(sandbox), { only: ['runtimes'] });
    const byId = new Map(report.results.map((r) => [r.id, r]));

    expect(byId.get('runtime.hermes.present')?.severity).toBe('fail');
    expect(byId.get('runtime.hermes.pin')?.severity).toBe('skip');
    expect(byId.get('runtime.hermes.pin')?.summary).toContain('runtime.hermes.present failed');
  });
});
