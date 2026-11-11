/**
 * Injection-guard settings (`~/.cindy-harness/security.json`, ROADMAP 10.1).
 *
 * The host owns the file; the renderer only renders and submits. Reading is cheap and never
 * throws (the config module falls back to the defaults plus an issue), so `getConfig` can be called
 * whenever Settings is opened.
 */

import { readGuardConfig, writeGuardConfig, defaultGuardConfigFile, type GuardConfigRead } from '@cindy/maker-core/guard-config';
import type { GuardConfig } from '@cindy/maker-core/injection-guard';

export interface SecurityGuardView extends GuardConfigRead {}

export interface SecurityGuardHostDeps {
  /** Production: ~/.cindy-harness/security.json. */
  configFile?: string;
  home?: string;
}

export class SecurityGuardHost {
  private readonly configFile: string;

  constructor(deps: SecurityGuardHostDeps = {}) {
    this.configFile =
      deps.configFile ??
      defaultGuardConfigFile(deps.home ?? process.env.HOME ?? '');
  }

  getConfig(): SecurityGuardView {
    return readGuardConfig(this.configFile);
  }

  /** Merge one change into the stored config. Never widens to `off` by accident. */
  setConfig(request: unknown): SecurityGuardView {
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const current = readGuardConfig(this.configFile).config;
    const next: Partial<GuardConfig> = {
      threshold: typeof r.threshold === 'number' ? r.threshold : current.threshold,
      policy:
        r.policy === 'off' || r.policy === 'log' || r.policy === 'hold' || r.policy === 'block'
          ? r.policy
          : current.policy,
    };
    writeGuardConfig(this.configFile, next);
    return this.getConfig();
  }
}

export function getDesktopSecurityGuardHost(deps?: SecurityGuardHostDeps): SecurityGuardHost {
  return new SecurityGuardHost(deps);
}

export function registerSecurityGuardHandlers(
  registry: { handle: (channel: string, handler: (event: unknown, request?: unknown) => unknown) => void },
  deps: { host: SecurityGuardHost; assertTrusted: (event: unknown) => void; channels: { GET: string; SET: string } },
): void {
  registry.handle(deps.channels.GET, (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });
  registry.handle(deps.channels.SET, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    return deps.host.setConfig(request);
  });
}
