/**
 * ROADMAP 13.10b: bridge for the session manifest strip's `shell 300s` chip.
 *
 * The daemon writes the limit into each session home's `config.yaml`; this handler only reports
 * what `~/.cindy-harness/shell-limits.yaml` says, so the owner can see the limit in the strip
 * without opening the file. Local file read only: no network, no model call, no daemon round trip.
 */

import { loadShellLimitsConfig, type ShellLimitsConfig } from '@cindy/maker-hermes-manager';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ShellLimitsView {
  /** 0 = the Hermes default (180 s) is left alone. */
  timeoutSeconds: number;
  errors: string[];
  file: string;
  exists: boolean;
}

export const UNAVAILABLE_SHELL_LIMITS: ShellLimitsView = {
  timeoutSeconds: 0,
  errors: [],
  file: '',
  exists: false,
};

/** Narrows a load result to the view; anything malformed reads as unavailable. */
export function toShellLimitsView(raw: unknown): ShellLimitsView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return UNAVAILABLE_SHELL_LIMITS;
  const r = raw as Record<string, unknown>;
  const config = r.config as Partial<ShellLimitsConfig> | undefined;
  if (!config || typeof config !== 'object') return UNAVAILABLE_SHELL_LIMITS;
  const seconds = config.timeoutSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return UNAVAILABLE_SHELL_LIMITS;
  }
  return {
    timeoutSeconds: Math.floor(seconds),
    errors: Array.isArray(r.errors)
      ? r.errors.filter((item): item is string => typeof item === 'string')
      : [],
    file: typeof r.file === 'string' ? r.file : '',
    exists: r.exists === true,
  };
}

export async function readShellLimitsView(
  load: () => Promise<unknown> = loadShellLimitsConfig,
): Promise<ShellLimitsView> {
  try {
    return toShellLimitsView(await load());
  } catch {
    return UNAVAILABLE_SHELL_LIMITS;
  }
}

export function registerShellLimitsHandlers(
  registry: IpcHandlerRegistry,
  deps: { assertTrusted: (event: unknown) => void },
): void {
  registry.handle(MAKER_INVOKE.SHELL_LIMITS_GET, (event: unknown) => {
    deps.assertTrusted(event);
    return readShellLimitsView();
  });
}
