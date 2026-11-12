/**
 * Local dev-service supervisor for ROADMAP 11.6.
 *
 * Owns dev-server child processes started through the supervisor (spawn,
 * log capture, graceful SIGTERM → SIGKILL escalation, restart, collision
 * guard) and merges them with read-only discovery of dev servers the owner
 * or an agent started elsewhere (see devServerDiscovery.ts).
 *
 * All OS access (spawn/kill/exec) is injected through `SupervisorDeps` so
 * unit tests run with fakes and never touch real processes.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import {
  discoverDevServers,
  parseLsofListening,
  type DiscoveredServer,
  type ExecFn,
} from './devServerDiscovery.js';

export interface ServiceSpec {
  /** Display name, 1–80 chars. */
  name: string;
  /** Shell command, e.g. `npx vite --port 5173`. 1–2000 chars. */
  command: string;
  /** Working directory for the child. */
  cwd?: string;
  /** Expected local port; starting fails closed when it is already taken. */
  port?: number;
}

export type SupervisedStatus = 'running' | 'stopping' | 'stopped';

export interface SupervisedRecord {
  id: string;
  spec: ServiceSpec;
  status: SupervisedStatus;
  pid?: number;
  startedAtMs?: number;
  stoppedAtMs?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  error?: string;
  /** Bounded stdout+stderr tail (oldest first). */
  log: string[];
  /** Last observed listening ports for this pid. */
  ports: number[];
}

export interface ServiceView {
  /** `svc:<id>` for supervised, `ext:<pid>` for discovered. */
  id: string;
  name: string;
  command: string;
  pid?: number;
  ports: number[];
  running: boolean;
  /** Milliseconds since start; absent for discovered/never-started. */
  uptimeMs?: number;
  source: 'supervised' | 'discovered';
  /** Whether the panel may offer Stop/Restart for this entry. */
  manageable: boolean;
  stopped?: boolean;
  exitCode?: number | null;
}

export interface StartResult {
  ok: boolean;
  id?: string;
  pid?: number;
  error?: string;
}

export interface StopResult {
  ok: boolean;
  /** True when SIGKILL escalation was required. */
  forced?: boolean;
  error?: string;
}

