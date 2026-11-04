/**
 * Production wiring for the 4.4b skills host (Electron-dependent; kept out of
 * `skills.ts` so the host itself tests under plain vitest).
 *
 * Roots come from the Cindy Hermes home (`resolveHermesHome`, refuses the daily home):
 * enabled skills live in `<home>/skills`, disabled ones in `<home>/skills-disabled`
 * (a sibling Hermes never scans). The git clone — the only outbound call — runs
 * exclusively when the renderer explicitly scans a git URL (AGENTS §3).
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';

import { resolveHermesHome } from '../maker-host/hermes-manager-client.js';
import { createSkillsHost, type SkillsHost } from './skills.js';

const CLONE_TIMEOUT_MS = 60_000;

function gitClone(url: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['clone', '--depth', '1', '--', url, destDir],
      { timeout: CLONE_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve();
      },
    );
  });
}

export function createDesktopSkillsHost(): SkillsHost {
  return createSkillsHost({
    roots: () => {
      const home = resolveHermesHome();
      return { skillsRoot: path.join(home, 'skills'), disabledRoot: path.join(home, 'skills-disabled') };
    },
    clone: gitClone,
  });
}
