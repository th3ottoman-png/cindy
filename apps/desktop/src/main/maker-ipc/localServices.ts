/**
 * Local dev-service IPC host (ROADMAP 11.6).
 *
 * Thin IPC adapter over `ServiceSupervisor`: validates renderer input at the
 * trust boundary (lengths, pid shape, cwd confinement to an existing
 * directory), then delegates. Production `execFn` shells out to `lsof`/`ps`
 * for read-only discovery; unit tests inject fakes through the supervisor.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import {
  getDesktopServiceSupervisor,
  ServiceSupervisor,
  type ServiceSpec,
  type SupervisorDeps,
} from '../local-services/serviceSupervisor.js';
import type { ExecFn } from '../local-services/devServerDiscovery.js';

function productionExec(): ExecFn {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

export function getProductionSupervisorDeps(onChanged: () => void): SupervisorDeps {
  return { execFn: productionExec(), onChanged };
}

function readString(r: Record<string, unknown>, key: string): string {
  return typeof r[key] === 'string' ? (r[key] as string) : '';
}

function readOptionalString(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readOptionalPort(r: Record<string, unknown>, key: string): number | undefined {
  const v = r[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? n : undefined;
}

function isValidCwd(cwd: string | undefined): boolean {
  if (cwd === undefined) return true;
  const trimmed = cwd.trim();
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0')) return false;
  try {
    return existsSync(trimmed) && statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}

export interface LocalServicesHandlerDeps {
  supervisor?: ServiceSupervisor;
  assertTrusted(event: unknown): void;
  broadcast?: (channel: string, payload?: unknown) => void;
}

export function registerLocalServicesHandlers(
  registry: IpcHandlerRegistry,
  deps: LocalServicesHandlerDeps,
): void {
  const supervisor = deps.supervisor ?? getDesktopServiceSupervisor();
  const changed = () => deps.broadcast?.(MAKER_PUSH.LOCAL_SERVICES_CHANGED, undefined);

  registry.handle(MAKER_INVOKE.LOCAL_SERVICES_LIST, async (event: unknown) => {
    deps.assertTrusted(event);
    return supervisor.list();
  });

  registry.handle(MAKER_INVOKE.LOCAL_SERVICES_START, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const spec: ServiceSpec = {
      name: readString(r, 'name').slice(0, 80),
      command: readString(r, 'command').slice(0, 2000),
      ...(readOptionalString(r, 'cwd') ? { cwd: readOptionalString(r, 'cwd') } : {}),
      ...(readOptionalPort(r, 'port') !== undefined ? { port: readOptionalPort(r, 'port') } : {}),
    };
    if (!isValidCwd(spec.cwd)) {
      return { ok: false, error: 'Working directory must be an existing directory.' };
    }
    const res = await supervisor.start(spec);
    changed();
    return res;
  });

  registry.handle(MAKER_INVOKE.LOCAL_SERVICES_STOP, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const id = readString(r, 'id').slice(0, 64);
    const res = await supervisor.stop(id.replace(/^svc:/, ''));
    changed();
    return res;
  });

  registry.handle(MAKER_INVOKE.LOCAL_SERVICES_RESTART, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const id = readString(r, 'id').slice(0, 64);
    const res = await supervisor.restart(id.replace(/^svc:/, ''));
    changed();
    return res;
  });

  registry.handle(MAKER_INVOKE.LOCAL_SERVICES_LOGS, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const id = readString(r, 'id').slice(0, 64);
    const rawLimit = typeof r.limit === 'number' ? r.limit : Number(r.limit);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 100;
    return supervisor.getLogs(id.replace(/^svc:/, ''), limit);
  });

  registry.handle(MAKER_INVOKE.LOCAL_SERVICES_TERMINATE, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const pid = typeof r.pid === 'number' ? r.pid : Number(r.pid);
    const command = readString(r, 'command').slice(0, 500);
    if (!command) return { ok: false, error: 'A matching command line is required to terminate.' };
    const res = await supervisor.terminateDiscovered(pid, command);
    changed();
    return res;
  });
}
