/**
 * hermesBridgeRuntimeFile — 0600 handoff file for the Hermes stdio shim.
 *
 * Hermes does not forward its environment to MCP children, and config.yaml must
 * stay secret-free, so the shim reads the loopback bridge port and the
 * per-session bearer token from this file. config.yaml carries only the
 * non-secret session id (`${CINDY_BRIDGE_SESSION}`). A bridge restart changes
 * `instanceId`, which drops every stale token.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface HermesBridgeRuntimeFile {
  version: 1;
  port: number;
  instanceId: string;
  /** Cindy session id → per-session bridge token. */
  sessions: Record<string, string>;
}

export interface HermesBridgeEndpoint {
  port: number;
  instanceId: string;
}

// Serialises read-modify-write per file: two Hermes sessions may start or close
// at the same moment.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(file: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(file) ?? Promise.resolve()).then(run, run);
  queues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

export async function readHermesBridgeRuntimeFile(
  file: string,
): Promise<HermesBridgeRuntimeFile | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<HermesBridgeRuntimeFile>;
    if (
      parsed.version !== 1 ||
      typeof parsed.port !== 'number' ||
      typeof parsed.instanceId !== 'string' ||
      !parsed.sessions ||
      typeof parsed.sessions !== 'object' ||
      Array.isArray(parsed.sessions)
    ) {
      return null;
    }
    return parsed as HermesBridgeRuntimeFile;
  } catch {
    // Missing, truncated, or unparsable: treated as no file (fail closed in the shim).
    return null;
  }
}

async function writeAtomic(file: string, data: HermesBridgeRuntimeFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export function upsertHermesBridgeSession(
  file: string,
  endpoint: HermesBridgeEndpoint,
  sessionId: string,
  token: string,
): Promise<void> {
  return serialized(file, async () => {
    const current = await readHermesBridgeRuntimeFile(file);
    // A different bridge instance invalidated every token the old file holds.
    const sessions = current && current.instanceId === endpoint.instanceId ? current.sessions : {};
    await writeAtomic(file, {
      version: 1,
      port: endpoint.port,
      instanceId: endpoint.instanceId,
      sessions: { ...sessions, [sessionId]: token },
    });
  });
}

/** Removes one session; deletes the file when it was the last. Idempotent. */
export function removeHermesBridgeSession(file: string, sessionId: string): Promise<void> {
  return serialized(file, async () => {
    const current = await readHermesBridgeRuntimeFile(file);
    if (!current || !(sessionId in current.sessions)) return;
    const { [sessionId]: _removed, ...rest } = current.sessions;
    if (Object.keys(rest).length === 0) {
      await unlink(file).catch(() => undefined);
      return;
    }
    await writeAtomic(file, { ...current, sessions: rest });
  });
}

/** Bridge shutdown: the file's port and tokens are dead, so remove it. */
export function clearHermesBridgeRuntimeFile(file: string): Promise<void> {
  return serialized(file, async () => {
    await unlink(file).catch(() => undefined);
  });
}
