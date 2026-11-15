/**
 * Runtimes doctor pack (`runtime.*`, ROADMAP 14.2, blueprint §3).
 *
 * Resolves Hermes via the `hermes-cindy` launcher on PATH (never bare `hermes`),
 * and resolves Claude Code / Codex / Pi the same way Cindy's adapters do (12.5 logic:
 * dev bundled `apps/<devBinDir>/<platform>/...` → `userDataDir/<installSubdir>/<v>/...`
 * with `.verified` → PATH fallback). Never installs, updates, or calls the network.
 */

import * as fsConstants from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import matter from 'gray-matter';

import { isDailyHermesPath } from '../context.js';
import { EXPERT_AGENTS, type ExpertAgent } from '../../experts/expert-loader.js';
import {
  IMPORTED_AGENT_SOURCES,
  importedAgentId,
  parseImportedAgent,
  type ImportedAgentSource,
} from '../../experts/imported-agents.js';
import {
  buildRuntimeStatus,
  parseRuntimeVersion,
  runtimeVersionMatchesPin,
} from '../../runtimes/runtime-status.js';
import type { CheckRunOutput, DoctorCheck, DoctorContext, DoctorPack } from '../types.js';
import { readHermesCanaryRecord } from '../canary/contracts.js';
import { listLkgSnapshots, type LkgSnapshotVersions } from '../snapshots.js';
import { parseHermesLauncherHome, resolveCommandOnPath } from './environment.js';

const VERSION_TIMEOUT_MS = 2_800;
const IMPORTED_SCAN_CAP = 1_000;
const ACCESS_EXEC = fsConstants.constants.X_OK;

interface OptionalRuntimeSpec {
  checkId: string;
  agentKind: Exclude<ExpertAgent, 'hermes'>;
  displayName: string;
  shortName: string;
  devBinDir: string;
  installSubdir: string;
  binaryRelPath: (platform: NodeJS.Platform) => string;
  cliName: string;
  installHint: string;
}

export const OPTIONAL_RUNTIME_SPECS: readonly OptionalRuntimeSpec[] = [
  {
    checkId: 'runtime.claude.present',
    agentKind: 'claude-code',
    displayName: 'Claude Code CLI',
    shortName: 'claude',
    devBinDir: 'claude-code-bin',
    installSubdir: 'claude-code',
    binaryRelPath: (platform) => (platform === 'win32' ? 'claude.exe' : 'claude'),
    cliName: 'claude',
    installHint: 'pnpm install:claude',
  },
  {
    checkId: 'runtime.codex.present',
    agentKind: 'codex',
    displayName: 'Codex CLI',
    shortName: 'codex',
    devBinDir: 'codex-package-bin',
    installSubdir: 'codex-package',
    binaryRelPath: (platform) => path.join('bin', platform === 'win32' ? 'codex.exe' : 'codex'),
    cliName: 'codex',
    installHint: 'pnpm install:codex',
  },
  {
    checkId: 'runtime.pi.present',
    agentKind: 'pi',
    displayName: 'Pi CLI',
    shortName: 'pi',
    devBinDir: 'pi-bin',
    installSubdir: 'pi',
    binaryRelPath: (platform) => (platform === 'win32' ? 'pi.exe' : 'pi'),
    cliName: 'pi',
    installHint: 'pnpm install:pi',
  },
];

interface HermesProbeResult {
  launcherPath?: string;
  version: string | null;
  error?: string;
  refusedDailyHome?: boolean;
}

function extractHermesVersion(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match ? match[1]! : null;
}

