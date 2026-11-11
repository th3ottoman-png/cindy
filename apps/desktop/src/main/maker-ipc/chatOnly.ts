/**
 * Chat-only sessions (`~/.cindy-harness/chat-only-sessions.json`, ROADMAP 10.3).
 *
 * "Conversation only": the Hermes turn runs with `--safe-mode` — no toolsets, no MCP servers, no
 * plugins, no user config — and the composer hides its tool affordances.
 *
 * Why a file of its own rather than a `sessions` column: the flag has to be readable
 * **synchronously** while a turn is being assembled (`resolveHermesChatOnly` builds the launch
 * request), and it must survive both an app restart and a daemon restart. A JSON map behind an
 * atomic write gives both without a schema migration; the daemon is told about it at start and on
 * every toggle, and it is the daemon that enforces it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ChatOnlyView {
  sessionId: string;
  chatOnly: boolean;
}

type Store = Record<string, true>;

export function defaultChatOnlyFile(home: string = os.homedir()): string {
  return path.join(home, '.cindy-harness', 'chat-only-sessions.json');
}

function readStore(file: string): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Store = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      // Only the sessions explicitly marked; anything else is a stale or hostile entry.
      if (value === true && typeof key === 'string' && key.length > 0) out[key] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(file: string, store: Store): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class ChatOnlyHost {
  private readonly file: string;

  constructor(deps: { file?: string; home?: string } = {}) {
    this.file = deps.file ?? defaultChatOnlyFile(deps.home);
  }

  /** Synchronous by design: the agent's launch hook cannot await while building the request. */
  isChatOnly(sessionId: string): boolean {
    if (!sessionId) return false;
    return readStore(this.file)[sessionId] === true;
  }

  get(sessionId: string): ChatOnlyView {
    return { sessionId, chatOnly: this.isChatOnly(sessionId) };
  }

  set(sessionId: string, chatOnly: boolean): ChatOnlyView {
    const store = readStore(this.file);
    if (chatOnly) store[sessionId] = true;
    else delete store[sessionId];
    writeStore(this.file, store);
    return { sessionId, chatOnly };
  }
}

export function getDesktopChatOnlyHost(deps?: { file?: string; home?: string }): ChatOnlyHost {
  return new ChatOnlyHost(deps);
}

// ── IPC ────────────────────────────────────────────────────────────────────────────────────────

export interface ChatOnlyHandlerDeps {
  host: ChatOnlyHost;
  assertTrusted: (event: unknown) => void;
  channels: { GET: string; SET: string };
  /** Pushes the flag to the daemon that builds the argv. Optional so tests can stay pure. */
  applyToDaemon?: (request: { sessionId: string; chatOnly: boolean; model?: string }) => Promise<void>;
}

interface HandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export function registerChatOnlyHandlers(registry: HandlerRegistry, deps: ChatOnlyHandlerDeps): void {
  registry.handle(deps.channels.GET, async (event, request) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
    if (!sessionId) throw new Error('sessionId is required');
    return deps.host.get(sessionId);
  });

  registry.handle(deps.channels.SET, async (event, request) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
    if (!sessionId) throw new Error('sessionId is required');
    if (typeof r.chatOnly !== 'boolean') throw new Error('chatOnly must be a boolean');
    const model = typeof r.model === 'string' && r.model ? r.model : undefined;
    // Daemon first: it owns the argv. A session that has not started a turn yet has no daemon
    // record, and that is fine — the launch hook reads this file and passes the flag on start.
    if (deps.applyToDaemon) {
      try {
        await deps.applyToDaemon({ sessionId, chatOnly: r.chatOnly, ...(model ? { model } : {}) });
      } catch {
        // Nothing to reconcile: the persisted flag is read on the next launch.
      }
    }
    return deps.host.set(sessionId, r.chatOnly);
  });
}
