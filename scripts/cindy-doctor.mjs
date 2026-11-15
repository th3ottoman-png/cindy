#!/usr/bin/env node
/**
 * Cindy Doctor CLI (ROADMAP 14.2, blueprint §2.3 & §7).
 *
 * Usage:
 *   pnpm doctor                          Run instant + fast checks, plain text
 *   pnpm doctor --all                    Include slow checks
 *   pnpm doctor --only <id|layer>[,...]  Filter to specific check IDs or layers
 *   pnpm doctor --json                   Output DoctorReport JSON
 *
 * Exit codes: 0 = no fail, 1 = >= 1 fail, 2 = CLI usage or doctor error.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();

const CINDY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const doctorMod = await import(path.join(CINDY_ROOT, 'packages/maker-core/src/doctor/index.ts'));
const hermesVersionMod = await import(
  path.join(CINDY_ROOT, 'packages/maker-hermes-manager/src/hermes-version.ts')
);

const {
  ALL_PACKS,
  assertNotDailyHermes,
  createNodeContext,
  createRegistry,
  formatReportJson,
  formatReportText,
  runChecks,
} = doctorMod;
const { HERMES_CLI_PINNED_VERSION } = hermesVersionMod;

const VALUE_FLAGS = new Set([
  '--only',
  '--home',
  '--hermes-home',
  '--harness-dir',
  '--user-data',
  '--repo-root',
]);

function printUsage() {
  console.log(`Usage: pnpm doctor [options]

Options:
  --all                    Include slow checks (default: instant, fast)
  --only <id|layer>[,...]  Run only matching check IDs or layers
  --json                   Print DoctorReport as JSON
  -h, --help               Show this help

Exit codes:
  0  No checks failed
  1  At least one check failed
  2  Usage error or unexpected doctor failure`);
}

function parseArgs(argv) {
  const opts = {
    all: false,
    json: false,
    help: false,
    only: [],
    home: undefined,
    hermesHome: undefined,
    harnessDir: undefined,
    userDataDir: undefined,
    repoRoot: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      opts.all = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }

    // Handle `--flag=value` and `--flag value` uniformly for value flags
    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    if (VALUE_FLAGS.has(flagName)) {
      let val;
      if (eqIdx >= 0) {
        val = arg.slice(eqIdx + 1);
      } else {
        i += 1;
        if (i >= argv.length) {
          throw new Error(`missing value for ${flagName}`);
        }
        val = argv[i];
      }
      if (!val) {
        throw new Error(`empty value for ${flagName}`);
      }
      if (flagName === '--only') {
        for (const token of val.split(',').map((s) => s.trim()).filter(Boolean)) {
          opts.only.push(token);
        }
      } else if (flagName === '--home') {
        opts.home = val;
      } else if (flagName === '--hermes-home') {
        opts.hermesHome = val;
      } else if (flagName === '--harness-dir') {
        opts.harnessDir = val;
      } else if (flagName === '--user-data') {
        opts.userDataDir = val;
      } else if (flagName === '--repo-root') {
        opts.repoRoot = val;
      }
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  const ctx = createNodeContext({
    home: opts.home,
    hermesHome: opts.hermesHome,
    harnessDir: opts.harnessDir,
    userDataDir: opts.userDataDir,
    repoRoot: opts.repoRoot ?? CINDY_ROOT,
    hermesPinnedVersion: HERMES_CLI_PINNED_VERSION,
  });

  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);

  const registry = createRegistry(ALL_PACKS);
  const report = await runChecks(registry, ctx, {
    cost: opts.all ? undefined : ['instant', 'fast'],
    ...(opts.only.length > 0 ? { only: opts.only } : {}),
  });

  console.log(opts.json ? formatReportJson(report) : formatReportText(report));
  process.exit(report.counts.fail > 0 ? 1 : 0);
} catch (err) {
  console.error(`cindy-doctor: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
