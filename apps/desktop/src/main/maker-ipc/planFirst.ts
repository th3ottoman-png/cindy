/**
 * Plan First sessions (`~/.cindy-harness/plan-first-sessions.json`, ROADMAP 11.7).
 *
 * "Ask then build": while the lock is on, the model's turns are for architectural discovery
 * and its file-writing tools stay locked; the owner answers the rendered decision cards (or
 * Proceeds to Build), which decides the session and unlocks writes from the next turn on.
 *
 * Same shape as the chat-only host (ROADMAP 10.3): a JSON map behind atomic writes, readable
 * **synchronously** while a turn is being assembled (`resolveHermesPlanFirstLocked`), surviving
 * app and daemon restarts. The locked flag travels with every turn (QUERY_START/QUERY_SEND),
 * so no separate daemon RPC is needed — deciding flips the next turn's flag.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PlanFirstDecision {
  /** Decision id from the card block (kebab-case). */
  decisionId: string;
  /** Chosen option id. */
  optionId: string;
  /** Human summary, e.g. "Auth: JWT in header". Joined into the injected build message. */
  summary: string;
}

export interface PlanFirstView {
  sessionId: string;
  /** Chip state: the owner turned Plan First on for this session. */
  planFirst: boolean;
  /** Whether the owner has decided (answered cards or Proceeded to Build). */
  decided: boolean;
  /** The lock the daemon enforces: on and not yet decided. */
  locked: boolean;
  decisions: PlanFirstDecision[];
}

interface StoredEntry {
  decided?: boolean;
  decisions?: PlanFirstDecision[];
}

type Store = Record<string, StoredEntry>;

export function defaultPlanFirstFile(home: string = os.homedir()): string {
  return path.join(home, '.cindy-harness', 'plan-first-sessions.json');
}

function readStore(file: string): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Store = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof key !== 'string' || !key) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      const decisions = Array.isArray(v.decisions)
        ? (v.decisions as unknown[]).filter(
            (d): d is PlanFirstDecision =>
              !!d &&
              typeof d === 'object' &&
              typeof (d as PlanFirstDecision).decisionId === 'string' &&
              typeof (d as PlanFirstDecision).optionId === 'string',
          )
        : [];
      out[key] = {
        decided: v.decided === true,
        ...(decisions.length > 0
          ? {
              decisions: decisions.map((d) => ({
                decisionId: d.decisionId,
                optionId: d.optionId,
                summary: typeof d.summary === 'string' ? d.summary.slice(0, 300) : '',
              })),
            }
          : {}),
      };
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

export class PlanFirstHost {
  private readonly file: string;

  constructor(deps: { file?: string; home?: string } = {}) {
    this.file = deps.file ?? defaultPlanFirstFile(deps.home);
  }

  /** Synchronous by design: the agent's launch/send hook cannot await while building. */
  isLocked(sessionId: string): boolean {
    if (!sessionId) return false;
    const entry = readStore(this.file)[sessionId];
    return entry !== undefined && entry.decided !== true;
  }

  get(sessionId: string): PlanFirstView {
    const entry = sessionId ? readStore(this.file)[sessionId] : undefined;
    const planFirst = entry !== undefined;
    const decided = entry?.decided === true;
    return {
      sessionId,
      planFirst,
      decided,
      locked: planFirst && !decided,
      decisions: entry?.decisions ?? [],
    };
  }

  set(sessionId: string, planFirst: boolean): PlanFirstView {
    const store = readStore(this.file);
    if (planFirst) {
      // Turning on starts a fresh interrogation: previous decisions must not leak into it.
      store[sessionId] = { decided: false };
    } else {
      delete store[sessionId];
    }
    writeStore(this.file, store);
    return this.get(sessionId);
  }

  decide(sessionId: string, decisions: PlanFirstDecision[]): PlanFirstView {
    const clean = decisions
      .filter((d) => d && typeof d.decisionId === 'string' && d.decisionId && typeof d.optionId === 'string' && d.optionId)
      .slice(0  , 20)
      .map((d) => ({
        decisionId: d.decisionId.slice(0, 80),
        optionId: d.optionId.slice(0, 80),
        summary: typeof d.summary === 'string' ? d.summary.slice(0, 300) : '',
      }));
    const store = readStore(this.file);
    store[sessionId] = { decided: true, ...(clean.length > 0 ? { decisions: clean } : {}) };
    writeStore(this.file, store);
    return this.get(sessionId);
  }
}

export function getDesktopPlanFirstHost(deps?: { file?: string; home?: string }): PlanFirstHost {
  return new PlanFirstHost(deps);
}

// ── IPC ────────────────────────────────────────────────────────────────────────────────────────

export interface PlanFirstHandlerDeps {
  host: PlanFirstHost;
  assertTrusted: (event: unknown) => void;
  channels: { GET: string; SET: string; DECIDE: string };
}

interface HandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

function sessionIdOf(request: unknown): string {
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  if (!sessionId) throw new Error('sessionId is required');
  return sessionId;
}

export function registerPlanFirstHandlers(registry: HandlerRegistry, deps: PlanFirstHandlerDeps): void {
  registry.handle(deps.channels.GET, async (event, request) => {
    deps.assertTrusted(event);
    return deps.host.get(sessionIdOf(request));
  });

  registry.handle(deps.channels.SET, async (event, request) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const sessionId = sessionIdOf(request);
    if (typeof r.planFirst !== 'boolean') throw new Error('planFirst must be a boolean');
    return deps.host.set(sessionId, r.planFirst);
  });

  registry.handle(deps.channels.DECIDE, async (event, request) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const sessionId = sessionIdOf(request);
    const decisions = Array.isArray(r.decisions) ? (r.decisions as PlanFirstDecision[]) : [];
    return deps.host.decide(sessionId, decisions);
  });
}
