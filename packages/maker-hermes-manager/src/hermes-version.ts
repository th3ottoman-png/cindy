import { execFile } from 'node:child_process';

export const HERMES_CLI_PINNED_VERSION = '0.22.7' as const;

/**
 * ROADMAP 10.3 chat-only: `-t ''` (an empty toolset list) is how the built-in tools are removed,
 * but Hermes has no documented "no toolsets" sentinel — the behaviour was measured, not specified.
 * `-t none` is rejected outright, and a future CLI could read an empty value as "unset" and quietly
 * hand the tools back. So chat-only is only allowed on the lines that were measured.
 *
 * Measured on: 0.22.7 (the pin the repo ships against) and 0.23.0 (the CLI actually installed on
 * this machine, 2026-11-11 — `--safe-mode -t ''` left the file absent while `--safe-mode` alone
 * created it). A new minor line must be measured before it is trusted again.
 */
export const CHAT_ONLY_TOOLSETS_MIN_VERSION = '0.22.7' as const;
export const CHAT_ONLY_TOOLSETS_MAX_EXCLUSIVE = '0.24.0' as const;

function parseVersion(version: string | null | undefined): [number, number, number] | null {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * True only inside the measured window. An unknown or unparseable version returns **false**: the
 * guard fails closed, because the failure mode it prevents (tools silently coming back in a
 * session the owner marked "no tools") is worse than refusing chat-only on a newer CLI.
 */
export function supportsChatOnlyToolsets(version: string | null | undefined): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const min = parseVersion(CHAT_ONLY_TOOLSETS_MIN_VERSION)!;
  const max = parseVersion(CHAT_ONLY_TOOLSETS_MAX_EXCLUSIVE)!;
  return compareVersions(parsed, min) >= 0 && compareVersions(parsed, max) < 0;
}

export interface HermesVersionProbeOptions {
  hermesBin: string;
  hermesHome: string;
  hermesExtraArgs?: string[];
}

export async function readInstalledHermesVersion(
  opts: HermesVersionProbeOptions,
): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      opts.hermesBin,
      [...(opts.hermesExtraArgs ?? []), '--version'],
      {
        env: {
          ...process.env,
          HERMES_HOME: opts.hermesHome,
          HERMES_MGR_CHILD: '1',
        },
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
      (error, output) => {
        if (error) reject(error);
        else resolve(output);
      },
    );
  });
  const match = stdout.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  if (!match) throw new Error('unrecognized Hermes --version output');
  return match[1];
}
