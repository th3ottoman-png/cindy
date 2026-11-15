/**
 * ROADMAP 13.8 - approved models for helper agents (worker model allowlist).
 *
 * Cindy owns exactly one thing in ~/.cindy-harness/routing.yaml: the managed
 * `workers:` block between BEGIN/END markers. Hand-written routes, rules and
 * comments outside that block are never rewritten. A missing block is today's
 * behaviour; a broken block fails closed (choice disabled). No fallback route
 * is ever invented (AGENTS.md 6.3, blueprint 10).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadProvidersFile } from '@cindy/maker-core/providers-file';
import { loadRoutingFile } from '@cindy/maker-core/routing-file';
import {
  WORKERS_FAIL_CLOSED,
  applyWorkersBlock,
  parseWorkersBlock,
  type WorkersConfig,
} from '@cindy/model-providers/routing-file';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface WorkerRouteOption {
  name: string;
  provider: string;
  model: string;
  /** Loopback endpoint: free local model, as opposed to a billed API route. */
  local: boolean;
}

export interface WorkerAllowlistConfigView {
  /** False when there is no managed block: today's behaviour, any model is allowed. */
  present: boolean;
  allowModelChoice: boolean;
  allowedRoutes: string[];
  /** Listed parse errors. The owner sees these in Settings, never a silent fallback. */
  issues: string[];
  routes: WorkerRouteOption[];
}

export interface WorkerAllowlistPatch {
  /** False removes the managed block, restoring today's behaviour. */
  enabled: boolean;
  allowModelChoice?: boolean;
  allowedRoutes?: string[];
}

export interface WorkerAllowlistHostDeps {
  routingFile?: string;
  providersFile?: string;
}

export function defaultRoutingFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'routing.yaml');
}

export function defaultProvidersFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'providers.yaml');
}

/** Effective config for enforcement. Unreadable or unparseable YAML fails closed. */
export function readWorkerAllowlistConfig(
  file = defaultRoutingFile(),
  providersFile = defaultProvidersFile(),
): WorkersConfig | null {
  return readWorkerAllowlist(file, providersFile).config;
}

function readWorkerAllowlist(file: string, providersFile: string): {
  config: WorkersConfig | null;
  issues: string[];
  routes: WorkerRouteOption[];
} {
  const { providers } = loadProvidersFile(providersFile);
  const routing = loadRoutingFile(
    file,
    providers.map((provider) => provider.id),
  );
  const issues = routing.issues
    .filter((issue) => issue.where.startsWith('workers'))
    .map((issue) => `${issue.where}: ${issue.message}`);
  const fileUnreadable = routing.issues.some((issue) => issue.where === '(file)');
  const localById = new Map(providers.map((provider) => [provider.id, provider.local]));
  const routes: WorkerRouteOption[] = Object.entries(routing.routes).map(([name, target]) => ({
    name,
    provider: target.provider,
    model: target.model,
    local: localById.get(target.provider) ?? false,
  }));
  return {
    config: fileUnreadable ? WORKERS_FAIL_CLOSED : (routing.workers ?? null),
    issues: fileUnreadable
      ? [...issues, ...routing.issues.filter((issue) => issue.where === '(file)').map((issue) => issue.message)]
      : issues,
    routes,
  };
}

export function getWorkerAllowlistConfig(deps: WorkerAllowlistHostDeps = {}): WorkerAllowlistConfigView {
  const file = deps.routingFile ?? defaultRoutingFile();
  const providersFile = deps.providersFile ?? defaultProvidersFile();
  const { config, issues, routes } = readWorkerAllowlist(file, providersFile);
  return {
    present: config !== null,
    allowModelChoice: config?.allowModelChoice ?? true,
    allowedRoutes: config?.allowedRoutes ?? [],
    issues,
    routes,
  };
}

/**
 * Save the owner's choice. Only the managed block is rewritten; the rest of the
 * file survives byte for byte. Atomic: sibling temp file then rename.
 */
export function setWorkerAllowlistConfig(
  patch: WorkerAllowlistPatch,
  deps: WorkerAllowlistHostDeps = {},
): WorkerAllowlistConfigView {
  const file = deps.routingFile ?? defaultRoutingFile();
  const providersFile = deps.providersFile ?? defaultProvidersFile();
  if (!patch.enabled) {
    writeManagedBlock(file, null);
    return getWorkerAllowlistConfig(deps);
  }
  const requested = {
    allow_model_choice: patch.allowModelChoice ?? true,
    allowed_routes: patch.allowedRoutes ?? [],
  };
  const known = new Set(getWorkerAllowlistConfig(deps).routes.map((route) => route.name));
  const parsed = parseWorkersBlock({ workers: requested }, known);
  if (parsed.issues.length > 0 || !parsed.config) {
    // Refuse to write a broken allowlist; leave the owner's file untouched.
    const view = getWorkerAllowlistConfig(deps);
    return { ...view, issues: [...view.issues, ...parsed.issues.map((issue) => issue.message)] };
  }
  writeManagedBlock(file, parsed.config);
  return getWorkerAllowlistConfig(deps);
}

function writeManagedBlock(file: string, config: WorkersConfig | null): void {
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = applyWorkersBlock(existing, config);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function registerWorkerAllowlistHandlers(
  registry: IpcHandlerRegistry,
  deps: WorkerAllowlistHostDeps & { assertTrusted: (event: unknown) => void },
): void {
  registry.handle(MAKER_INVOKE.WORKERS_GET_CONFIG, (event: unknown) => {
    deps.assertTrusted(event);
    return getWorkerAllowlistConfig(deps);
  });
  registry.handle(MAKER_INVOKE.WORKERS_SET_CONFIG, (event: unknown, raw: unknown) => {
    deps.assertTrusted(event);
    const patch = (raw && typeof raw === 'object' ? raw : {}) as WorkerAllowlistPatch;
    return setWorkerAllowlistConfig(patch, deps);
  });
}
