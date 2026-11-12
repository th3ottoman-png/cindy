/**
 * Dev-server discovery for ROADMAP 11.6 (Local Dev Service Supervisor).
 *
 * Read-only port/process scan: lists TCP listeners owned by known dev-server
 * commands (vite, next, node servers, python http.server, …), including servers
 * the owner or an agent started outside the supervisor (e.g. an agent bash
 * command in a Hermes turn). All OS access goes through the injected `exec`
 * so unit tests never touch real processes.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface DiscoveredServer {
  /** OS process id owning the listening socket. */
  pid: number;
  /** Full command line of the owning process (bounded). */
  command: string;
  /** Local TCP ports the process is listening on. */
  ports: number[];
}

/**
 * Command signatures treated as local dev servers. Matched against the full
 * command line, case-insensitively. Kept narrow on purpose: only commands
 * whose primary job is serving local traffic, so the panel never suggests
 * terminating an unrelated process.
 */
const DEV_SERVER_PATTERNS: RegExp[] = [
  /\bvite(\.mjs|\.js)?\b/,
  /\bnext(-server)?\b.*\bstart\b|\bnext\b.*\bdev\b/,
  /\bnuxt\b/,
  /\bastro\b.*\bdev\b/,
  /\bremix\b.*\bdev\b/,
  /\bnode\b.*\b(serve|server|index|app|main|dev)\b/,
  /\b(node|deno|bun)\b/,
  /\bpython\d?\b.*\bhttp\.server\b/,
  /\buvicorn\b/,
  /\bflask\b.*\brun\b/,
  /\b(django-admin|manage\.py)\b.*\brunserver\b/,
  /\brails\b.*\b(server|s)\b/,
  /\bpuma\b/,
  /\bphp\b.*(?:\s|^)-S\b/,
];

export function isDevServerCommand(command: string): boolean {
  return DEV_SERVER_PATTERNS.some((re) => re.test(command));
}

/**
 * Parse `lsof -iTCP -sTCP:LISTEN -P -n` output. Returns pid → ports.
 * Unparseable lines are skipped; never throws.
 */
export function parseLsofListening(output: string): Map<number, number[]> {
  const byPid = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('COMMAND')) continue;
    // Columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME…
    // NAME itself contains spaces ("TCP 127.0.0.1:5173 (LISTEN)"), so the
    // port is extracted from the whole line, not the last token.
    const head = trimmed.split(/\s+/);
    if (head.length < 3) continue;
    const pid = Number(head[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const portMatches = [...trimmed.matchAll(/:(\d+)(?=\D|$)/g)];
    if (portMatches.length === 0) continue;
    const port = Number(portMatches[portMatches.length - 1][1]);
    if (port < 1 || port > 65535) continue;
    const existing = byPid.get(pid);
    if (existing) {
      if (!existing.includes(port)) existing.push(port);
    } else {
      byPid.set(pid, [port]);
    }
  }
  return byPid;
}

/**
 * Parse `ps -e -o pid=,command=` output into pid → command. Never throws.
 */
export function parsePsCommands(output: string): Map<number, string> {
  const byPid = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(pid, match[2].slice(0, 500));
  }
  return byPid;
}

/**
 * Discover dev-server processes currently holding listening TCP sockets.
 * Returns [] when the platform has no `lsof`/`ps` (e.g. Windows) or when
 * either probe fails — discovery is informational and must fail open.
 */
export async function discoverDevServers(exec: ExecFn): Promise<DiscoveredServer[]> {
  let lsofOut: string;
  let psOut: string;
  try {
    [{ stdout: lsofOut }, { stdout: psOut }] = await Promise.all([
      exec('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']),
      exec('ps', ['-e', '-o', 'pid=,command=']),
    ]);
  } catch {
    return [];
  }
  const listeners = parseLsofListening(lsofOut);
  if (listeners.size === 0) return [];
  const commands = parsePsCommands(psOut);
  const found: DiscoveredServer[] = [];
  for (const [pid, ports] of listeners) {
    const command = commands.get(pid);
    if (!command || !isDevServerCommand(command)) continue;
    found.push({ pid, command, ports: [...ports].sort((a, b) => a - b) });
  }
  return found.sort((a, b) => a.pid - b.pid);
}
