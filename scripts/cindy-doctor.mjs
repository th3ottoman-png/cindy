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
import readline from 'node:readline/promises';
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
  createLkgSnapshot,
  createNodeContext,
  createRegistry,
  formatReportJson,
  formatReportText,
  listLkgSnapshots,
  planLkgRollback,
  rollbackLkgSnapshot,
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
  '--reason',
  '--file',
]);

function printUsage() {
  console.log(`Usage: pnpm run doctor [command] [options]

Commands:
  (default)                      Run diagnostic checks
  snapshot [--reason <text>]     Capture a last-known-good (LKG) config snapshot
  snapshots                      List stored LKG config snapshots
  rollback <stamp> [--file <rel>] [--yes]
                                 Restore config file(s) from an LKG snapshot

Options:
  --all                          Include slow checks (default: instant, fast)
  --only <id|layer>[,...]        Run only matching check IDs or layers
  --include-api                  Probe remote/API endpoints too (outbound; default off)
  --reason <text>                Reason tag for \`snapshot\`
  --file <rel>                   Single relative path (e.g. harness/routing.yaml) for \`rollback\`
  --yes                          Skip interactive confirmation prompt for \`rollback\`
  --json                         Print JSON output
  -h, --help                     Show this help

Exit codes:
  0  Success / no checks failed
  1  At least one check failed or rollback refused/cancelled
  2  Usage error or unexpected doctor failure`);
}

function parseArgs(argv) {
  const opts = {
    all: false,
    includeApi: false,
    json: false,
    yes: false,
    help: false,
    only: [],
    positional: [],
    reason: undefined,
    fileRel: undefined,
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
    if (arg === '--include-api') {
      opts.includeApi = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      opts.yes = true;
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
      } else if (flagName === '--reason') {
        opts.reason = val;
      } else if (flagName === '--file') {
        opts.fileRel = val;
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

    if (!arg.startsWith('-')) {
      opts.positional.push(arg);
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

async function promptConfirmRollback() {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Apply? [y/N] ');
    const norm = answer.trim().toLowerCase();
    return norm === 'y' || norm === 'yes';
  } finally {
    rl.close();
  }
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
    includeApi: opts.includeApi,
  });

  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);

  const cmd = opts.positional[0];
  if (cmd === 'snapshot') {
    if (opts.positional.length > 1) {
      throw new Error(`unexpected argument for snapshot: ${opts.positional[1]}`);
    }
    const created = await createLkgSnapshot(ctx, {
      reason: opts.reason ?? 'manual',
    });
    if (opts.json) {
      console.log(JSON.stringify(created, null, 2));
    } else {
      console.log(
        `Created LKG snapshot ${created.stamp} (${created.manifest.files.length} files, reason="${created.manifest.reason}", pruned=${created.pruned.length})`,
      );
      console.log(`Location: ${created.dir}`);
    }
    process.exit(0);
  }

  if (cmd === 'snapshots') {
    if (opts.positional.length > 1) {
      throw new Error(`unexpected argument for snapshots: ${opts.positional[1]}`);
    }
    const list = await listLkgSnapshots(ctx);
    if (opts.json) {
      console.log(JSON.stringify(list, null, 2));
    } else if (list.length === 0) {
      console.log('No LKG snapshots found.');
    } else {
      for (const item of list) {
        if (item.valid && item.manifest) {
          const c = item.manifest.reportCounts;
          console.log(
            `${item.stamp}  files=${item.manifest.files.length}  ok=${c.ok} warn=${c.warn} fail=${c.fail}  reason="${item.manifest.reason}"`,
          );
        } else {
          console.log(`${item.stamp}  INVALID (${item.validationError ?? 'manifest error'})`);
        }
      }
    }
    process.exit(0);
  }

  if (cmd === 'rollback') {
    const stamp = opts.positional[1];
    if (!stamp) {
      throw new Error('rollback requires <stamp> (see `pnpm run doctor snapshots`)');
    }
    if (opts.positional.length > 2) {
      throw new Error(`unexpected argument for rollback: ${opts.positional[2]}`);
    }

    const plan = await planLkgRollback(ctx, { stamp, fileRel: opts.fileRel });
    if (!plan.ok) {
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.error(`cindy-doctor rollback: ${plan.error}`);
      }
      process.exit(1);
    }

    if (!opts.json) {
      console.log(`Rollback plan for snapshot ${plan.stamp}:`);
      for (const item of plan.items) {
        console.log(
          `  - ${item.rel} -> ${item.destPath}${item.wouldMoveAside ? ' (moves current aside to .pre-rollback-<stamp>)' : ''}`,
        );
      }
    }

    if (!opts.yes) {
      const confirmed = opts.json ? false : await promptConfirmRollback();
      if (!confirmed) {
        if (opts.json) {
          console.log(
            JSON.stringify({
              ok: false,
              stamp: plan.stamp,
              error: 'Confirmation required: re-run with --yes',
            }, null, 2),
          );
        } else {
          console.error('Rollback cancelled (pass --yes to apply without interactive prompt).');
        }
        process.exit(1);
      }
    }

    const result = await rollbackLkgSnapshot(ctx, { stamp, fileRel: opts.fileRel });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.ok) {
      console.error(`cindy-doctor rollback: ${result.error}`);
    } else {
      console.log(`Restored ${result.restored.length} file(s) from LKG snapshot ${result.stamp}:`);
      for (const p of result.restored) {
        console.log(`  restored: ${p}`);
      }
      for (const p of result.movedAside) {
        console.log(`  moved aside: ${p}`);
      }
      if (result.configReport) {
        console.log('');
        console.log(formatReportText(result.configReport));
      }
    }
    if (!result.ok) {
      process.exit(1);
    }
    process.exit((result.configReport?.counts.fail ?? 0) > 0 ? 1 : 0);
  }

  if (cmd !== undefined) {
    throw new Error(`unknown command: ${cmd}`);
  }

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
