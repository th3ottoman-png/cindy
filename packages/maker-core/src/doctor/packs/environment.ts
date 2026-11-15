/**
 * Environment doctor pack (`env.*`, ROADMAP 14.2, blueprint §3).
 *
 * All checks are strictly read-only.
 */

import * as fsConstants from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertNotDailyHermes, isDailyHermesPath } from '../context.js';
import type { CheckRunOutput, DoctorCheck, DoctorContext, DoctorPack } from '../types.js';

const GIB = 1024 * 1024 * 1024;
const DISK_WARN_BYTES = 5 * GIB;
const DISK_FAIL_BYTES = 1 * GIB;
const ACCESS_RW = fsConstants.constants.R_OK | fsConstants.constants.W_OK;
const ACCESS_EXEC = fsConstants.constants.X_OK;

async function isExecutableFile(ctx: DoctorContext, candidate: string): Promise<boolean> {
  try {
    await ctx.fs.access(candidate, ACCESS_EXEC);
    const stat = await ctx.fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Resolve an executable on `ctx.env.PATH` (or `process.env.PATH`) without executing it. */
export async function resolveCommandOnPath(cmdName: string, ctx: DoctorContext): Promise<string | undefined> {
  if (cmdName.includes('/') || cmdName.includes('\\')) {
    return (await isExecutableFile(ctx, cmdName)) ? cmdName : undefined;
  }

  const platform = ctx.platform ?? process.platform;
  const pathRaw = ctx.env?.PATH ?? process.env.PATH ?? '';
  const dirs = pathRaw.split(path.delimiter).filter(Boolean);
  const candidates =
    platform === 'win32'
      ? [`${cmdName}.exe`, `${cmdName}.cmd`, `${cmdName}.bat`, cmdName]
      : [cmdName];

  for (const dir of dirs) {
    for (const file of candidates) {
      const fullPath = path.join(dir, file);
      if (await isExecutableFile(ctx, fullPath)) {
        return fullPath;
      }
    }
  }
  return undefined;
}

/** Extract `HERMES_HOME=...` target from launcher script text without running it. */
export function parseHermesLauncherHome(scriptText: string, homeDir: string): string | null {
  for (const rawLine of scriptText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?HERMES_HOME\s*=\s*(.+)$/);
    if (!match) continue;
    let value = match[1]!.replace(/\s+#.*$/, '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value
      .replace(/\$\{HOME\}/g, homeDir)
      .replace(/\$HOME\b/g, homeDir)
      .replace(/^~(?=\/|$)/, homeDir);
    if (value) return path.resolve(value);
  }
  return null;
}

async function resolveExistingAncestor(ctx: DoctorContext, target: string): Promise<string | null> {
  let cursor = path.resolve(target);
  while (true) {
    try {
      await ctx.fs.stat(cursor);
      return cursor;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

const envNodeCheck: DoctorCheck = {
  id: 'env.node',
  layer: 'environment',
  title: 'Node.js runtime',
  cost: 'instant',
  async run(ctx): Promise<CheckRunOutput> {
    const version = (ctx.host?.node ?? process.versions.node).replace(/^v/, '');
    const major = Number.parseInt(version.split('.')[0] ?? '', 10);
    if (major !== 22) {
      return {
        severity: 'fail',
        summary: `Node v${version} active — Cindy requires Node 22`,
        detail: `Detected Node v${version}; repo .nvmrc and engine-strict require Node 22.x.`,
        action: 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"',
        evidence: { node: version, major: Number.isFinite(major) ? major : null, expectedMajor: 22 },
      };
    }
    return {
      severity: 'ok',
      summary: `Node v${version} (22.x required)`,
      evidence: { node: version, major },
    };
  },
};

const envPnpmCheck: DoctorCheck = {
  id: 'env.pnpm',
  layer: 'environment',
  title: 'pnpm package manager',
  cost: 'fast',
  async run(ctx): Promise<CheckRunOutput> {
    const pinned = ctx.pnpmPinnedVersion;
    const res = await ctx.exec('pnpm', ['--version'], { timeoutMs: 2_500 });
    if (res.code !== 0) {
      return {
        severity: 'fail',
        summary: 'pnpm is missing or failed to run',
        detail: res.stderr.trim() || `pnpm --version exited with code ${res.code}`,
        action: pinned ? `Install or enable pnpm ${pinned}` : 'Install pnpm and add it to PATH',
        evidence: { code: res.code, pinned: pinned ?? null },
      };
    }
    const installed = res.stdout.trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(installed)) {
      return {
        severity: 'fail',
        summary: `unrecognized pnpm --version output: ${installed || '(empty)'}`,
        action: pinned ? `Ensure pnpm ${pinned} is active on PATH` : 'Check pnpm installation',
        evidence: { installed, pinned: pinned ?? null },
      };
    }
    if (pinned && installed !== pinned) {
      return {
        severity: 'warn',
        summary: `pnpm ${installed} installed, pinned version is ${pinned}`,
        detail: `package.json packageManager specifies pnpm@${pinned}.`,
        action: `Run corepack use pnpm@${pinned} or activate pnpm ${pinned}`,
        evidence: { installed, pinned },
      };
    }
    return {
      severity: 'ok',
      summary: pinned ? `pnpm ${installed} (matches pin ${pinned})` : `pnpm ${installed}`,
      evidence: { installed, pinned: pinned ?? null },
    };
  },
};

const envNativeSqliteCheck: DoctorCheck = {
  id: 'env.native-sqlite',
  layer: 'environment',
  title: 'better-sqlite3 native ABI',
  cost: 'instant',
  async run(ctx): Promise<CheckRunOutput> {
    if (!ctx.loadNativeSqlite) {
      return {
        severity: 'skip',
        summary: 'no native sqlite loader available in context',
      };
    }
    try {
      await ctx.loadNativeSqlite();
      return {
        severity: 'ok',
        summary: `better-sqlite3 loads under Node ${process.versions.node} (ABI ${process.versions.modules})`,
        evidence: { abi: process.versions.modules },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAbi = /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against/i.test(message);
      return {
        severity: 'fail',
        summary: isAbi
          ? `better-sqlite3 ABI mismatch under Node ${process.versions.node}`
          : `better-sqlite3 failed to load: ${message}`,
        detail: message,
        action: 'Run pnpm rebuild better-sqlite3',
        evidence: { abi: process.versions.modules, abiMismatch: isAbi },
      };
    }
  },
};

const envPathsCheck: DoctorCheck = {
  id: 'env.paths',
  layer: 'environment',
  title: 'Cindy data directories',
  cost: 'instant',
  async run(ctx): Promise<CheckRunOutput> {
    try {
      assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);
    } catch (err) {
      return {
        severity: 'fail',
        summary: err instanceof Error ? err.message : String(err),
        detail: `hermesHome=${ctx.paths.hermesHome}`,
        action: 'Point --hermes-home or hermes-cindy at ~/.hermes-cindy',
      };
    }

    const targets: Array<{ label: string; dir: string }> = [
      { label: 'Hermes home', dir: ctx.paths.hermesHome },
      { label: 'Harness dir', dir: ctx.paths.harnessDir },
      { label: 'User data dir', dir: ctx.paths.userDataDir },
    ];

    const issues: string[] = [];
    for (const { label, dir } of targets) {
      try {
        const st = await ctx.fs.stat(dir);
        if (!st.isDirectory()) {
          issues.push(`${label} (${dir}): not a directory`);
          continue;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        issues.push(`${label} (${dir}): ${code === 'ENOENT' ? 'missing' : (err as Error).message}`);
        continue;
      }

      try {
        await ctx.fs.access(dir, ACCESS_RW);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        issues.push(`${label} (${dir}): not writable (${code ?? (err as Error).message})`);
      }
    }

    if (issues.length > 0) {
      return {
        severity: 'fail',
        summary: `${issues.length} Cindy path(s) missing or unwritable`,
        detail: issues.join('; '),
        action: `Create missing directories or fix permissions on: ${issues.join('; ')}`,
        evidence: { issueCount: issues.length },
      };
    }

    return {
      severity: 'ok',
      summary: 'hermesHome, harnessDir, and userDataDir exist and are writable',
      evidence: {
        hermesHome: ctx.paths.hermesHome,
        harnessDir: ctx.paths.harnessDir,
        userDataDir: ctx.paths.userDataDir,
      },
    };
  },
};

const envDiskCheck: DoctorCheck = {
  id: 'env.disk',
  layer: 'environment',
  title: 'Free disk space',
  cost: 'instant',
  async run(ctx): Promise<CheckRunOutput> {
    if (!ctx.statfs) {
      return { severity: 'skip', summary: 'disk statfs unavailable in context' };
    }
    const target = await resolveExistingAncestor(ctx, ctx.paths.hermesHome);
    if (!target) {
      return {
        severity: 'fail',
        summary: `could not locate volume for ${ctx.paths.hermesHome}`,
        action: 'Verify ~/.hermes-cindy path and mount status',
      };
    }
    const { bavail, bsize } = await ctx.statfs(target);
    const freeBytes = bavail * bsize;
    if (freeBytes < DISK_FAIL_BYTES) {
      return {
        severity: 'fail',
        summary: `only ${formatGiB(freeBytes)} free on volume holding ${target} (< 1 GB)`,
        action: 'Open Cindy Settings → Personalization → Storage housekeeping to free space',
        evidence: { freeBytes, target },
      };
    }
    if (freeBytes < DISK_WARN_BYTES) {
      return {
        severity: 'warn',
        summary: `${formatGiB(freeBytes)} free on volume holding ${target} (< 5 GB)`,
        action: 'Consider freeing space via Settings → Personalization → Storage housekeeping',
        evidence: { freeBytes, target },
      };
    }
    return {
      severity: 'ok',
      summary: `${formatGiB(freeBytes)} free on volume holding ${target}`,
      evidence: { freeBytes, target },
    };
  },
};

const envHermesHomeCheck: DoctorCheck = {
  id: 'env.hermes-home',
  layer: 'environment',
  title: 'hermes-cindy launcher isolation',
  cost: 'instant',
  async run(ctx): Promise<CheckRunOutput> {
    if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
      return {
        severity: 'fail',
        summary: 'configured hermesHome points to the daily Hermes home',
        detail: `hermesHome=${ctx.paths.hermesHome}`,
        action: 'Set hermesHome to ~/.hermes-cindy',
      };
    }

    const launcherPath = await resolveCommandOnPath('hermes-cindy', ctx);
    if (!launcherPath) {
      return {
        severity: 'fail',
        summary: 'hermes-cindy launcher not found on PATH',
        detail: 'Searched PATH without executing any wrapper script.',
        action: 'Restore ~/.local/bin/hermes-cindy pointing HERMES_HOME at ~/.hermes-cindy',
      };
    }

    const scriptText = await ctx.fs.readFile(launcherPath, 'utf8');
    const launcherHome = ctx.env?.HOME ?? ctx.paths.home ?? os.homedir();
    const target = parseHermesLauncherHome(scriptText, launcherHome);
    if (!target) {
      return {
        severity: 'fail',
        summary: `${launcherPath} does not assign HERMES_HOME`,
        action: 'Set export HERMES_HOME="$HOME/.hermes-cindy" inside hermes-cindy',
        evidence: { launcherPath },
      };
    }

    if (isDailyHermesPath(target, launcherHome, ctx.platform)) {
      return {
        severity: 'fail',
        summary: `hermes-cindy points HERMES_HOME at the daily Hermes home (${target})`,
        detail: `Inspected ${launcherPath} without executing it.`,
        action: 'Update hermes-cindy so HERMES_HOME points to ~/.hermes-cindy',
        evidence: { launcherPath, target },
      };
    }

    const expectedBase = path.basename(target) === '.hermes-cindy' || path.resolve(target) === path.resolve(ctx.paths.hermesHome);
    if (!expectedBase) {
      return {
        severity: 'warn',
        summary: `hermes-cindy HERMES_HOME (${target}) differs from expected ${ctx.paths.hermesHome}`,
        action: `Verify ${launcherPath} sets HERMES_HOME to ${ctx.paths.hermesHome}`,
        evidence: { launcherPath, target },
      };
    }

    return {
      severity: 'ok',
      summary: `${launcherPath} isolates HERMES_HOME to ${target}`,
      evidence: { launcherPath, target },
    };
  },
};

export const environmentPack: DoctorPack = {
  layer: 'environment',
  checks: [
    envNodeCheck,
    envPnpmCheck,
    envNativeSqliteCheck,
    envPathsCheck,
    envDiskCheck,
    envHermesHomeCheck,
  ],
};
