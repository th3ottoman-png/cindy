import os from 'node:os';
import path from 'node:path';

/**
 * HERMES_HOME the desktop dev app is launched with.
 *
 * The desktop main is fail-closed: `resolveHermesHome()` refuses the owner's daily
 * `~/.hermes` and any path inside it. That guard is right, but the dev app inherits
 * whatever the launching shell exports, and an agent harness (or a developer's own
 * shell) commonly exports `HERMES_HOME=~/.hermes`. The app then has no way back —
 * every Hermes surface throws "hermes-mgr configuration invalid" and the daemon
 * never starts, because `resolveHermesHome()` has no other override.
 *
 * So the launcher pins Cindy's own home by default, and keeps an explicit override
 * only when it points somewhere outside the daily home (a scratch home for a probe).
 */
export const DEFAULT_DESKTOP_DEV_HERMES_HOME = '.hermes-cindy';

function foldPathCase(value) {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? value.toLowerCase()
    : value;
}

function isSameOrInside(candidate, parent) {
  const foldedCandidate = foldPathCase(candidate);
  const foldedParent = foldPathCase(parent);
  return (
    foldedCandidate === foldedParent ||
    foldedCandidate.startsWith(`${foldedParent}${path.sep}`)
  );
}

export function resolveDesktopDevHermesHome(env = process.env, homeDir = os.homedir()) {
  const dailyHome = path.resolve(homeDir, '.hermes');
  const configured = env?.HERMES_HOME?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (!isSameOrInside(resolved, dailyHome)) return resolved;
  }
  return path.join(homeDir, DEFAULT_DESKTOP_DEV_HERMES_HOME);
}
