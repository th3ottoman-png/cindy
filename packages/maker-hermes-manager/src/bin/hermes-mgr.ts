/**
 * hermes-mgr — local daemon wrapping an isolated Hermes Agent install as a
 * Cindy harness (NDJSON RPC on a unix socket; see ../hermes-manager.ts).
 *
 * Fail-closed guard: refuses to start when HERMES_HOME resolves to the daily
 * Hermes home (~/.hermes). The Cindy adapter must always drive a dedicated
 * home; nothing in this daemon may ever touch the user's daily Hermes.
 *
 * The executable shebang is added by build.mjs's esbuild banner.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { HermesManager } from '../hermes-manager.js';

interface Args {
  socketPath: string;
  hermesHome?: string;
  hermesBin?: string;
  registryFile?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { socketPath: '', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === '--socket') args.socketPath = next();
    else if (arg.startsWith('--socket=')) args.socketPath = arg.slice('--socket='.length);
    else if (arg === '--hermes-home') args.hermesHome = next();
    else if (arg.startsWith('--hermes-home=')) args.hermesHome = arg.slice('--hermes-home='.length);
    else if (arg === '--hermes-bin') args.hermesBin = next();
    else if (arg.startsWith('--hermes-bin=')) args.hermesBin = arg.slice('--hermes-bin='.length);
    else if (arg === '--registry') args.registryFile = next();
    else if (arg.startsWith('--registry=')) args.registryFile = arg.slice('--registry='.length);
    else if (arg === '--verbose') args.verbose = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`[hermes-mgr] ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(`usage: hermes-mgr --socket <path> [--hermes-home <dir>] [--hermes-bin <bin>] [--registry <file>] [--verbose]\n${(err as Error).message}`);
  }
  if (!args.socketPath) fail('--socket is required');

  const hermesHome = args.hermesHome ?? process.env.HERMES_HOME ?? '';
  if (!hermesHome) {
    fail('HERMES_HOME is not set — pass --hermes-home or run under a pinned home (e.g. hermes-cindy)');
  }
  const resolvedHome = path.resolve(hermesHome);
  const dailyHome = path.join(os.homedir(), '.hermes');
  if (resolvedHome === dailyHome) {
    fail(`refusing to start: HERMES_HOME resolves to the daily Hermes home (${dailyHome})`);
  }

  const manager = new HermesManager({
    socketPath: args.socketPath,
    hermesHome: resolvedHome,
    ...(args.hermesBin ? { hermesBin: args.hermesBin } : {}),
    ...(args.registryFile
      ? { registryFile: args.registryFile }
      : { registryFile: path.join(resolvedHome, 'hermes-mgr', 'sessions.json') }),
    logger: {
      debug: (msg, ctx) => {
        if (args.verbose) console.error('[hermes-mgr][debug]', msg, ctx ?? '');
      },
      info: (msg, ctx) => console.error('[hermes-mgr][info]', msg, ctx ?? ''),
      warn: (msg, ctx) => console.error('[hermes-mgr][warn]', msg, ctx ?? ''),
      error: (msg, ctx) => console.error('[hermes-mgr][error]', msg, ctx ?? ''),
    },
  });

  await manager.start();
  // Machine-readable readiness line for the desktop spawner (M2).
  process.stderr.write(`HERMES_MGR_READY socket=${args.socketPath} home=${resolvedHome}\n`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void manager
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
