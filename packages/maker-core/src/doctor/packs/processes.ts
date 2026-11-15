/**
 * Processes doctor pack (`proc.*`, ROADMAP 14.4, blueprint §3 & §11).
 *
 * Inspects whether Cindy is running (`proc.app`), daemon Unix socket health
 * (`proc.daemon`), orphaned Hermes/MCP children (`proc.orphans`), key setup ports
 * (`proc.ports`), and MCP catalog executable health (`proc.mcp.<serverId>`).
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';

import { checkMcpHealth } from '../../mcp/mcp-catalog.js';
import { isDailyHermesPath } from '../context.js';
import { redactText } from '../redact.js';
import { formatSnapshotStamp } from '../snapshots.js';
import type {
  CheckRunOutput,
  DoctorCheck,
  DoctorContext,
  DoctorExecResult,
  DoctorFix,
  DoctorPack,
  FixOutcome,
  FixPlan,
} from '../types.js';
import { loadDoctorMcpCatalog } from './config.js';

const DAEMON_RPC_TIMEOUT_MS = 1_500;
const EXEC_TIMEOUT_MS = 2_000;

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

interface SetupPortSpec {
  port: number;
  label: string;
  expectedCommandPatterns: readonly RegExp[];
}

const SETUP_PORTS: readonly SetupPortSpec[] = [
  {
    port: 1234,
    label: 'LM Studio',
    expectedCommandPatterns: [/lm\s*studio/i, /^lm\s*stu/i, /\blms\b/i, /\blmstudio\b/i, /\bllmster\b/i, /^electron$/i],
  },
  {
    port: 11434,
    label: 'Ollama',
    expectedCommandPatterns: [/ollama/i],
  },
  {
    port: 9222,
    label: 'Dev CDP',
    expectedCommandPatterns: [/electron/i, /cindy/i, /chrome/i, /chromium/i, /^node$/i],
  },
];

function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const command = match[3]!.trim();
    if (Number.isFinite(pid) && Number.isFinite(ppid) && command.length > 0) {
      rows.push({ pid, ppid, command });
    }
  }
  return rows;
}

async function execWithBinFallback(
  ctx: DoctorContext,
  cmd: string,
  fallbackPath: string,
  args: string[],
): Promise<DoctorExecResult> {
  const first = await ctx.exec(cmd, args, { timeoutMs: EXEC_TIMEOUT_MS });
  if (
    first.code === null &&
    !first.stdout.trim() &&
    first.stderr.includes('ENOENT') &&
    fallbackPath !== cmd
  ) {
    return ctx.exec(fallbackPath, args, { timeoutMs: EXEC_TIMEOUT_MS });
  }
  return first;
}

function isCindyElectronCommand(command: string, ctx: DoctorContext): boolean {
  if (/cindy-doctor|vitest|esbuild|tsc\b/i.test(command)) return false;
  if (/Cindy\.app\/Contents\/MacOS/i.test(command)) return true;
  const normalizedUserData = path.resolve(ctx.paths.userDataDir);
  if (command.includes(normalizedUserData)) return true;
  if (/electron/i.test(command) && command.includes(path.resolve(ctx.paths.repoRoot))) return true;
  return false;
}

function resolveDaemonSocketPath(ctx: DoctorContext): string {
  return ctx.paths.socketPath ?? path.join(ctx.paths.userDataDir, 'hermes-mgr', 'hermes-mgr.sock');
}

interface DaemonProbeResult {
  connected: boolean;
  errorCode?: string;
  errorMessage?: string;
  serverVersion?: string;
  installedVersion?: string;
  pinnedVersion?: string;
}

function probeDaemonSocket(socketPath: string): Promise<DaemonProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: DaemonProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(res);
    };

    const socket = net.createConnection(socketPath);
    let socketConnected = false;
    const timer = setTimeout(() => {
      finish({
        connected: socketConnected,
        errorCode: 'ETIMEDOUT',
        errorMessage: `Timed out after ${DAEMON_RPC_TIMEOUT_MS} ms awaiting daemon RPC`,
      });
    }, DAEMON_RPC_TIMEOUT_MS);

    let buffer = '';
    let stage: 'hello' | 'status' = 'hello';
    let serverVersion: string | undefined;

    socket.on('connect', () => {
      socketConnected = true;
      socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 'doctor-hello',
          method: 'protocol/hello',
          params: { protocolVersion: 1 },
        })}\n`,
      );
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          finish({
            connected: true,
            errorMessage: 'Malformed JSON line received from daemon socket',
          });
          return;
        }

        if (msg.type !== 'response') continue;

        if (stage === 'hello' && msg.id === 'doctor-hello') {
          if (msg.ok !== true) {
            const errRec = msg.error as { message?: string } | undefined;
            finish({
              connected: true,
              errorMessage: `protocol/hello failed: ${errRec?.message ?? 'unknown error'}`,
            });
            return;
          }
          const result = (msg.result ?? {}) as Record<string, unknown>;
          serverVersion = typeof result.serverVersion === 'string' ? result.serverVersion : undefined;
          stage = 'status';
          socket.write(
            `${JSON.stringify({
              type: 'request',
              id: 'doctor-status',
              method: 'config/status',
              params: {},
            })}\n`,
          );
          return;
        }

        if (stage === 'status' && msg.id === 'doctor-status') {
          if (msg.ok !== true) {
            const errRec = msg.error as { message?: string } | undefined;
            finish({
              connected: true,
              serverVersion,
              errorMessage: `config/status failed: ${errRec?.message ?? 'unknown error'}`,
            });
            return;
          }
          const result = (msg.result ?? {}) as Record<string, unknown>;
          finish({
            connected: true,
            serverVersion,
            installedVersion:
              typeof result.installedVersion === 'string' ? result.installedVersion : undefined,
            pinnedVersion:
              typeof result.pinnedVersion === 'string' ? result.pinnedVersion : undefined,
          });
          return;
        }
      }
    });

    socket.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      finish({
        connected: false,
        errorCode: e.code,
        errorMessage: e.message,
      });
    });

    socket.on('close', () => {
      if (!settled) {
        finish({
          connected: false,
          errorMessage: 'Daemon socket closed before completing handshake',
        });
      }
    });
  });
}

export async function detectAppRunningState(ctx: DoctorContext): Promise<{
  running: boolean;
  pidCount: number;
  psAvailable: boolean;
}> {
  const psRes = await execWithBinFallback(ctx, 'ps', '/bin/ps', ['-eo', 'pid=,ppid=,command=']);
  const psAvailable = psRes.code === 0 && psRes.stdout.length > 0;
  const rows = psAvailable ? parsePsRows(psRes.stdout) : [];
  const matching = rows.filter((row) => isCindyElectronCommand(row.command, ctx));
  if (matching.length > 0) {
    return { running: true, pidCount: matching.length, psAvailable };
  }

  // Corroborate via daemon socket if ps matched nothing (or ps was unavailable).
  const sockPath = resolveDaemonSocketPath(ctx);
  try {
    await ctx.fs.stat(sockPath);
    const probe = await probeDaemonSocket(sockPath);
    if (probe.connected && !probe.errorMessage) {
      return { running: true, pidCount: 0, psAvailable };
    }
  } catch {
    /* socket absent */
  }

  return { running: false, pidCount: 0, psAvailable };
}