export interface ChildHandle {
  pid?: number;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  onData(cb: (chunk: string) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface SupervisorDeps {
  spawnFn?: (command: string, cwd?: string) => ChildHandle;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
  isAliveFn?: (pid: number) => boolean;
  execFn?: ExecFn;
  now?: () => number;
  /** SIGTERM → SIGKILL escalation delay. Default 3000. */
  graceMs?: number;
  /** Minimum interval between discovery scans. Default 5000. */
  discoveryCacheMs?: number;
  onChanged?: () => void;
}

const LOG_LINE_CAP = 200;
const MAX_COMMAND_LEN = 2000;
const MAX_NAME_LEN = 80;

function defaultSpawn(command: string, cwd?: string): ChildHandle {
  const child: ChildProcess = nodeSpawn(command, {
    shell: true,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const dataCbs: Array<(chunk: string) => void> = [];
  child.stdout?.on('data', (b: Buffer) => {
    for (const cb of dataCbs) cb(b.toString('utf8'));
  });
  child.stderr?.on('data', (b: Buffer) => {
    for (const cb of dataCbs) cb(b.toString('utf8'));
  });
  return {
    pid: child.pid,
    on: (event, cb) => {
      if (event === 'exit') child.on('exit', (code, signal) => cb(code, signal));
    },
    onData: (cb) => {
      dataCbs.push(cb);
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export class ServiceSupervisor {
  private readonly spawnFn: (command: string, cwd?: string) => ChildHandle;
  private readonly killFn: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isAliveFn: (pid: number) => boolean;
  private readonly execFn?: ExecFn;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly discoveryCacheMs: number;
  private readonly onChanged?: () => void;

  private readonly services = new Map<string, { record: SupervisedRecord; child?: ChildHandle }>();
  private counter = 0;
  private discoveryCache: { atMs: number; servers: DiscoveredServer[] } | undefined;

  constructor(deps: SupervisorDeps = {}) {
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.killFn = deps.killFn ?? defaultKill;
    this.isAliveFn = deps.isAliveFn ?? defaultIsAlive;
    this.execFn = deps.execFn;
    this.now = deps.now ?? (() => Date.now());
    this.graceMs = deps.graceMs ?? 3000;
    this.discoveryCacheMs = deps.discoveryCacheMs ?? 5000;
    this.onChanged = deps.onChanged;
  }

  private emitChanged(): void {
    try {
      this.onChanged?.();
    } catch {
      // Broadcast must never break supervision.
    }
  }

  private validateSpec(spec: ServiceSpec): string | undefined {
    const name = spec.name?.trim() ?? '';
    if (name.length === 0 || name.length > MAX_NAME_LEN) return 'Service name must be 1–80 characters.';
    const command = spec.command?.trim() ?? '';
    if (command.length === 0 || command.length > MAX_COMMAND_LEN) {
      return 'Command must be 1–2000 characters.';
    }
    if (spec.cwd !== undefined && spec.cwd.trim().length === 0) return 'Working directory must not be blank.';
    if (spec.port !== undefined && (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535)) {
      return 'Port must be an integer between 1 and 65535.';
    }
    return undefined;
  }

  private async portInUse(port: number): Promise<boolean> {
    if (!this.execFn) return false;
    try {
      const { stdout } = await this.execFn('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']);
      for (const ports of parseLsofListening(stdout).values()) {
        if (ports.includes(port)) return true;
      }
      return false;
    } catch {
      // When the probe itself fails we cannot prove the port is free, but
      // refusing every start would brick the feature — fail open here and let
      // the child report its own bind error into the log tail.
      return false;
    }
  }

  private pushLog(record: SupervisedRecord, chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.replace(/\s+$/, '');
      if (!trimmed) continue;
      record.log.push(trimmed.slice(0, 2000));
    }
    if (record.log.length > LOG_LINE_CAP) {
      record.log.splice(0, record.log.length - LOG_LINE_CAP);
    }
  }

  async start(spec: ServiceSpec): Promise<StartResult> {
    const invalid = this.validateSpec(spec);
    if (invalid) return { ok: false, error: invalid };
    const clean: ServiceSpec = {
      name: spec.name.trim(),
      command: spec.command.trim(),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.port !== undefined ? { port: spec.port } : {}),
    };
    // Collision guard: never spawn a second server onto a taken port —
    // that is exactly the orphan-on-rerun failure this row exists to prevent.
    if (clean.port !== undefined && (await this.portInUse(clean.port))) {
      return { ok: false, error: `Port ${clean.port} is already in use. Stop the service holding it first.` };
    }
    const id = `svc-${++this.counter}`;
    const record: SupervisedRecord = {
      id,
      spec: clean,
      status: 'running',
      startedAtMs: this.now(),
      log: [],
      ports: [],
    };
    let child: ChildHandle | undefined;
    try {
      child = this.spawnFn(clean.command, clean.cwd);
    } catch (err) {
      record.status = 'stopped';
      record.stoppedAtMs = this.now();
      record.error = err instanceof Error ? err.message : String(err);
      this.services.set(id, { record });
      this.emitChanged();
      return { ok: false, id, error: record.error };
    }
    if (!child) {
      record.status = 'stopped';
      record.stoppedAtMs = this.now();
      record.error = 'Process spawn returned no handle.';
      this.services.set(id, { record });
      this.emitChanged();
      return { ok: false, id, error: record.error };
    }
    record.pid = child.pid;
    child.onData((chunk) => this.pushLog(record, chunk));
    child.on('exit', (code, signal) => {
      record.status = 'stopped';
      record.stoppedAtMs = this.now();
      record.exitCode = code;
      record.exitSignal = signal;
      this.emitChanged();
    });
    if (record.pid === undefined) {
      record.status = 'stopped';
      record.stoppedAtMs = this.now();
      record.error = 'Process exited before a pid was assigned.';
      this.services.set(id, { record });
      this.emitChanged();
      return { ok: false, id, error: record.error };
    }
    this.services.set(id, { record, child });
    if (clean.port !== undefined) record.ports = [clean.port];
    this.emitChanged();
    return { ok: true, id, pid: record.pid };
  }

  async stop(id: string): Promise<StopResult> {
    const entry = this.services.get(id);
    if (!entry) return { ok: false, error: `Unknown service: ${id}` };
    const { record, child } = entry;
    if (record.status === 'stopped' || !child || record.pid === undefined) {
      record.status = 'stopped';
      return { ok: true };
    }
    record.status = 'stopping';
    this.emitChanged();
    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      if (!this.isAliveFn(record.pid as number)) resolve();
    });
    try {
      this.killFn(record.pid, 'SIGTERM');
    } catch {
      // Already gone — the exit handler settles the record.
    }
    let forced = false;
    const finished = await Promise.race([exited.then(() => true), sleep(this.graceMs).then(() => false)]);
    if (!finished && this.isAliveFn(record.pid)) {
      forced = true;
      try {
        this.killFn(record.pid, 'SIGKILL');
      } catch {
        // Best effort; the exit handler settles the record.
      }
      await Promise.race([exited, sleep(this.graceMs)]);
    }
    if ((entry.record.status as SupervisedStatus) !== 'stopped') {
      entry.record.status = 'stopped';
      entry.record.stoppedAtMs = this.now();
      this.emitChanged();
    }
    return { ok: true, forced };
  }

  async restart(id: string): Promise<StartResult> {
    const entry = this.services.get(id);
    if (!entry) return { ok: false, error: `Unknown service: ${id}` };
    const spec = entry.record.spec;
    // Re-check the port: the old child may still be releasing it.
    await this.stop(id);
    if (spec.port !== undefined && (await this.portInUse(spec.port))) {
      // Keep the old record; surface the collision instead of spawning an
      // orphan that immediately crashes on bind.
      return { ok: false, id, error: `Port ${spec.port} is still in use after stopping. Retry in a moment.` };
    }
    this.services.delete(id);
    const next = await this.start(spec);
    return next;
  }

  /**
   * Terminate a discovered (externally started) dev server. Re-validates that
   * the pid still belongs to the recorded command before signalling, so a
   * recycled pid can never cause us to kill an unrelated process.
   */
  async terminateDiscovered(pid: number, command: string): Promise<StopResult> {
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'Invalid pid.' };
    const servers = await this.scanDiscovery(true);
    const match = servers.find((s) => s.pid === pid);
    if (!match || match.command !== command) {
      return {
        ok: false,
        error: 'That process is no longer a matching dev server (pid reused or already exited). Refusing to signal.',
      };
    }
    try {
      this.killFn(pid, 'SIGTERM');
    } catch {
      return { ok: true };
    }
    await sleep(this.graceMs);
    let forced = false;
    if (this.isAliveFn(pid)) {
      forced = true;
      try {
        this.killFn(pid, 'SIGKILL');
      } catch {
        // Best effort.
      }
    }
    this.discoveryCache = undefined;
    this.emitChanged();
    return { ok: true, forced };
  }

  getLogs(id: string, limit = 100): { ok: boolean; lines?: string[]; error?: string } {
    const entry = this.services.get(id);
    if (!entry) return { ok: false, error: `Unknown service: ${id}` };
    const n = Math.max(1, Math.min(limit, LOG_LINE_CAP));
    return { ok: true, lines: entry.record.log.slice(-n) };
  }

  private async scanDiscovery(force = false): Promise<DiscoveredServer[]> {
    if (!this.execFn) return [];
    const nowMs = this.now();
    if (!force && this.discoveryCache && nowMs - this.discoveryCache.atMs < this.discoveryCacheMs) {
      return this.discoveryCache.servers;
    }
    const servers = await discoverDevServers(this.execFn);
    this.discoveryCache = { atMs: nowMs, servers };
    return servers;
  }

  async list(): Promise<{ services: ServiceView[] }> {
    const nowMs = this.now();
    const supervisedPids = new Set<number>();
    const views: ServiceView[] = [];
    for (const { record } of this.services.values()) {
      if (record.pid !== undefined) supervisedPids.add(record.pid);
      views.push({
        id: `svc:${record.id}`,
        name: record.spec.name,
        command: record.spec.command,
        pid: record.pid,
        ports: [...record.ports],
        running: record.status === 'running',
        ...(record.startedAtMs !== undefined ? { uptimeMs: Math.max(0, nowMs - record.startedAtMs) } : {}),
        source: 'supervised',
        manageable: record.status === 'running',
        stopped: record.status === 'stopped',
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      });
    }
    for (const s of await this.scanDiscovery()) {
      if (supervisedPids.has(s.pid)) continue;
      views.push({
        id: `ext:${s.pid}`,
        name: `External dev server (:${s.ports.join(', :')})`,
        command: s.command,
        pid: s.pid,
        ports: [...s.ports],
        running: true,
        source: 'discovered',
        manageable: true,
      });
    }
    views.sort((a, b) => Number(b.running) - Number(a.running) || (a.pid ?? 0) - (b.pid ?? 0));
    return { services: views };
  }

  /** Best-effort graceful shutdown of every supervised child (app quit path). */
  async shutdownAll(): Promise<void> {
    for (const id of [...this.services.keys()]) {
      try {
        await this.stop(id);
      } catch {
        // Never block app quit on a misbehaving child.
      }
    }
  }
}

let desktopSupervisor: ServiceSupervisor | undefined;

export function getDesktopServiceSupervisor(deps?: SupervisorDeps): ServiceSupervisor {
  if (!desktopSupervisor) {
    desktopSupervisor = new ServiceSupervisor(deps);
  }
  return desktopSupervisor;
}

export function __resetDesktopServiceSupervisorForTests(): void {
  desktopSupervisor = undefined;
}
