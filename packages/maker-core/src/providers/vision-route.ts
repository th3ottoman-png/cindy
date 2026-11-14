/**
 * Resolve the `vision` task class to a vision-capable endpoint (ROADMAP 13.1, ADR 0013 Design A).
 *
 * Reads providers.yaml + routing.yaml, resolves `vision` with the same fail-closed discipline as
 * the other auxiliary tasks, and additionally requires the target provider to declare
 * `capabilities.vision: true`. The result feeds the session-home writer that puts an
 * `auxiliary.vision` block into the per-session Hermes config; Hermes' own vision_analyze tool
 * then makes the image call. Cindy never makes the vision call itself (Design A).
 *
 * - No vision rule -> not-routed: the session home gets no block and Hermes behaves as today.
 * - A rule that exists but is broken, or whose provider lacks vision -> blocked with a reason that
 *   names the route. Nothing is substituted, so a vision route can never silently become a call to
 *   a different (possibly paid) provider.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { loadProvidersFile } from './providers-file.js';
import { loadRoutingFile, resolveTaskRoute } from './routing-file.js';

export interface VisionRoute {
  /** providers.yaml id; also the name Hermes resolves in custom_providers. */
  provider: string;
  model: string;
  /** Normalised by the provider parser: no trailing slash. */
  baseUrl: string;
  /** Env var NAME holding the key; absent for keyless local endpoints. Never the key itself. */
  keyEnv?: string;
}

export type VisionRouteResolution =
  | { kind: 'not-routed' }
  | { kind: 'blocked'; message: string }
  | { kind: 'routed'; route: VisionRoute };

export interface VisionRouteDeps {
  /** Directory holding providers.yaml + routing.yaml. Default ~/.cindy-harness. */
  harnessDir?: string;
}

/** Resolve the vision route. Never throws; every outcome is a { kind } the caller decides on. */
export function resolveVisionRoute(deps: VisionRouteDeps = {}): VisionRouteResolution {
  const harnessDir = deps.harnessDir ?? path.join(os.homedir(), '.cindy-harness');
  const providersFile = loadProvidersFile(path.join(harnessDir, 'providers.yaml'));
  const routing = loadRoutingFile(
    path.join(harnessDir, 'routing.yaml'),
    providersFile.providers.map((p) => p.id),
  );

  const resolution = resolveTaskRoute(routing, 'vision');
  if (!resolution.ok) {
    const ruleIssues = routing.issues.filter((i) => i.where === 'rules.vision');
    if (ruleIssues.length > 0) {
      return { kind: 'blocked', message: ruleIssues.map((i) => i.message).join('; ') };
    }
    return { kind: 'not-routed' };
  }

  const entry = providersFile.providers.find((p) => p.id === resolution.target.provider);
  if (!entry) {
    return {
      kind: 'blocked',
      message: 'vision route "' + resolution.routeName + '" names unknown provider "' + resolution.target.provider + '"',
    };
  }
  if (!entry.capabilities.vision) {
    return {
      kind: 'blocked',
      message:
        'vision route "' + resolution.routeName + '" points at provider "' + entry.id +
        '", which does not declare capabilities.vision: true',
    };
  }
  return {
    kind: 'routed',
    route: {
      provider: entry.id,
      model: resolution.target.model,
      baseUrl: entry.baseUrl,
      ...(entry.keyEnv ? { keyEnv: entry.keyEnv } : {}),
    },
  };
}
