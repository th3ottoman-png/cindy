/**
 * HermesManager — wires the RPC method surface to the Hermes spawn layer and
 * the session registry. One Hermes child per turn; logical sessions persist
 * across daemon restarts via the registry file.
 *
 * Dispatch semantics (matching cc-mgr): query/send resolves when the turn is
 * *accepted and started*, not when it completes — completion arrives as
 * query/event `result` + session/closed. Notification targeting: the client
 * attached to the session if one exists, otherwise every initialized client.
 */

import { encodeMessage } from './codec.js';
import { readHermesDefaultRoute, writeHermesDefaultRoute } from './hermes-config.js';
import { fetchProviderModels, hermesHomeApiKey, parseHermesDotEnv } from './hermes-models.js';
import { readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { startHermesRun, type HermesRunHandle } from './hermes-run.js';
import {
  HERMES_MGR_BUNDLE_VERSION,
  METHODS,
  NOTIFICATIONS,
  type HermesQueryEventNotification,
  type HermesQueryStartParams,
  type HermesQuerySendParams,
  type SessionClosedNotification,
  type SessionListResult,
} from './protocol.js';
import { SessionRegistry } from './session-registry.js';
import { ManagerServer, type ClientCtx, type ManagerLogger } from './server.js';

export interface HermesManagerOptions {
  socketPath: string;
  /** Absolute HERMES_HOME this daemon drives. Guarded by bin/hermes-mgr.ts. */
  hermesHome: string;
  /** Hermes executable; defaults to `hermes` on PATH (wrapper preferred). */
  hermesBin?: string;
  /** Argv inserted between the binary and the `chat` subcommand (wrappers/fixtures). */
  hermesExtraArgs?: string[];
  registryFile?: string;
  logger?: ManagerLogger;
  /** Fallback stdin preamble (Cindy cockpit context) when a session has none. */
  defaultPreamble?: string;
}

interface RunningTurn {
  handle: HermesRunHandle;
  killed: boolean;
}

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class HermesManager {
  readonly server: ManagerServer;
  private readonly registry: SessionRegistry;
  private readonly running = new Map<string, RunningTurn>();
  /** Per-session provider credentials (query/start env). In-memory only — never persisted. */
  private readonly sessionEnv = new Map<string, Record<string, string>>();
  private readonly attached = new Map<string, ClientCtx>();
  readonly hermesHome: string;
  private readonly hermesBin: string;
  private readonly hermesExtraArgs?: string[];
  private readonly defaultPreamble?: string;

  constructor(opts: HermesManagerOptions) {
    this.hermesHome = opts.hermesHome;
    this.hermesBin = opts.hermesBin ?? 'hermes';
    this.hermesExtraArgs = opts.hermesExtraArgs;
    this.defaultPreamble = opts.defaultPreamble;
    this.registry = new SessionRegistry(opts.registryFile ?? null);
    this.server = new ManagerServer({
      socketPath: opts.socketPath,
      managerVersion: HERMES_MGR_BUNDLE_VERSION,
      logger: opts.logger,
    });
    this.wireHandlers();
    this.server.onClientClose((ctx) => {
      for (const [sessionId, attached] of this.attached) {
        if (attached === ctx) this.attached.delete(sessionId);
      }
    });
  }

  async start(): Promise<void> {
    await this.server.start();
  }

  async stop(): Promise<void> {
    const kills: Array<Promise<void>> = [];
    for (const [, turn] of this.running) {
      turn.killed = true;
      kills.push(turn.handle.kill());
    }
    await Promise.allSettled(kills);
    await this.server.stop();
  }

  private wireHandlers(): void {
    const s = this.server;
    // protocol/hello is handled by ManagerServer's builtin (version gate +
    // result), extended here only via managerVersion in the constructor.

    s.setHandler(METHODS.QUERY_START, async (raw) => {
      const p = raw as HermesQueryStartParams;
      if (typeof p?.sessionId !== 'string' || !p.sessionId) {
        throw rpcError('INVALID_PARAMS', 'sessionId is required');
      }
      if (typeof p?.cwd !== 'string' || !p.cwd) {
        throw rpcError('INVALID_PARAMS', 'cwd is required');
      }
      const created = this.registry.create({
        sessionId: p.sessionId,
        cwd: p.cwd,
        ...(p.resumeHermesSessionId ? { hermesSessionId: p.resumeHermesSessionId } : {}),
        ...(p.model ? { model: p.model } : {}),
        ...(p.provider ? { provider: p.provider } : {}),
        ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
        ...(p.systemPromptPreamble ? { preamble: p.systemPromptPreamble } : {}),
      });
      if (!created) {
        throw rpcError('SESSION_ALREADY_EXISTS', `session ${p.sessionId} already exists`);
      }
      // Provider credentials ride query/start env and stay in memory only
      // (the registry file on disk must never contain secrets). A daemon
      // restart drops them; the desktop re-sends start (with env) on demand.
      if (p.env && typeof p.env === 'object' && !Array.isArray(p.env)) {
        const entries = Object.entries(p.env).filter(
          ([key, value]) => typeof key === 'string' && key.length > 0 && typeof value === 'string',
        );
        if (entries.length > 0 && entries.length <= 32) {
          this.sessionEnv.set(p.sessionId, Object.fromEntries(entries));
        }
      }
      const rec = this.registry.get(p.sessionId)!;
      return {
        sessionId: p.sessionId,
        ...(rec.hermesSessionId ? { hermesSessionId: rec.hermesSessionId } : {}),
      };
    });

    s.setHandler(METHODS.QUERY_SEND, async (raw) => {
      const p = raw as HermesQuerySendParams;
      const rec = this.registry.get(p?.sessionId ?? '');
      if (!rec) {
        throw rpcError('SESSION_NOT_FOUND', 'query/start first');
      }
      if (typeof p.text !== 'string' || !p.text) {
        throw rpcError('INVALID_PARAMS', 'text is required');
      }
      if (p.images && p.images.length > 0) {
        throw rpcError(
          'INVALID_PARAMS',
          'images are reserved for a later milestone; v1 rejects them rather than dropping them',
        );
      }
      if (this.running.has(rec.sessionId)) {
        throw rpcError('TURN_ALREADY_RUNNING', 'a turn is already running; interrupt first');
      }

      // The preamble rides only the session's first turn.
      const preamble = rec.preamble ?? this.defaultPreamble;
      if (rec.preamble) this.registry.update(rec.sessionId, { preamble: undefined });

      // `hermes chat --safe-mode` (Cindy's default/ask permission mode) refuses
      // to read the profile default and requires an explicit route; the
      // bypassPermissions path (--yolo) does not. Supply the home's route when
      // the session has none, and fail with an actionable error when the home
      // has not configured one either.
      let routeModel = rec.model;
      let routeProvider = rec.provider;
      if (rec.permissionMode !== 'bypassPermissions' && (!routeModel || !routeProvider)) {
        const homeRoute = await readHermesDefaultRoute(this.hermesHome);
        routeModel = routeModel ?? homeRoute.model;
        routeProvider = routeProvider ?? homeRoute.provider;
        if (!routeModel) {
          throw rpcError(
            'INVALID_PARAMS',
            'Hermes default/ask permissions need an explicit model: set model.default in $HERMES_HOME/config.yaml (or switch the task to Full access)',
          );
        }
      }

      const run = startHermesRun(
        {
          hermesBin: this.hermesBin,
          hermesHome: this.hermesHome,
          cwd: rec.cwd,
          text: p.text,
          ...(preamble ? { preamble } : {}),
          ...(rec.hermesSessionId ? { resumeHermesSessionId: rec.hermesSessionId } : {}),
          ...(routeModel ? { model: routeModel } : {}),
          ...(routeProvider ? { provider: routeProvider } : {}),
          ...(rec.permissionMode ? { permissionMode: rec.permissionMode } : {}),
          ...(this.hermesExtraArgs ? { extraArgs: this.hermesExtraArgs } : {}),
          env: this.sessionEnv.get(rec.sessionId),
        },
        (event) => this.onHermesEvent(rec.sessionId, event),
      );
      const turn: RunningTurn = { handle: run, killed: false };
      this.running.set(rec.sessionId, turn);
      this.registry.update(rec.sessionId, { running: true });

      void run.result.then((res) => {
        this.running.delete(rec.sessionId);
        this.registry.update(rec.sessionId, { running: false });
        let reason: SessionClosedNotification['reason'];
        if (turn.killed) {
          reason = 'killed';
        } else if (res.spawnError || (res.code !== 0 && !res.sawResult)) {
          reason = 'error';
        } else {
          reason = 'completed';
        }
        this.emitClosed(rec.sessionId, reason, res.stderrTail || res.spawnError);
      });

      return {
        sessionId: rec.sessionId,
        ...(rec.hermesSessionId ? { hermesSessionId: rec.hermesSessionId } : {}),
      };
    });

    s.setHandler(METHODS.CONFIG_GET_DEFAULT_ROUTE, async () => {
      return { route: await readHermesDefaultRoute(this.hermesHome) };
    });

    s.setHandler(METHODS.CONFIG_LIST_MODELS, async (raw) => {
      const p = raw as { key?: string };
      const route = await readHermesDefaultRoute(this.hermesHome);
      if (!route.provider || !route.baseUrl) {
        return { route, models: [] };
      }
      // Key precedence: explicit request param (desktop env), then the home's
      // own .env — the same file the Hermes CLI loads for its turns.
      let apiKey = typeof p.key === 'string' ? p.key.trim() : '';
      if (!apiKey) {
        try {
          const dotenv = parseHermesDotEnv(
            await readFile(nodePath.join(this.hermesHome, '.env'), 'utf8'),
          );
          apiKey = hermesHomeApiKey(dotenv, route.provider);
        } catch {
          /* no .env — provider without a local key */
        }
      }
      if (!apiKey) return { route, models: [] };
      const list = await fetchProviderModels(route.baseUrl, apiKey);
      return { route, models: list.models, ...(list.error ? { error: list.error } : {}) };
    });

    s.setHandler(METHODS.CONFIG_SET_DEFAULT_ROUTE, async (raw) => {
      const p = raw as { model?: string; provider?: string; baseUrl?: string };
      const model = typeof p.model === 'string' ? p.model.trim() : '';
      const provider = typeof p.provider === 'string' ? p.provider.trim() : '';
      const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
      if (!model || !provider) {
        throw rpcError('INVALID_PARAMS', 'model and provider are required');
      }
      return {
        route: await writeHermesDefaultRoute(this.hermesHome, {
          model,
          provider,
          ...(baseUrl ? { baseUrl } : {}),
        }),
      };
    });

    s.setHandler(METHODS.QUERY_SET_MODEL, async (raw) => {
      const p = raw as { sessionId?: string; model?: string };
      this.requireRecord(p.sessionId);
      if (typeof p.model !== 'string') {
        throw rpcError('INVALID_PARAMS', 'model is required');
      }
      // Empty string = drop the per-session override: the next turn reads the
      // home default route again (config.yaml). Cindy's 'hermes-default'
      // sentinel arrives here as '' for exactly that reason.
      const model = p.model.trim();
      this.registry.update(p.sessionId!, { model: model || undefined });
      return {};
    });

    s.setHandler(METHODS.QUERY_SET_PERMISSION_MODE, async (raw) => {
      const p = raw as { sessionId?: string; mode?: string };
      this.requireRecord(p.sessionId);
      this.registry.update(p.sessionId!, { permissionMode: p.mode as never });
      return {};
    });

    s.setHandler(METHODS.QUERY_INTERRUPT, async (raw) => {
      const p = raw as { sessionId?: string };
      this.requireRecord(p.sessionId);
      const turn = this.running.get(p.sessionId!);
      if (turn) {
        turn.killed = true;
        await turn.handle.kill();
      }
      return {}; // idempotent when no turn is running
    });

    s.setHandler(METHODS.QUERY_CLOSE, async (raw) => {
      const p = raw as { sessionId?: string };
      this.requireRecord(p.sessionId);
      const turn = this.running.get(p.sessionId!);
      if (turn) {
        turn.killed = true;
        await turn.handle.kill();
      }
      this.registry.remove(p.sessionId!);
      this.attached.delete(p.sessionId!);
      this.emitClosed(p.sessionId!, 'closed');
      return {};
    });

    s.setHandler(METHODS.SESSION_ATTACH, async (raw, ctx) => {
      const p = raw as { sessionId?: string; sinceSeq?: number };
      const rec = this.requireRecord(p.sessionId);
      const previous = this.attached.get(p.sessionId!);
      if (previous && previous !== ctx && !previous.socket.destroyed) {
        previous.socket.write(
          encodeMessage({
            type: 'notification',
            method: NOTIFICATIONS.CLIENT_REPLACED,
            params: { sessionId: p.sessionId!, reason: 'another-client-attached' },
          }),
        );
      }
      this.attached.set(p.sessionId!, ctx);
      const replay = this.registry.replaySince(p.sessionId!, p.sinceSeq ?? 0);
      for (const { seq, event } of replay.events) {
        const notification: HermesQueryEventNotification = {
          sessionId: p.sessionId!,
          seq,
          ts: new Date().toISOString(),
          event,
        };
        if (!ctx.socket.destroyed) {
          ctx.socket.write(encodeMessage({
            type: 'notification',
            method: NOTIFICATIONS.QUERY_EVENT,
            params: notification,
          }));
        }
      }
      return {
        sessionId: p.sessionId!,
        currentSeq: replay.currentSeq,
        running: rec.running,
        replayLossy: replay.lossy,
      };
    });

    s.setHandler(METHODS.SESSION_LIST, async () => {
      const result: SessionListResult = { sessions: this.registry.list() };
      return result;
    });

    s.setHandler(METHODS.SESSION_KILL, async (raw) => {
      const p = raw as { sessionId?: string };
      this.requireRecord(p.sessionId);
      const turn = this.running.get(p.sessionId!);
      if (turn) {
        turn.killed = true;
        await turn.handle.kill();
      }
      this.registry.update(p.sessionId!, { running: false });
      return {};
    });
  }

  private requireRecord(sessionId?: string) {
    const rec = this.registry.get(sessionId ?? '');
    if (!rec) {
      throw rpcError('SESSION_NOT_FOUND', 'unknown session; query/start first');
    }
    return rec;
  }

  private onHermesEvent(sessionId: string, event: unknown): void {
    const evt = event as { type?: string; subtype?: string; session_id?: string } | null;
    if (evt && evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
      const rec = this.registry.get(sessionId);
      if (rec?.hermesSessionId !== evt.session_id) {
        this.registry.bindHermes(sessionId, evt.session_id);
        this.emitEvent(sessionId, {
          type: 'hermes-mgr',
          subtype: 'session-bound',
          hermesSessionId: evt.session_id,
        });
      }
    }
    this.emitEvent(sessionId, event);
  }

  private emitEvent(sessionId: string, event: unknown): void {
    const seq = this.registry.appendEvent(sessionId, event);
    if (seq === null) return;
    const notification: HermesQueryEventNotification = {
      sessionId,
      seq,
      ts: new Date().toISOString(),
      event,
    };
    this.deliver(NOTIFICATIONS.QUERY_EVENT, notification, sessionId);
  }

  private emitClosed(
    sessionId: string,
    reason: SessionClosedNotification['reason'],
    detail?: string,
  ): void {
    const notification: SessionClosedNotification = {
      sessionId,
      reason,
      ...(detail ? { detail } : {}),
    };
    this.deliver(NOTIFICATIONS.SESSION_CLOSED, notification, sessionId);
  }

  private deliver(method: string, params: unknown, sessionId: string): void {
    const attachedCtx = this.attached.get(sessionId);
    if (attachedCtx && !attachedCtx.socket.destroyed) {
      attachedCtx.socket.write(encodeMessage({ type: 'notification', method, params }));
      return;
    }
    this.server.broadcast(method, params);
  }
}