export async function probeHermes(ctx: DoctorContext): Promise<HermesProbeResult> {
    const launcherHome = ctx.env?.HOME ?? ctx.paths.home ?? os.homedir();
    if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
      return { version: null, refusedDailyHome: true, error: 'hermesHome resolves to the daily Hermes home' };
    }

    const launcherPath = await resolveCommandOnPath('hermes-cindy', ctx);
    if (!launcherPath) {
      return { version: null, error: 'hermes-cindy not found on PATH' };
    }

    // Read the launcher before running it so a broken wrapper pointing at the daily home never runs.
    try {
      const scriptText = await ctx.fs.readFile(launcherPath, 'utf8');
      const target = parseHermesLauncherHome(scriptText, launcherHome);
      if (target && isDailyHermesPath(target, launcherHome, ctx.platform)) {
        return {
          launcherPath,
          version: null,
          refusedDailyHome: true,
          error: `refusing to execute ${launcherPath}: points at the daily Hermes home`,
        };
      }
    } catch {
      // let exec report if unreadable
    }

    const res = await ctx.exec(launcherPath, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
    if (res.code !== 0) {
      return {
        launcherPath,
        version: null,
        error: res.stderr.trim() || `hermes-cindy --version exited with code ${res.code}`,
      };
    }

    const version = extractHermesVersion(res.stdout, res.stderr);
    if (!version) {
      return {
        launcherPath,
        version: null,
        error: 'unrecognized hermes-cindy --version output',
      };
    }

    return { launcherPath, version };
}

async function collectRosterUsage(ctx: DoctorContext): Promise<Map<ExpertAgent, string[]>> {
    const usage = new Map<ExpertAgent, string[]>();
    const add = (kind: ExpertAgent, label: string) => {
      const list = usage.get(kind) ?? [];
      list.push(label);
      usage.set(kind, list);
    };

    // 1. Cindy experts (<harnessDir>/experts/<slug>/expert.md)
    const expertsRoot = path.join(ctx.paths.harnessDir, 'experts');
    try {
      const entries = await ctx.fs.readdir(expertsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const mdPath = path.join(expertsRoot, entry.name, 'expert.md');
        try {
          const raw = await ctx.fs.readFile(mdPath, 'utf8');
          const parsed = matter(raw, {});
          const data = parsed.data as Record<string, unknown>;
          const agentRaw = data.agent === undefined ? 'hermes' : data.agent;
          if (typeof agentRaw === 'string' && (EXPERT_AGENTS as readonly string[]).includes(agentRaw)) {
            add(agentRaw as ExpertAgent, `expert:${entry.name}`);
          }
        } catch {
          // broken/missing expert.md is diagnosed by config.experts (14.3)
        }
      }
    } catch {
      // experts directory absent
    }

    // 2. Imported foreign agents (~/.claude/agents, ~/.qwen/agents)
    const sourceDirs: Array<{ source: ImportedAgentSource; dir: string }> = [
      { source: IMPORTED_AGENT_SOURCES[0], dir: path.join(ctx.paths.home, '.claude', 'agents') },
      { source: IMPORTED_AGENT_SOURCES[2], dir: path.join(ctx.paths.home, '.qwen', 'agents') },
    ];
    let scanned = 0;

    for (const { source, dir } of sourceDirs) {
      if (scanned >= IMPORTED_SCAN_CAP) break;
      const walk = async (currentDir: string, relBase: string): Promise<void> => {
        let entries;
        try {
          entries = await ctx.fs.readdir(currentDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (scanned >= IMPORTED_SCAN_CAP) break;
          if (ent.name.startsWith('.') || /\.bak\.\d+$/.test(ent.name)) continue;
          const abs = path.join(currentDir, ent.name);
          const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
          if (ent.isDirectory()) {
            await walk(abs, rel);
          } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
            scanned += 1;
            try {
              const raw = await ctx.fs.readFile(abs, 'utf8');
              const agent = parseImportedAgent(raw, { source, absolutePath: abs, relPath: rel });
              for (const runtime of agent.runsOn) {
                add(runtime, importedAgentId(source, rel));
              }
            } catch {
              // ignore unreadable imported file
            }
          }
        }
      };
      await walk(dir, '');
    }

    return usage;
}

