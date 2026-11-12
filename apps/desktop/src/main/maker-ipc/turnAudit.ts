/**
 * Turn audit sessions (`~/.cindy-harness/turn-audit-sessions.json`, ROADMAP 11.10).
 *
 * While on, every Hermes turn asks the model for a `cindy-audit` footer (progress, decisions,
 * low-confidence assumptions; see `@cindy/maker-core/turn-audit`). The flag lives in its own
 * JSON map, like chat-only (10.3) and Plan First (11.7), because the agent reads it
 * synchronously while assembling each turn. The summary is folded from the stored messages, so
 * the "Audit & Assumptions" view is reproducible from the session itself.
 *
 * Local only: no network, no model call.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  aggregateSessionAudit,
  type SessionAudit,
  type SessionAuditMessage,
} from '@cindy/maker-core/turn-audit';

export interface TurnAuditView {
  sessionId: string;
  turnAudit: boolean;
}

export interface TurnAuditSummaryView extends TurnAuditView {
  audit: SessionAudit;
}

type Store = Record<string, true>;

export function defaultTurnAuditFile(home: string = os.homedir()): string {
  return path.join(home, '.cindy-harness', 'turn-audit-sessions.json');
}

function readStore(file: string): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Store = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === true && key.length > 0) out[key] = true;
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

export interface TurnAuditHostDeps {
  file?: string;
  home?: string;
  /** Stored messages of a session, oldest first. Absent → an empty summary. */
  listMessages?: (sessionId: string) => Promise<SessionAuditMessage[]>;
}

export class TurnAuditHost {
  private readonly file: string;
  private readonly listMessages?: TurnAuditHostDeps['listMessages'];

  constructor(deps: TurnAuditHostDeps = {}) {
    this.file = deps.file ?? defaultTurnAuditFile(deps.home);
    this.listMessages = deps.listMessages;
  }

  /** Synchronous by design: the agent reads it while assembling a turn. */
  isOn(sessionId: string): boolean {
    if (!sessionId) return false;
    return readStore(this.file)[sessionId] === true;
  }

  get(sessionId: string): TurnAuditView {
    return { sessionId, turnAudit: this.isOn(sessionId) };
  }

  set(sessionId: string, turnAudit: boolean): TurnAuditView {
    const store = readStore(this.file);
    if (turnAudit) store[sessionId] = true;
    else delete store[sessionId];
    writeStore(this.file, store);
    return { sessionId, turnAudit };
  }

  async summary(sessionId: string): Promise<TurnAuditSummaryView> {
    const messages = this.listMessages ? await this.listMessages(sessionId) : [];
    return { ...this.get(sessionId), audit: aggregateSessionAudit(messages ?? []) };
  }
}

let desktopHost: TurnAuditHost | null = null;

/** The app-wide host; the first caller with `listMessages` wires the summary source. */
export function getDesktopTurnAuditHost(deps?: TurnAuditHostDeps): TurnAuditHost {
  if (!desktopHost || deps?.listMessages) desktopHost = new TurnAuditHost(deps);
  return desktopHost;
}

// ── IPC ────────────────────────────────────────────────────────────────────────────────────────

interface HandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface TurnAuditHandlerDeps {
  host: TurnAuditHost;
  assertTrusted: (event: unknown) => void;
  channels: { GET: string; SET: string; SUMMARY: string };
}

function sessionIdOf(request: unknown): { sessionId: string; r: Record<string, unknown> } {
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  if (!sessionId) throw new Error('sessionId is required');
  return { sessionId, r };
}

export function registerTurnAuditHandlers(
  registry: HandlerRegistry,
  deps: TurnAuditHandlerDeps,
): void {
  registry.handle(deps.channels.GET, async (event, request) => {
    deps.assertTrusted(event);
    return deps.host.get(sessionIdOf(request).sessionId);
  });

  registry.handle(deps.channels.SET, async (event, request) => {
    deps.assertTrusted(event);
    const { sessionId, r } = sessionIdOf(request);
    if (typeof r.turnAudit !== 'boolean') throw new Error('turnAudit must be a boolean');
    // Nothing to tell the daemon: the agent re-reads this file on every turn.
    return deps.host.set(sessionId, r.turnAudit);
  });

  registry.handle(deps.channels.SUMMARY, async (event, request) => {
    deps.assertTrusted(event);
    return deps.host.summary(sessionIdOf(request).sessionId);
  });
}