async function runProcApp(ctx: DoctorContext): Promise<CheckRunOutput> {
  const detected = await detectAppRunningState(ctx);
  const running = ctx.appRunning ?? detected.running;
  return {
    severity: 'ok',
    summary: running
      ? `Cindy desktop is running${detected.pidCount > 0 ? ` (${detected.pidCount} process(es))` : ''}`
      : detected.psAvailable
        ? 'Cindy desktop is closed'
        : 'Cindy desktop appears closed (process table unavailable)',
    evidence: {
      running,
      pidCount: detected.pidCount,
      psAvailable: detected.psAvailable,
    },
  };
}

async function runProcDaemon(ctx: DoctorContext): Promise<CheckRunOutput> {
  const socketPath = resolveDaemonSocketPath(ctx);
  let socketExists = false;
  try {
    await ctx.fs.stat(socketPath);
    socketExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        severity: 'fail',
        summary: `Could not stat daemon socket: ${err instanceof Error ? err.message : String(err)}`,
        detail: socketPath,
      };
    }
  }

  if (!socketExists) {
    const running =
      ctx.appRunning ?? (await detectAppRunningState(ctx)).running;
    if (!running) {
      return {
        severity: 'skip',
        summary: 'Skipped: app is closed and no daemon socket exists',
      };
    }
    return {
      severity: 'fail',
      summary: 'Cindy is running but hermes-mgr socket is missing',
      detail: `Expected socket: ${redactText(socketPath, { homeDir: ctx.paths.home })}`,
      action: 'Restart Cindy so the hermes-mgr daemon recreates its socket.',
    };
  }

  const probe = await probeDaemonSocket(socketPath);
  if (!probe.connected) {
    return {
      severity: 'fail',
      summary: `Stale hermes-mgr socket present (no listener: ${probe.errorCode ?? probe.errorMessage ?? 'unreachable'})`,
      detail: `Socket path: ${redactText(socketPath, { homeDir: ctx.paths.home })}`,
      action: 'Ensure Cindy is closed and remove the stale socket via fix.proc.stale-socket.',
      fixIds: ['fix.proc.stale-socket'],
      evidence: { stale: true },
    };
  }

  if (probe.errorMessage) {
    return {
      severity: 'fail',
      summary: `hermes-mgr handshake failed: ${probe.errorMessage}`,
      detail: `Socket path: ${redactText(socketPath, { homeDir: ctx.paths.home })}`,
      action: 'Restart Cindy to restart the hermes-mgr daemon cleanly.',
    };
  }

  const serverVer = probe.serverVersion ?? 'unknown';
  const hermesVer = probe.installedVersion ?? 'unknown';
  return {
    severity: 'ok',
    summary: `hermes-mgr daemon responsive (bundle ${serverVer}, Hermes ${hermesVer})`,
    evidence: {
      serverVersion: serverVer,
      installedVersion: hermesVer,
      pinnedVersion: probe.pinnedVersion ?? null,
    },
  };
}

