/**
 * Runtimes (ROADMAP 12.5): read-only status of the agent CLIs. `maker:runtimes:list` resolves
 * each binary the way its adapter already does — Hermes via the launcher on PATH + the dedicated
 * home (reusing `hermes-version.ts` and its pin), claude-code/codex/pi via the agent-binaries
 * cache — then runs `--version` with a 5 s timeout. No network, nothing installed or updated.
 *
 * The parse + status fold is pure in `@cindy/maker-core/runtime-status`; the resolution/probe
 * seams are injected so tests need no real binary.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildRuntimeStatus,
  parseRuntimeVersion,
  RUNTIME_IDS,
  type RuntimeId,
  type RuntimeStatus,
} from '@cindy/maker-core/runtime-status';
import { HERMES_CLI_PINNED_VERSION, readInstalledHermesVersion } from '@cindy/maker-hermes-manager';

import { getCachedBinaryStatus, type AgentBinaryKind } from '../agent-binaries/index.js';
import { resolveHermesHome } from '../maker-host/hermes-manager-client.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface RuntimeProbeResult {
  version: string | null;
  error?: string;
}

export interface RuntimesDeps {
  resolvePath(id: RuntimeId): string | undefined;
  probeVersion(id: RuntimeId, binaryPath: string): Promise<RuntimeProbeResult>;
  pinnedVersion(id: RuntimeId): string | undefined;
}

/** Fold every runtime's resolved path + probed version into a card status (pure orchestration). */
export async function collectRuntimeStatuses(deps: RuntimesDeps): Promise<RuntimeStatus[]> {
  const out: RuntimeStatus[] = [];
  for (const id of RUNTIME_IDS) {
    const pinned = deps.pinnedVersion(id);
    const binaryPath = deps.resolvePath(id);
    if (!binaryPath) {
      out.push(buildRuntimeStatus({ id, path: null, pinned }));
      continue;
    }
    const probe = await deps.probeVersion(id, binaryPath);
    out.push(buildRuntimeStatus({ id, path: binaryPath, version: probe.version, pinned, probeError: probe.error }));
  }
  return out;
}

/** Resolve a command name on PATH (the Hermes adapter runs `hermes` this way). */
export function resolveOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here / not executable: keep looking
    }
  }
  return undefined;
}

function probeRawVersion(binaryPath: string, env?: NodeJS.ProcessEnv): Promise<RuntimeProbeResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        binaryPath,
        ['--version'],
        { encoding: 'utf8', timeout: VERSION_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true, ...(env ? { env } : {}) },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ version: null, error: error.message });
            return;
          }
          resolve({ version: parseRuntimeVersion(stdout, stderr) });
        },
      );
    } catch (err) {
      resolve({ version: null, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Production seams: the adapters' own resolvers + a 5 s `--version` probe. */
export function createDesktopRuntimesDeps(): RuntimesDeps {
  return {
    resolvePath(id) {
      if (id === 'hermes') return resolveOnPath('hermes');
      // The fs-verified sync resolver (not the prepare() cache, which can hold a stale path):
      // a status card must reflect whether the binary is actually there right now.
      return getCachedBinaryStatus(id as AgentBinaryKind).binaryPath;
    },
    async probeVersion(id, binaryPath) {
      if (id === 'hermes') {
        try {
          const version = await readInstalledHermesVersion({ hermesBin: binaryPath, hermesHome: resolveHermesHome() });
          return { version };
        } catch (err) {
          return { version: null, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return probeRawVersion(binaryPath);
    },
    pinnedVersion(id) {
      return id === 'hermes' ? HERMES_CLI_PINNED_VERSION : undefined;
    },
  };
}

export interface RuntimesHandlerDeps {
  assertTrusted(event: unknown): void;
  /** Injected so tests need no real binary; production uses createDesktopRuntimesDeps(). */
  runtimes?: RuntimesDeps;
}

export function registerRuntimesHandlers(registry: IpcHandlerRegistry, deps: RuntimesHandlerDeps): void {
  const runtimes = deps.runtimes ?? createDesktopRuntimesDeps();
  registry.handle(MAKER_INVOKE.RUNTIMES_LIST, async (event) => {
    deps.assertTrusted(event);
    return { runtimes: await collectRuntimeStatuses(runtimes) };
  });
}