async function isExecutable(ctx: DoctorContext, filePath: string): Promise<boolean> {
  try {
    await ctx.fs.access(filePath, ACCESS_EXEC);
    const stat = await ctx.fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function resolveOptionalRuntimeBinary(
  ctx: DoctorContext,
  spec: OptionalRuntimeSpec,
): Promise<string | undefined> {
  const platform = ctx.platform ?? process.platform;
  const arch = ctx.arch ?? process.arch;
  const platformKey = `${platform}-${arch}`;
  const relBinary = spec.binaryRelPath(platform);

  // 1. Dev bundled runtime: <repoRoot>/apps/<devBinDir>/<platform-arch>/<binaryName>
  const devCandidate = path.join(ctx.paths.repoRoot, 'apps', spec.devBinDir, platformKey, relBinary);
  if (await isExecutable(ctx, devCandidate)) {
    return devCandidate;
  }

  // 2. Installed verified runtime: <userDataDir>/<installSubdir>/<version>/<binaryName>
  const installRoot = path.join(ctx.paths.userDataDir, spec.installSubdir);
  try {
    const entries = await ctx.fs.readdir(installRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const binCandidate = path.join(installRoot, ent.name, relBinary);
      const verifiedMarker = path.join(installRoot, ent.name, '.verified');
      try {
        await ctx.fs.stat(verifiedMarker);
        if (await isExecutable(ctx, binCandidate)) {
          return binCandidate;
        }
      } catch {
        // not verified
      }
    }
  } catch {
    // install root absent
  }

  // 3. PATH fallback when neither dev bundled binary nor userData binary exists
  return resolveCommandOnPath(spec.cliName, ctx);
}

const hermesPresentCheck: DoctorCheck = {
  id: 'runtime.hermes.present',
  layer: 'runtimes',
  title: 'Hermes CLI (hermes-cindy)',
  cost: 'fast',
  dependsOn: ['env.hermes-home'],
  async run(ctx): Promise<CheckRunOutput> {
    const probe = await probeHermes(ctx);
    if (!probe.version) {
      return {
        severity: 'fail',
        summary: probe.error ?? 'hermes-cindy is missing or failed --version',
        action: probe.refusedDailyHome
          ? 'Fix hermes-cindy so HERMES_HOME resolves to ~/.hermes-cindy'
          : 'Ensure hermes-cindy is on PATH and `hermes-cindy --version` succeeds',
        evidence: { launcherPath: probe.launcherPath ?? null },
      };
    }
    return {
      severity: 'ok',
      summary: `Hermes ${probe.version} at ${probe.launcherPath}`,
      evidence: { version: probe.version, path: probe.launcherPath ?? null },
    };
  },
};

const hermesPinCheck: DoctorCheck = {
  id: 'runtime.hermes.pin',
  layer: 'runtimes',
  title: 'Hermes CLI version pin',
  cost: 'fast',
  dependsOn: ['runtime.hermes.present'],
  async run(ctx): Promise<CheckRunOutput> {
    const pinned = ctx.hermesPinnedVersion;
    if (!pinned) {
      return {
        severity: 'skip',
        summary: 'Hermes pinned version unavailable in context',
      };
    }

    const probe = await probeHermes(ctx);
    if (!probe.version) {
      return {
        severity: 'skip',
        summary: `skipped: ${probe.error ?? 'Hermes version unavailable'}`,
      };
    }

    if (!runtimeVersionMatchesPin(probe.version, pinned)) {
      return {
        severity: 'warn',
        summary: `Hermes ${probe.version} installed, pin is ${pinned}`,
        detail: `Installed CLI (${probe.launcherPath}) differs from HERMES_CLI_PINNED_VERSION (${pinned}).`,
        action: 'pnpm run doctor canary --runtime hermes',
        evidence: { installed: probe.version, pinned, path: probe.launcherPath ?? null },
      };
    }

    return {
      severity: 'ok',
      summary: `Hermes ${probe.version} matches pin ${pinned}`,
      evidence: { installed: probe.version, pinned, path: probe.launcherPath ?? null },
    };
  },
};

function makeOptionalRuntimeCheck(spec: OptionalRuntimeSpec): DoctorCheck {
  return {
    id: spec.checkId,
    layer: 'runtimes',
    title: spec.displayName,
    cost: 'fast',
    async run(ctx): Promise<CheckRunOutput> {
      const [binaryPath, usage] = await Promise.all([
        resolveOptionalRuntimeBinary(ctx, spec),
        collectRosterUsage(ctx),
      ]);
      const users = usage.get(spec.agentKind) ?? [];

      if (!binaryPath) {
        if (users.length > 0) {
          const preview = users.slice(0, 3).join(', ');
          const extra = users.length > 3 ? ` (+${users.length - 3} more)` : '';
          return {
            severity: 'fail',
            summary: `${spec.displayName} missing — used by ${preview}${extra}`,
            detail: `Checked repo apps/${spec.devBinDir}, userData/${spec.installSubdir}, and PATH.`,
            action: spec.installHint,
            evidence: { runtime: spec.agentKind, usedCount: users.length },
          };
        }
        return {
          severity: 'skip',
          summary: 'not used',
          detail: `${spec.displayName} is not installed and no roster agent requires it.`,
          evidence: { runtime: spec.agentKind, usedCount: 0 },
        };
      }

      const probe = await ctx.exec(binaryPath, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
      const status = buildRuntimeStatus({
        id: spec.agentKind,
        path: binaryPath,
        version: probe.code === 0 ? parseRuntimeVersion(probe.stdout, probe.stderr) : null,
        probeError:
          probe.code !== 0
            ? probe.stderr.trim() || `--version exited with code ${probe.code}`
            : undefined,
      });

      if (status.health === 'error') {
        return {
          severity: users.length > 0 ? 'fail' : 'warn',
          summary: `${spec.displayName} failed --version: ${status.detail ?? 'unknown error'}`,
          detail: `Binary path: ${binaryPath}`,
          action: spec.installHint,
          evidence: { runtime: spec.agentKind, path: binaryPath, usedCount: users.length },
        };
      }

      return {
        severity: 'ok',
        summary: `${spec.shortName} ${status.version} at ${binaryPath}`,
        evidence: {
          runtime: spec.agentKind,
          path: binaryPath,
          version: status.version ?? null,
          usedCount: users.length,
        },
      };
    },
  };
}

type RuntimeChangeTarget = 'hermes' | 'claude' | 'codex' | 'pi';

const RUNTIME_LABELS: Readonly<Record<RuntimeChangeTarget, string>> = {
  hermes: 'Hermes CLI',
  claude: 'Claude Code',
  codex: 'Codex CLI',
  pi: 'Pi CLI',
};

const hermesCanaryFreshCheck: DoctorCheck = {
  id: 'runtime.hermes.canary-fresh',
  layer: 'runtimes',
  title: 'Hermes upgrade canary',
  cost: 'fast',
  dependsOn: ['runtime.hermes.present'],
  async run(ctx): Promise<CheckRunOutput> {
    const probe = await probeHermes(ctx);
    if (!probe.version) {
      return {
        severity: 'skip',
        summary: `skipped: ${probe.error ?? 'Hermes version unavailable'}`,
      };
    }

    const res = await readHermesCanaryRecord(ctx, probe.version);
    if (!res.exists) {
      return {
        severity: 'warn',
        summary: `no canary result for Hermes ${probe.version}`,
        detail: `Expected canary record at ${path.join(ctx.paths.harnessDir, 'doctor', 'canary', `hermes-${probe.version}.json`)}.`,
        action: 'pnpm run doctor canary --runtime hermes',
        evidence: { version: probe.version },
      };
    }

    if (!res.valid) {
      return {
        severity: 'fail',
        summary: `corrupt canary record for Hermes ${probe.version}: ${res.error}`,
        action: 'pnpm run doctor canary --runtime hermes',
        evidence: { version: probe.version, path: res.filePath },
      };
    }

    const failedIds = res.record.contracts.filter((c) => !c.ok).map((c) => c.id);
    if (!res.record.passed) {
      return {
        severity: 'fail',
        summary: `last canary failed for Hermes ${probe.version}: ${failedIds.join(', ') || 'contract failure'}`,
        detail: res.record.verdict,
        action: 'pnpm run doctor canary --runtime hermes',
        evidence: { version: probe.version, at: res.record.at },
      };
    }

    const dateStr = res.record.at.slice(0, 10);
    return {
      severity: 'ok',
      summary: `canary passed for Hermes ${probe.version} (${dateStr})`,
      evidence: {
        version: probe.version,
        at: res.record.at,
        route: res.record.route?.routeName ?? null,
      },
    };
  },
};

async function readLatestBaselineVersions(
  ctx: DoctorContext,
): Promise<{ dateStr: string; stamp: string; versions: LkgSnapshotVersions } | null> {
  const snapshots = await listLkgSnapshots(ctx);
  const baselines = snapshots.filter(
    (s) => s.valid && s.manifest && !s.manifest.reason.startsWith('pre-fix:'),
  );
  if (baselines.length === 0) return null;
  const latest = baselines[0]!;
  try {
    const raw = await ctx.fs.readFile(path.join(latest.dir, 'versions.json'), 'utf8');
    const versions = JSON.parse(raw) as LkgSnapshotVersions;
    const capturedAt = typeof versions.capturedAt === 'string' ? versions.capturedAt : latest.stamp;
    return {
      stamp: latest.stamp,
      dateStr: capturedAt.slice(0, 10),
      versions,
    };
  } catch {
    return null;
  }
}

async function resolveCurrentRuntimeVersion(
  ctx: DoctorContext,
  target: RuntimeChangeTarget,
): Promise<string | null> {
  if (target === 'hermes') {
    const probe = await probeHermes(ctx);
    return probe.version;
  }
  const spec = OPTIONAL_RUNTIME_SPECS.find((s) => s.shortName === target);
  if (!spec) return null;
  const bin = await resolveOptionalRuntimeBinary(ctx, spec);
  if (!bin) return null;
  const probe = await ctx.exec(bin, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
  return probe.code === 0 ? parseRuntimeVersion(probe.stdout, probe.stderr) : null;
}

function makeRuntimeChangedCheck(target: RuntimeChangeTarget): DoctorCheck {
  const label = RUNTIME_LABELS[target];
  const check: DoctorCheck = {
    id: `runtime.${target}.changed`,
    layer: 'runtimes',
    title: `${label} version drift`,
    cost: 'fast',
    async run(ctx): Promise<CheckRunOutput> {
      const [baseline, currentVersion] = await Promise.all([
        readLatestBaselineVersions(ctx),
        resolveCurrentRuntimeVersion(ctx, target),
      ]);

      if (!baseline) {
        return {
          severity: 'skip',
          summary: 'no LKG snapshot baseline yet',
        };
      }

      const oldVersion = baseline.versions[target]?.version ?? null;
      if (!currentVersion) {
        if (!oldVersion) {
          return {
            severity: 'skip',
            summary: `${label} not installed`,
          };
        }
        return {
          severity: 'warn',
          summary: `${label} unavailable (was ${oldVersion} on ${baseline.dateStr})`,
          action: `pnpm run doctor canary --runtime ${target}`,
          evidence: { previous: oldVersion, installed: null, snapshot: baseline.stamp },
        };
      }

      if (!oldVersion) {
        return {
          severity: 'skip',
          summary: `no prior ${label} version recorded in LKG snapshot (${baseline.dateStr})`,
          evidence: { installed: currentVersion, snapshot: baseline.stamp },
        };
      }

      if (currentVersion !== oldVersion) {
        return {
          severity: 'warn',
          summary: `${label} changed ${oldVersion} → ${currentVersion} since ${baseline.dateStr}; run the canary`,
          action: `pnpm run doctor canary --runtime ${target}`,
          evidence: { previous: oldVersion, installed: currentVersion, snapshot: baseline.stamp },
        };
      }

      return {
        severity: 'ok',
        summary: `${label} ${currentVersion} unchanged since ${baseline.dateStr}`,
        evidence: { installed: currentVersion, snapshot: baseline.stamp },
      };
    },
  };
  if (target === 'hermes') {
    check.dependsOn = ['runtime.hermes.present'];
  }
  return check;
}

export const runtimesPack: DoctorPack = {
  name: 'runtimes',
  checks: [
    hermesPresentCheck,
    hermesPinCheck,
    hermesCanaryFreshCheck,
    makeRuntimeChangedCheck('hermes'),
    ...OPTIONAL_RUNTIME_SPECS.map(makeOptionalRuntimeCheck),
    makeRuntimeChangedCheck('claude'),
    makeRuntimeChangedCheck('codex'),
    makeRuntimeChangedCheck('pi'),
  ],
};