function parseLsofCwdMap(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let currentPid: number | undefined;
  let currentFd: string | undefined;

  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const value = rawLine.slice(1);
    if (tag === 'p') {
      const parsed = Number.parseInt(value, 10);
      currentPid = Number.isFinite(parsed) ? parsed : undefined;
      currentFd = undefined;
    } else if (tag === 'f') {
      currentFd = value;
    } else if (tag === 'n' && currentPid !== undefined && currentFd === 'cwd') {
      cwds.set(currentPid, value);
    }
  }
  return cwds;
}

export interface OrphanProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  cwd: string;
}

const DEFAULT_ORPHAN_GRACE_MS = 3_000;
const DEFAULT_ORPHAN_POLL_MS = 100;

async function resolveSessionHomesPrefixes(ctx: DoctorContext): Promise<string[]> {
  const rawDir = path.resolve(path.join(ctx.paths.hermesHome, 'session-homes'));
  const dirs = new Set<string>([rawDir]);
  try {
    dirs.add(await fs.realpath(rawDir));
  } catch {
    try {
      const realHermes = await fs.realpath(ctx.paths.hermesHome);
      dirs.add(path.resolve(realHermes, 'session-homes'));
    } catch {
      // Directory may not exist yet
    }
  }
  return [...dirs];
}

