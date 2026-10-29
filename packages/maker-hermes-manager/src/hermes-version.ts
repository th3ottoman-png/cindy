import { execFile } from 'node:child_process';

export const HERMES_CLI_PINNED_VERSION = '0.22.5' as const;

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
