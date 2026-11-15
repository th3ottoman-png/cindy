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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

register();

const CINDY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const doctorMod = await import(
  pathToFileURL(path.join(CINDY_ROOT, 'packages/maker-core/src/doctor/index.ts')).href
);
const hermesVersionMod = await import(
  pathToFileURL(path.join(CINDY_ROOT, 'packages/maker-hermes-manager/src/hermes-version.ts')).href
);

const {
  ALL_PACKS,
  applyFix,
  assertNotDailyHermes,
  createIncidentBundle,
  createLkgSnapshot,
  createNodeContext,
  createRegistry,
  formatReportJson,
  formatReportText,
  listLkgSnapshots,
  planLkgRollback,
  previewFix,
  rollbackLkgSnapshot,
  runChecks,
  runCliHelpCanary,
  runHermesCanary,
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
  '--target',
  '--runtime',
  '--model',
]);

function printUsage() {
  console.log(`Usage: pnpm run doctor [command] [options]

Commands:
  (default)                      Run diagnostic checks
  bundle                         Write a redacted local incident bundle (~/.cindy-harness/doctor/bundles/<stamp>.md)
  snapshot [--reason <text>]     Capture a last-known-good (LKG) config snapshot
  snapshots                      List stored LKG config snapshots
  rollback <stamp> [--file <rel>] [--yes]
                                 Restore config file(s) from an LKG snapshot
  fix <fixId> [--target <x>] [--yes]
                                 Preview and apply a fix (asks Apply? [y/N] unless --yes)
  canary --runtime <hermes|claude|codex|pi> [--model <route>] [--paid]
                                 Run upgrade canary checks against an installed runtime

Options:
  --runtime <name>               Target runtime for \`canary\`: hermes, claude, codex, or pi
  --model <route>                Optional routing.yaml route name for Hermes canary (local default)
  --paid                         Allow an API route for Hermes canary (prompts confirmation first)
  --all                          Include slow checks (default: instant, fast)
  --only <id|layer>[,...]        Run only matching check IDs or layers
  --include-api                  Probe remote/API endpoints too (outbound; default off)
  --reason <text>                Reason tag for \`snapshot\`
  --file <rel>                   Single relative path (e.g. harness/routing.yaml) for \`rollback\`
  --target <value>               Optional target for \`fix\` (e.g. harness/routing.yaml)
  --yes                          Skip interactive confirmation prompt for \`rollback\` / \`fix\`
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
    paid: false,
    reason: undefined,
    fileRel: undefined,
    target: undefined,
    runtime: undefined,
    modelRoute: undefined,
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
    if (arg === '--paid') {
      opts.paid = true;
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
      } else if (flagName === '--target') {
        opts.target = val;
      } else if (flagName === '--runtime') {
        opts.runtime = val;
      } else if (flagName === '--model') {
        opts.modelRoute = val;
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
  if (cmd === 'bundle') {
    if (opts.positional.length > 1) {
      throw new Error(`unexpected argument for bundle: ${opts.positional[1]}`);
    }
    const created = await createIncidentBundle(ctx, {
      includeApi: opts.includeApi,
    });
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            stamp: created.stamp,
            path: created.path,
            displayPath: created.displayPath,
            createdAt: created.createdAt,
            bytes: created.bytes,
            reportCounts: created.reportCounts,
            configCount: created.configCount,
            envKeyCount: created.envKeyCount,
          },
          null,
          2,
        ),
      );
    } else {
      const c = created.reportCounts;
      console.log(
        `Created incident bundle ${created.stamp} (${created.bytes} bytes; ${c.ok} ok, ${c.warn} warn, ${c.fail} fail, ${c.skip} skip)`,
      );
      console.log(`Location: ${created.path}`);
      console.log('Stored locally only (no upload).');
    }
    process.exit(0);
  }

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

  if (cmd === 'fix') {
    const fixId = opts.positional[1];
    if (!fixId) {
      throw new Error('fix requires <fixId> (e.g. fix.config.restore-lkg, fix.proc.kill-orphans, fix.proc.stale-socket)');
    }
    if (opts.positional.length > 2) {
      throw new Error(`unexpected argument for fix: ${opts.positional[2]}`);
    }

    const registry = createRegistry(ALL_PACKS);
    const preview = await previewFix(registry, ctx, fixId, { target: opts.target });
    if (!preview.ok) {
      if (preview.unknownFix) {
        throw new Error(preview.error);
      }
      if (opts.json) {
        console.log(JSON.stringify(preview, null, 2));
      } else {
        console.error(`cindy-doctor fix: ${preview.error}`);
      }
      process.exit(1);
    }

    const { fix, plan } = preview;
    if (!opts.json) {
      console.log(`Fix plan for ${fix.id}:`);
      for (const step of plan.steps) {
        console.log(`  - ${step}`);
      }
      if (plan.touches.length > 0) {
        console.log(`Touches (${plan.touches.length}): ${plan.touches.join(', ')}`);
      }
    }

    const needsAppClosedNow = fix.needsAppClosed || Boolean(plan.requiresAppClosed);
    if (needsAppClosedNow) {
      const { detectAppRunningState } = await import(
        pathToFileURL(path.join(CINDY_ROOT, 'packages/maker-core/src/doctor/packs/processes.ts')).href
      );
      const running = ctx.appRunning ?? (await detectAppRunningState(ctx)).running;
      if (running) {
        const msg = `Refused: fix "${fix.id}" requires Cindy desktop app to be closed.`;
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, rolledBack: false, message: msg, plan, recheck: [] }, null, 2));
        } else {
          console.error(`cindy-doctor fix: ${msg}`);
        }
        process.exit(1);
      }
    }

    if (plan.meta && typeof plan.meta.refusalReason === 'string' && plan.meta.refusalReason.length > 0) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, rolledBack: false, message: plan.meta.refusalReason, plan, recheck: [] }, null, 2));
      } else {
        console.error(`cindy-doctor fix: ${plan.meta.refusalReason}`);
      }
      process.exit(1);
    }

    if (!opts.yes) {
      const confirmed = opts.json ? false : await promptConfirmRollback();
      if (!confirmed) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                ok: false,
                rolledBack: false,
                fixId: fix.id,
                plan,
                message: 'Confirmation required: re-run with --yes',
                recheck: [],
              },
              null,
              2,
            ),
          );
        } else {
          console.error('Fix cancelled (pass --yes to apply without interactive prompt).');
        }
        process.exit(1);
      }
    }

    const outcome = await applyFix(registry, ctx, plan);
    if (opts.json) {
      console.log(JSON.stringify({ ...outcome, plan }, null, 2));
    } else {
      console.log(`${outcome.ok ? 'Applied' : 'Failed'}: ${outcome.message}`);
      if (outcome.rolledBack) {
        console.log('Rolled back automatically to pre-fix snapshot.');
      }
      if (outcome.preFixSnapshotStamp) {
        console.log(`Pre-fix snapshot: ${outcome.preFixSnapshotStamp}`);
      }
      if (outcome.fixLogPath) {
        console.log(`Fix log: ${outcome.fixLogPath}`);
      }
      if (outcome.recheck.length > 0) {
        console.log('');
        for (const item of outcome.recheck) {
          console.log(`  [${item.severity.toUpperCase()}] ${item.id}: ${item.summary}`);
        }
      }
    }

    process.exit(outcome.ok ? 0 : 1);
  }

  if (cmd === 'canary') {
    if (opts.positional.length > 1) {
      throw new Error(`unexpected argument for canary: ${opts.positional[1]}`);
    }
    const runtime = opts.runtime;
    if (!runtime || !['hermes', 'claude', 'codex', 'pi'].includes(runtime)) {
      throw new Error('canary requires --runtime <hermes|claude|codex|pi>');
    }

    if (runtime === 'hermes') {
      const result = await runHermesCanary(ctx, {
        modelRoute: opts.modelRoute,
        paid: opts.paid,
        confirmPaid: async ({ expectedCost }) => {
          if (opts.json || !process.stdin.isTTY) {
            return false;
          }
          console.log(`Paid canary confirmation needed: ${expectedCost}`);
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await rl.question('Proceed with paid API call? [y/N] ');
            const norm = answer.trim().toLowerCase();
            return norm === 'y' || norm === 'yes';
          } finally {
            rl.close();
          }
        },
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const routeDesc = result.route
          ? `${result.route.routeName} (${result.route.providerId}/${result.route.model})`
          : 'none';
        console.log(
          `Hermes canary · v${result.version ?? 'unknown'} · route=${routeDesc} · status=${result.status}`,
        );
        console.log('');
        for (const c of result.contracts) {
          console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(26)}  ${c.detail}`);
        }
        for (const nc of result.notCovered) {
          console.log(`NOTE  ${nc.area.padEnd(26)}  ${nc.note}`);
        }
        if (result.recordPath) {
          console.log('');
          console.log(`Saved: ${result.recordPath}`);
        }
        console.log(`Verdict: ${result.verdict}`);
      }
      if (result.status === 'error') process.exit(2);
      process.exit(result.ok ? 0 : 1);
    }

    if (opts.paid || opts.modelRoute) {
      throw new Error(`--paid / --model are only supported for --runtime hermes (help diff for ${runtime} makes zero model calls)`);
    }

    const helpRes = await runCliHelpCanary(ctx, runtime);
    if (opts.json) {
      console.log(JSON.stringify(helpRes, null, 2));
    } else {
      console.log(
        `${helpRes.runtime} help canary · v${helpRes.version ?? 'unknown'} · status=${helpRes.status}`,
      );
      if (helpRes.previousVersion) {
        console.log(`Compared against: v${helpRes.previousVersion}`);
      }
      if (helpRes.added.length > 0) {
        console.log(`Added flags (${helpRes.added.length}): ${helpRes.added.join(', ')}`);
      }
      if (helpRes.removed.length > 0) {
        console.log(`Removed flags (${helpRes.removed.length}): ${helpRes.removed.join(', ')}`);
      }
      if (helpRes.brokenAdapterFlags.length > 0) {
        for (const item of helpRes.brokenAdapterFlags) {
          console.log(`FAIL  ${item.flag}  removed flag used by ${item.source}`);
        }
      }
      if (helpRes.snapshotPath) {
        console.log(`Saved: ${helpRes.snapshotPath}`);
      }
      console.log(`Verdict: ${helpRes.verdict}`);
    }
    if (helpRes.status === 'missing') process.exit(1);
    process.exit(helpRes.ok ? 0 : 1);
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