function isUnderAnyRoot(candidatePath: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(candidatePath);
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

export type DetectOrphansResult =
  | { ok: true; orphans: OrphanProcessInfo[] }
  | { ok: false; kind: 'daily-hermes' | 'ps-error' | 'lsof-error'; error: string };

export async function detectOrphanProcesses(ctx: DoctorContext): Promise<DetectOrphansResult> {
  if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    return {
      ok: false,
      kind: 'daily-hermes',
      error: 'Refusing to inspect non-isolated daily Hermes home; ~/.hermes-cindy is required',
    };
  }

  const psRes = await execWithBinFallback(ctx, 'ps', '/bin/ps', ['-eo', 'pid=,ppid=,command=']);
  if (psRes.code !== 0) {
    return {
      ok: false,
      kind: 'ps-error',
      error: `Could not inspect process table (${psRes.stderr.trim() || `exit ${psRes.code}`})`,
    };
  }

  const selfPid = typeof process !== 'undefined' ? process.pid : -1;
  const selfPpid = typeof process !== 'undefined' ? process.ppid : -1;
  const rows = parsePsRows(psRes.stdout);
  const candidates = rows.filter(
    (row) =>
      row.ppid === 1 &&
      row.pid > 1 &&
      row.pid !== selfPid &&
      row.pid !== selfPpid &&
      !/^\/(?:System|usr\/libexec|usr\/sbin|sbin|Library\/Apple)\//.test(row.command) &&
      !/cindy-doctor|vitest/i.test(row.command),
  );

  if (candidates.length === 0) {
    return { ok: true, orphans: [] };
  }

  const lsofRes = await execWithBinFallback(ctx, 'lsof', '/usr/sbin/lsof', [
    '-a',
    '-d',
    'cwd',
    '-F',
    'pn',
    '-p',
    candidates.map((c) => String(c.pid)).join(','),
  ]);
  if (
    lsofRes.code !== 0 &&
    lsofRes.stdout.trim().length === 0 &&
    !(lsofRes.code === 1 && lsofRes.stderr.trim().length === 0)
  ) {
    return {
      ok: false,
      kind: 'lsof-error',
      error: `Could not inspect process working directories (${lsofRes.stderr.trim() || `exit ${lsofRes.code}`})`,
    };
  }

  const sessionHomesRoots = await resolveSessionHomesPrefixes(ctx);
  const cwds = parseLsofCwdMap(lsofRes.stdout);
  const orphans: OrphanProcessInfo[] = [];

  for (const row of candidates) {
    const cwd = cwds.get(row.pid);
    if (!cwd) continue;
    let matches = isUnderAnyRoot(cwd, sessionHomesRoots);
    if (!matches) {
      try {
        matches = isUnderAnyRoot(await fs.realpath(cwd), sessionHomesRoots);
      } catch {
        // Ignore inaccessible cwd realpath
      }
    }
    if (matches) {
      orphans.push({
        pid: row.pid,
        ppid: row.ppid,
        command: row.command,
        cwd,
      });
    }
  }

  return { ok: true, orphans };
}

async function runProcOrphans(ctx: DoctorContext): Promise<CheckRunOutput> {
  const detected = await detectOrphanProcesses(ctx);
  if (!detected.ok) {
    if (detected.kind === 'daily-hermes') {
      return {
        severity: 'fail',
        summary: detected.error,
        action: 'Point CINDY_HERMES_HOME to ~/.hermes-cindy.',
      };
    }
    return {
      severity: 'warn',
      summary: detected.error,
      ...(detected.kind === 'ps-error'
        ? { action: 'Run Cindy Doctor from a normal terminal shell to scan for orphaned processes.' }
        : {}),
    };
  }

  const { orphans } = detected;
  if (orphans.length === 0) {
    return {
      severity: 'ok',
      summary: 'No orphaned Hermes/MCP processes detected',
      evidence: { orphanCount: 0 },
    };
  }

  const pids = orphans.map((o) => o.pid);
  const redOpts = { homeDir: ctx.paths.home };
  const detailLines = orphans.map(
    (o) => `pid ${o.pid} (cwd: ${redactText(o.cwd, redOpts)}): ${redactText(o.command, redOpts)}`,
  );

  return {
    severity: 'warn',
    summary: `Found ${orphans.length} orphaned process(es) (pid ${pids.join(', ')})`,
    detail: detailLines.join('\n'),
    action: 'Terminate orphaned session-home processes via fix.proc.kill-orphans.',
    fixIds: ['fix.proc.kill-orphans'],
    evidence: { orphanCount: orphans.length, pids: pids.join(',') },
  };
}

interface PortListener {
  port: number;
  command: string;
  pid: number;
}

function parsePortListeners(stdout: string): PortListener[] {
  const listeners: PortListener[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('COMMAND ')) continue;
    // Example: python3 9911 turko 10u IPv4 0x123 0t0 TCP 127.0.0.1:1234 (LISTEN)
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const command = parts[0]!.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    const pid = Number.parseInt(parts[1]!, 10);
    const nameField = parts[parts.length - 1] === '(LISTEN)' ? parts[parts.length - 2]! : parts[parts.length - 1]!;
    const portMatch = /:(\d+)$/.exec(nameField);
    if (!portMatch || !Number.isFinite(pid)) continue;
    const port = Number.parseInt(portMatch[1]!, 10);
    listeners.push({ port, command, pid });
  }
  return listeners;
}

