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

import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTO_REVIEW_CREDENTIALS_FLAG, AUTO_REVIEW_HOOK_FLAG, runAutoReviewHook } from '../auto-review-gate.js';
import { prepareAutoReviewHookArgv, type InterpreterProbeIo } from '../auto-review-hook-python.js';
import { HermesManager } from '../hermes-manager.js';

/** Reads the first bytes of Hermes's entry scripts and finds `hermes` on PATH (ROADMAP 1.13e). */
const interpreterProbeIo: InterpreterProbeIo = {
  async readHead(file) {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  },
  async which(name) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try {
        await fsp.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        /* next PATH entry */
      }
    }
    return undefined;
  },
};

/** ROADMAP 1.13b: Hermes runs this same bundle as the `pre_tool_call` hook of an `auto` session. */
async function hookMain(): Promise<void> {
  const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const credAt = process.argv.indexOf(AUTO_REVIEW_CREDENTIALS_FLAG);
  const credentialsFile = credAt > -1 ? process.argv[credAt + 1] : undefined;
  const result = await runAutoReviewHook({ readStdin, env: process.env, ...(credentialsFile ? { credentialsFile } : {}) }).catch(() => ({
    stdout: JSON.stringify({ decision: 'block', reason: 'Cindy auto-review hook crashed.' }),
    exitCode: 2,
  }));
  process.stdout.write(`${result.stdout}\n`, () => process.exit(result.exitCode));
}

interface Args {
  socketPath: string;
  hermesHome?: string;
  hermesBin?: string;
  registryFile?: string;
  perSessionHomes: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { socketPath: '', perSessionHomes: false, verbose: false };
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
    else if (arg === '--per-session-homes') args.perSessionHomes = true;
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
    fail(`usage: hermes-mgr --socket <path> [--hermes-home <dir>] [--hermes-bin <bin>] [--registry <file>] [--per-session-homes] [--verbose]\n${(err as Error).message}`);
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

  // The hook runs under Hermes's own Python (found from the `hermes` entry script's
  // shebang, ROADMAP 1.13e), so no node is needed on the gateway's PATH. When that cannot be
  // found it falls back to `node` from PATH (1.13b); a missing node fails the hook, which is
  // fail_closed, so every `auto` tool call is then blocked, never let through.
  const bundlePath = fileURLToPath(import.meta.url);
  const autoReviewHookArgv = args.perSessionHomes
    ? await prepareAutoReviewHookArgv({
        hermesBin: args.hermesBin ?? 'hermes',
        stateDir: path.join(resolvedHome, 'hermes-mgr'),
        bundlePath,
        io: interpreterProbeIo,
        log: (message, ctx) => console.error('[hermes-mgr][info]', message, ctx ?? ''),
      })
    : undefined;
  const manager = new HermesManager({
    socketPath: args.socketPath,
    hermesHome: resolvedHome,
    ...(args.perSessionHomes
      ? { sessionHomes: {}, autoReviewHookArgv: autoReviewHookArgv! }
      : {}),
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

if (process.argv[2] === AUTO_REVIEW_HOOK_FLAG) void hookMain();
else void main();
