/**
 * Help-output flag diff canary for non-Hermes CLI runtimes (`claude`, `codex`, `pi`)
 * (ROADMAP 14.7, blueprint §6).
 *
 * Makes zero model/network calls: runs `<runtime> --version` and `<runtime> --help`,
 * persists per-version `<runtime>-help-<version>.txt` under `<harnessDir>/doctor/canary/`,
 * and diffs extracted flags against the previous stored snapshot. If a removed flag is
 * one Cindy's adapter passes, reports failure (`brokenAdapterFlags`).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { compareSemverStrings } from '../../agents/hermes/event-shapes.js';
import { parseRuntimeVersion } from '../../runtimes/runtime-status.js';
import type { DoctorContext } from '../types.js';
import {
  OPTIONAL_RUNTIME_SPECS,
  resolveOptionalRuntimeBinary,
} from '../packs/runtimes.js';

export type HelpDiffRuntime = 'claude' | 'codex' | 'pi';

export interface AdapterFlagEntry {
  flag: string;
  source: string;
}

/**
 * Static table of CLI flags passed by Cindy's adapters, citing the adapter source file
 * where each flag is emitted. Built by reading the adapters (never modifying them).
 */
export const ADAPTER_CLI_FLAGS: Readonly<Record<HelpDiffRuntime, readonly AdapterFlagEntry[]>> = {
  claude: [
    { flag: '--add-dir', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    {
      flag: '--allow-dangerously-skip-permissions',
      source: 'packages/maker-core/src/agents/claude-code/index.ts',
    },
    { flag: '--allowedTools', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    {
      flag: '--append-system-prompt',
      source: 'packages/maker-core/src/agents/claude-code/index.ts',
    },
    { flag: '--debug', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--debug-file', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--disallowedTools', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--effort', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--fork-session', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    {
      flag: '--include-partial-messages',
      source: 'packages/maker-core/src/agents/claude-code/index.ts',
    },
    { flag: '--mcp-config', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--model', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--permission-mode', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--plugin-dir', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--resume', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--session-id', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--setting-sources', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--settings', source: 'packages/maker-core/src/agents/claude-code/flag-settings.ts' },
    { flag: '--strict-mcp-config', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
    { flag: '--tools', source: 'packages/maker-core/src/agents/claude-code/index.ts' },
  ],
  codex: [
    { flag: '--config', source: 'packages/maker-core/src/agents/codex/index.ts' },
    { flag: '--disable', source: 'packages/maker-core/src/agents/codex/index.ts' },
  ],
  pi: [
    { flag: '--append-system-prompt', source: 'packages/maker-core/src/agents/pi/index.ts' },
    { flag: '--extension', source: 'packages/maker-core/src/agents/pi/project-resource-cli.ts' },
    { flag: '--mode', source: 'packages/maker-core/src/agents/pi/index.ts' },
    { flag: '--model', source: 'packages/maker-core/src/agents/pi/index.ts' },
    { flag: '--no-approve', source: 'packages/maker-core/src/agents/pi/index.ts' },
    { flag: '--no-context-files', source: 'packages/maker-core/src/agents/pi/device-hosted-guest.ts' },
    { flag: '--no-extensions', source: 'packages/maker-core/src/agents/pi/index.ts' },
    {
      flag: '--no-prompt-templates',
      source: 'packages/maker-core/src/agents/pi/device-hosted-guest.ts',
    },
    { flag: '--no-skills', source: 'packages/maker-core/src/agents/pi/device-hosted-guest.ts' },
    { flag: '--offline', source: 'packages/maker-core/src/agents/pi/index.ts' },
    {
      flag: '--prompt-template',
      source: 'packages/maker-core/src/agents/pi/project-resource-cli.ts',
    },
    { flag: '--provider', source: 'packages/maker-core/src/agents/pi/index.ts' },
    { flag: '--session', source: 'packages/maker-core/src/agents/pi/index.ts' },
    { flag: '--session-dir', source: 'packages/maker-core/src/agents/pi/index.ts' },
    { flag: '--skill', source: 'packages/maker-core/src/agents/pi/project-resource-cli.ts' },
    {
      flag: '--thinking',
      source: 'packages/maker-core/src/agents/pi/cindy-subagent-runner-source.ts',
    },
    { flag: '--tools', source: 'packages/maker-core/src/agents/pi/cindy-subagent-runner-source.ts' },
  ],
};

const HELP_OPTION_LINE_RE =
  /^\s{1,10}(?:-[A-Za-z0-9],\s*)?(--[A-Za-z0-9][A-Za-z0-9_-]*(?:\s*,\s*--[A-Za-z0-9][A-Za-z0-9_-]*)*)(?:=(?:<[^>]+>|\[[^\]]+\]|\{[^}]+\}|[A-Za-z0-9_|-]+))?(?:\s+(?:<[^>]+>|\[[^\]]+\]|\{[^}]+\}|[A-Z][A-Z0-9_-]*))*(?:\s{2,}.*|\s*$)/;

const VERSION_TIMEOUT_MS = 3_000;
const HELP_TIMEOUT_MS = 5_000;

export interface FlagDiffResult {
  added: string[];
  removed: string[];
  brokenAdapterFlags: AdapterFlagEntry[];
}

export interface CliHelpCanaryResult {
  runtime: HelpDiffRuntime;
  ok: boolean;
  status: 'baseline' | 'no-change' | 'changed' | 'failed' | 'missing';
  version: string | null;
  binaryPath: string | null;
  snapshotPath: string | null;
  previousVersion: string | null;
  added: string[];
  removed: string[];
  brokenAdapterFlags: AdapterFlagEntry[];
  missingAdapterFlags: AdapterFlagEntry[];
  verdict: string;
}

/**
 * Extract sorted unique long CLI flags (`--flag`) from `--help` text.
 */
export function parseHelpFlags(helpText: string): string[] {
  const flags = new Set<string>();
  for (const line of helpText.split(/\r?\n/)) {
    const match = HELP_OPTION_LINE_RE.exec(line);
    if (!match) continue;
    const rawGroup = match[1] ?? '';
    for (const part of rawGroup.split(',')) {
      const flag = part.trim();
      if (flag.startsWith('--')) flags.add(flag);
    }
  }
  return [...flags].sort();
}

export function diffHelpFlags(
  previousFlags: readonly string[],
  currentFlags: readonly string[],
  runtime: HelpDiffRuntime,
): FlagDiffResult {
  const prevSet = new Set(previousFlags);
  const currSet = new Set(currentFlags);
  const added = [...currSet].filter((f) => !prevSet.has(f)).sort();
  const removed = [...prevSet].filter((f) => !currSet.has(f)).sort();
  const removedSet = new Set(removed);
  const brokenAdapterFlags = ADAPTER_CLI_FLAGS[runtime].filter((entry) =>
    removedSet.has(entry.flag),
  );
  return { added, removed, brokenAdapterFlags };
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

export function resolveCanaryDir(ctx: DoctorContext): string {
  return path.join(ctx.paths.harnessDir, 'doctor', 'canary');
}

export async function runCliHelpCanary(
  ctx: DoctorContext,
  runtime: HelpDiffRuntime,
): Promise<CliHelpCanaryResult> {
  const shortMap: Record<HelpDiffRuntime, 'claude-code' | 'codex' | 'pi'> = {
    claude: 'claude-code',
    codex: 'codex',
    pi: 'pi',
  };
  const spec = OPTIONAL_RUNTIME_SPECS.find((s) => s.agentKind === shortMap[runtime])!;
  const binaryPath = await resolveOptionalRuntimeBinary(ctx, spec);
  if (!binaryPath) {
    return {
      runtime,
      ok: false,
      status: 'missing',
      version: null,
      binaryPath: null,
      snapshotPath: null,
      previousVersion: null,
      added: [],
      removed: [],
      brokenAdapterFlags: [],
      missingAdapterFlags: [],
      verdict: `${spec.displayName} not found; cannot run help diff canary`,
    };
  }

  const verExec = await ctx.exec(binaryPath, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
  const version =
    verExec.code === 0 ? parseRuntimeVersion(verExec.stdout, verExec.stderr) : null;
  if (!version) {
    return {
      runtime,
      ok: false,
      status: 'failed',
      version: null,
      binaryPath,
      snapshotPath: null,
      previousVersion: null,
      added: [],
      removed: [],
      brokenAdapterFlags: [],
      missingAdapterFlags: [],
      verdict: `failed to parse \`${runtime} --version\`: ${verExec.stderr.trim() || verExec.stdout.trim() || `exit ${String(verExec.code)}`}`,
    };
  }

  const helpExec = await ctx.exec(binaryPath, ['--help'], { timeoutMs: HELP_TIMEOUT_MS });
  if (helpExec.code !== 0 && !helpExec.stdout.trim()) {
    return {
      runtime,
      ok: false,
      status: 'failed',
      version,
      binaryPath,
      snapshotPath: null,
      previousVersion: null,
      added: [],
      removed: [],
      brokenAdapterFlags: [],
      missingAdapterFlags: [],
      verdict: `\`${runtime} --help\` failed with exit code ${String(helpExec.code)}`,
    };
  }

  const rawHelp = `${helpExec.stdout}${helpExec.stderr ? `\n${helpExec.stderr}` : ''}`;
  const currentFlags = parseHelpFlags(rawHelp);
  const currentFlagSet = new Set(currentFlags);
  const missingAdapterFlags = ADAPTER_CLI_FLAGS[runtime].filter(
    (entry) => !currentFlagSet.has(entry.flag),
  );

  const canaryDir = resolveCanaryDir(ctx);
  const prefix = `${runtime}-help-`;
  const suffix = '.txt';
  let existingFiles: string[] = [];
  try {
    const entries = await fs.readdir(canaryDir);
    existingFiles = entries.filter((name) => name.startsWith(prefix) && name.endsWith(suffix));
  } catch {
    existingFiles = [];
  }

  const snapshotPath = path.join(canaryDir, `${prefix}${version}${suffix}`);
  const sameVersionSnapshotExists = existingFiles.includes(`${prefix}${version}${suffix}`);

  // Prefer comparing against the same version file on re-run (reports "no change"), or
  // against the newest prior stored version when checking an upgrade.
  let previousVersion: string | null = null;
  let previousText: string | null = null;

  const otherVersions = existingFiles
    .map((f) => f.slice(prefix.length, -suffix.length))
    .filter((v) => v && v !== version)
    .sort((a, b) => compareSemverStrings(b, a));

  if (sameVersionSnapshotExists) {
    previousVersion = version;
    previousText = await fs.readFile(snapshotPath, 'utf8');
  } else if (otherVersions.length > 0) {
    previousVersion = otherVersions[0]!;
    previousText = await fs.readFile(path.join(canaryDir, `${prefix}${previousVersion}${suffix}`), 'utf8');
  }

  const snapshotBody = [
    `# runtime: ${runtime}`,
    `# version: ${version}`,
    `# capturedAt: ${ctx.now().toISOString()}`,
    `# versionOutput: ${(verExec.stdout || verExec.stderr).trim().replace(/\r?\n/g, ' ')}`,
    '',
    rawHelp.trimEnd(),
    '',
  ].join('\n');
  await atomicWriteFile(snapshotPath, snapshotBody);

  if (previousText === null) {
    return {
      runtime,
      ok: true,
      status: 'baseline',
      version,
      binaryPath,
      snapshotPath,
      previousVersion: null,
      added: [],
      removed: [],
      brokenAdapterFlags: [],
      missingAdapterFlags,
      verdict: `stored baseline help snapshot for ${runtime} ${version} (${currentFlags.length} flags)`,
    };
  }

  const prevFlags = parseHelpFlags(previousText);
  const diff = diffHelpFlags(prevFlags, currentFlags, runtime);
  if (diff.brokenAdapterFlags.length > 0) {
    const list = diff.brokenAdapterFlags.map((e) => `${e.flag} (${e.source})`).join(', ');
    return {
      runtime,
      ok: false,
      status: 'failed',
      version,
      binaryPath,
      snapshotPath,
      previousVersion,
      added: diff.added,
      removed: diff.removed,
      brokenAdapterFlags: diff.brokenAdapterFlags,
      missingAdapterFlags,
      verdict: `do not bump: removed adapter flag(s): ${list}`,
    };
  }

  if (diff.added.length === 0 && diff.removed.length === 0) {
    return {
      runtime,
      ok: true,
      status: 'no-change',
      version,
      binaryPath,
      snapshotPath,
      previousVersion,
      added: [],
      removed: [],
      brokenAdapterFlags: [],
      missingAdapterFlags,
      verdict: `no change vs ${runtime} ${previousVersion} (${currentFlags.length} flags)`,
    };
  }

  return {
    runtime,
    ok: true,
    status: 'changed',
    version,
    binaryPath,
    snapshotPath,
    previousVersion,
    added: diff.added,
    removed: diff.removed,
    brokenAdapterFlags: [],
    missingAdapterFlags,
    verdict: `${runtime} ${previousVersion} -> ${version}: +${diff.added.length} added, -${diff.removed.length} removed (all Cindy adapter flags intact)`,
  };
}