async function runProcPorts(ctx: DoctorContext): Promise<CheckRunOutput> {
  const portList = SETUP_PORTS.map((s) => String(s.port)).join(',');
  const lsofRes = await execWithBinFallback(ctx, 'lsof', '/usr/sbin/lsof', [
    '-nP',
    `-iTCP:${portList}`,
    '-sTCP:LISTEN',
  ]);

  // `lsof` returns exit code 1 with empty output when nothing listens on the queried ports.
  if (lsofRes.code !== 0 && !(lsofRes.code === 1 && lsofRes.stdout.trim() === '')) {
    return {
      severity: 'warn',
      summary: `Could not inspect listening ports (${lsofRes.stderr.trim() || `exit ${lsofRes.code}`})`,
    };
  }

  const specByPort = new Map(SETUP_PORTS.map((s) => [s.port, s]));
  const listeners = parsePortListeners(lsofRes.stdout);
  const unexpected: string[] = [];

  for (const listener of listeners) {
    const spec = specByPort.get(listener.port);
    if (!spec) continue;
    const allowed = spec.expectedCommandPatterns.some((re) => re.test(listener.command));
    if (!allowed) {
      unexpected.push(
        `port ${listener.port} (${spec.label}) is held by "${listener.command}" (pid ${listener.pid})`,
      );
    }
  }

  if (unexpected.length > 0) {
    return {
      severity: 'warn',
      summary: `${unexpected.length} setup port(s) held by unexpected process(es)`,
      detail: unexpected.join('\n'),
      action: 'Free the conflicting port or reconfigure the local endpoint port.',
      evidence: { unexpectedCount: unexpected.length },
    };
  }

  return {
    severity: 'ok',
    summary: `Setup ports (${portList}) clear or held by expected services`,
    evidence: { checkedPorts: SETUP_PORTS.length, activeListeners: listeners.length },
  };
}

function parseTargetPidFilter(target: string | undefined): Set<number> | null {
  if (!target || target.trim().length === 0) return null;
  const pids = new Set<number>();
  for (const part of target.split(',').map((s) => s.trim()).filter(Boolean)) {
    const num = Number.parseInt(part, 10);
    if (!Number.isInteger(num) || num <= 1 || String(num) !== part) {
      throw new Error(`Invalid PID target "${part}" for fix.proc.kill-orphans`);
    }
    pids.add(num);
  }
  return pids.size > 0 ? pids : null;
}

function isPidAlive(
  pid: number,
  sendSignal: (pid: number, signal: NodeJS.Signals | 0) => void,
): boolean {
  try {
    sendSignal(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

const fixProcKillOrphans: DoctorFix = {
  id: 'fix.proc.kill-orphans',
  title: 'Terminate orphaned session-home processes (SIGTERM -> SIGKILL)',
  risk: 'kills-process',
  needsAppClosed: false,
  recheck: ['proc.orphans'],

  async preview(ctx: DoctorContext, target?: string): Promise<FixPlan> {
    const pidFilter = parseTargetPidFilter(target);
    const detected = await detectOrphanProcesses(ctx);
    if (!detected.ok) {
      return {
        fixId: 'fix.proc.kill-orphans',
        ...(target ? { target } : {}),
        steps: [detected.error],
        touches: [],
        meta: { refusalReason: detected.error },
      };
    }

    const matching = pidFilter
      ? detected.orphans.filter((o) => pidFilter.has(o.pid))
      : detected.orphans;

    if (matching.length === 0) {
      return {
        fixId: 'fix.proc.kill-orphans',
        ...(target ? { target } : {}),
        steps: ['No orphaned processes rooted under ~/.hermes-cindy/session-homes/ found.'],
        touches: [],
        meta: { pids: [], candidates: [] },
      };
    }

    const redOpts = { homeDir: ctx.paths.home };
    return {
      fixId: 'fix.proc.kill-orphans',
      ...(target ? { target } : {}),
      steps: matching.map(
        (o) =>
          `Re-verify orphan pid ${o.pid} (${redactText(o.command, redOpts)}, cwd ${redactText(o.cwd, redOpts)}), send SIGTERM, wait up to 3 s, then SIGKILL if still running`,
      ),
      touches: matching.map((o) => `pid:${o.pid}`),
      meta: {
        pids: matching.map((o) => o.pid),
        candidates: matching.map((o) => ({
          pid: o.pid,
          command: redactText(o.command, redOpts),
        })),
      },
    };
  },

  async apply(ctx: DoctorContext, plan: FixPlan): Promise<FixOutcome> {
    const detected = await detectOrphanProcesses(ctx);
    if (!detected.ok) {
      return {
        ok: false,
        rolledBack: false,
        message: detected.error,
        recheck: [],
      };
    }

    const meta = (plan.meta ?? {}) as { pids?: unknown };
    const plannedPids = Array.isArray(meta.pids)
      ? new Set(meta.pids.filter((n): n is number => typeof n === 'number' && Number.isInteger(n)))
      : null;
    const targetFilter = parseTargetPidFilter(plan.target);

    const allowedPids = plannedPids ?? targetFilter;
    const verified = detected.orphans.filter((o) =>
      allowedPids ? allowedPids.has(o.pid) : true,
    );

    const skippedCount = allowedPids ? Math.max(0, allowedPids.size - verified.length) : 0;
    if (verified.length === 0) {
      return {
        ok: true,
        rolledBack: false,
        message:
          skippedCount > 0
            ? `0 process(es) terminated (${skippedCount} planned pid(s) no longer orphaned)`
            : 'No orphaned processes found to terminate',
        recheck: [],
      };
    }

    const sendSignal = ctx.sendSignal ?? ((pid: number, sig: NodeJS.Signals | 0) => process.kill(pid, sig));
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const graceMs = ctx.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;

    const termSent: number[] = [];
    const errors: string[] = [];

    for (const orphan of verified) {
      if (orphan.pid <= 1 || orphan.pid === process.pid || orphan.pid === process.ppid) continue;
      try {
        sendSignal(orphan.pid, 'SIGTERM');
        termSent.push(orphan.pid);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ESRCH') {
          errors.push(`SIGTERM pid ${orphan.pid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (termSent.length > 0 && graceMs > 0) {
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        const stillAlive = termSent.some((pid) => isPidAlive(pid, sendSignal));
        if (!stillAlive) break;
        const remaining = deadline - Date.now();
        await sleep(Math.max(1, Math.min(DEFAULT_ORPHAN_POLL_MS, remaining)));
      }
    }

    const sigkilled: number[] = [];
    for (const pid of termSent) {
      if (!isPidAlive(pid, sendSignal)) continue;
      try {
        sendSignal(pid, 'SIGKILL');
        sigkilled.push(pid);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ESRCH') {
          errors.push(`SIGKILL pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const parts = [`Terminated ${termSent.length} orphan(s) [${termSent.join(', ')}]`];
    if (sigkilled.length > 0) {
      parts.push(`escalated SIGKILL for [${sigkilled.join(', ')}]`);
    }
    if (skippedCount > 0) {
      parts.push(`skipped ${skippedCount} no longer orphaned`);
    }
    if (errors.length > 0) {
      parts.push(`errors: ${errors.join('; ')}`);
    }

    return {
      ok: errors.length === 0,
      rolledBack: false,
      message: parts.join('; '),
      recheck: [],
    };
  },
};

function resolveValidatedSocketTarget(ctx: DoctorContext, target?: string): string {
  const defaultSock = resolveDaemonSocketPath(ctx);
  if (!target || target.trim().length === 0) {
    return defaultSock;
  }
  const resolved = path.resolve(target.trim());
  const userDataRoot = path.resolve(ctx.paths.userDataDir);
  if (resolved === path.resolve(defaultSock)) {
    return resolved;
  }
  if (resolved.startsWith(`${userDataRoot}${path.sep}`) && resolved.endsWith('.sock')) {
    return resolved;
  }
  throw new Error(`Unsupported socket target outside user-data dir: ${target}`);
}

const fixProcStaleSocket: DoctorFix = {
  id: 'fix.proc.stale-socket',
  title: 'Move stale hermes-mgr daemon socket aside',
  risk: 'moves-files',
  needsAppClosed: true,
  recheck: ['proc.daemon'],

  async preview(ctx: DoctorContext, target?: string): Promise<FixPlan> {
    const socketPath = resolveValidatedSocketTarget(ctx, target);
    const redOpts = { homeDir: ctx.paths.home };
    const redactedPath = redactText(socketPath, redOpts);

    try {
      await ctx.fs.stat(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          fixId: 'fix.proc.stale-socket',
          ...(target ? { target } : {}),
          steps: [`No daemon socket exists at ${redactedPath}; nothing to move.`],
          touches: [],
          meta: { socketPath, absent: true },
        };
      }
      throw err;
    }

    const probe = await probeDaemonSocket(socketPath);
    if (probe.connected) {
      const refusalReason = `Daemon socket at ${redactedPath} is active and responsive; refusing to move live socket.`;
      return {
        fixId: 'fix.proc.stale-socket',
        ...(target ? { target } : {}),
        steps: [refusalReason],
        touches: [],
        meta: { socketPath, refusalReason },
      };
    }

    return {
      fixId: 'fix.proc.stale-socket',
      ...(target ? { target } : {}),
      steps: [
        `Re-verify ${redactedPath} is unreachable (no active daemon listener)`,
        `Move stale socket aside to ${redactedPath}.stale-<stamp>`,
      ],
      touches: [socketPath],
      requiresAppClosed: true,
      meta: { socketPath },
    };
  },

  async apply(ctx: DoctorContext, plan: FixPlan): Promise<FixOutcome> {
    const socketPath = resolveValidatedSocketTarget(ctx, plan.target);
    const redOpts = { homeDir: ctx.paths.home };
    const redactedPath = redactText(socketPath, redOpts);

    let st;
    try {
      st = await fs.lstat(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          ok: true,
          rolledBack: false,
          message: `Daemon socket ${redactedPath} is already absent.`,
          recheck: [],
        };
      }
      throw err;
    }

    if (st.isSymbolicLink()) {
      return {
        ok: false,
        rolledBack: false,
        message: `Refused to move symlink at socket path: ${redactedPath}`,
        recheck: [],
      };
    }

    const probe = await probeDaemonSocket(socketPath);
    if (probe.connected) {
      return {
        ok: false,
        rolledBack: false,
        message: `Refused: daemon socket at ${redactedPath} became active before apply.`,
        recheck: [],
      };
    }

    const asidePath = `${socketPath}.stale-${formatSnapshotStamp(ctx.now())}`;
    await fs.rename(socketPath, asidePath);
    if (plan.meta) {
      plan.meta.movedAsideSocketFrom = socketPath;
      plan.meta.movedAsideSocketTo = asidePath;
    }

    return {
      ok: true,
      rolledBack: false,
      message: `Moved stale daemon socket aside to ${redactText(asidePath, redOpts)}`,
      recheck: [],
    };
  },
};

export const processesPack: DoctorPack = {
  name: 'processes',
  fixes: [fixProcKillOrphans, fixProcStaleSocket],
  checks: [
    {
      id: 'proc.app',
      layer: 'processes',
      title: 'Cindy app running state',
      cost: 'fast',
      run: runProcApp,
    },
    {
      id: 'proc.daemon',
      layer: 'processes',
      title: 'Hermes daemon socket health',
      cost: 'fast',
      dependsOn: ['proc.app'],
      run: runProcDaemon,
    },
    {
      id: 'proc.orphans',
      layer: 'processes',
      title: 'Orphaned child processes',
      cost: 'fast',
      run: runProcOrphans,
    },
    {
      id: 'proc.ports',
      layer: 'processes',
      title: 'Local service port holders',
      cost: 'fast',
      run: runProcPorts,
    },
  ],
  async discoverChecks(ctx: DoctorContext): Promise<readonly DoctorCheck[]> {
    const { entries, configs } = await loadDoctorMcpCatalog(ctx);
    const nameCounts = new Map<string, number>();
    for (const entry of entries) {
      nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
    }

    return entries.map((entry): DoctorCheck => {
      const serverKey =
        (nameCounts.get(entry.name) ?? 0) > 1 ? `${entry.source}.${entry.name}` : entry.name;
      return {
        id: `proc.mcp.${serverKey}`,
        layer: 'processes',
        title: `MCP server (${entry.id})`,
        cost: 'fast',
        run: async (runCtx) => {
          const health = await checkMcpHealth(entry, {
            searchPath: runCtx.env?.PATH,
            configs,
          });
          if (health.status === 'disabled') {
            return { severity: 'ok', summary: `${entry.name} is disabled` };
          }
          if (health.status === 'ok') {
            return {
              severity: 'ok',
              summary: `${entry.name} (${entry.transport}) healthy`,
            };
          }
          if (health.status === 'unchecked') {
            return {
              severity: 'ok',
              summary: `${entry.name} (http) configured (not probed)`,
            };
          }
          return {
            severity: 'fail',
            summary: `${entry.name} (${health.status}): ${redactText(health.detail ?? 'unhealthy', { homeDir: runCtx.paths.home })}`,
            action: `Fix the "${entry.name}" command/URL in ~/.hermes-cindy/config.yaml.`,
            evidence: { serverId: entry.id, status: health.status },
          };
        },
      };
    });
  },
};
