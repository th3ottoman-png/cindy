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
import {
  readHermesDefaultRoute,
  writeHermesDefaultRoute,
  readHermesMcpServers,
  writeHermesMcpServer,
  removeHermesMcpServer,
  writeHermesLocalContextWindows,
} from './hermes-config.js';
import { fetchProviderModels, hermesHomeApiKey, parseHermesDotEnv } from './hermes-models.js';
import {
  HERMES_CLI_PINNED_VERSION,
  readInstalledHermesVersion,
} from './hermes-version.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isValidHermesPluginName, setHermesPluginEnabled } from './hermes-plugins.js';
import { readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import {
  isInvalidResumeFailure,
  permissionModeToFlags,
  startHermesRun,
  type HermesRunHandle,
} from './hermes-run.js';
import { createCompressionWatcher, readTurnContextUsage, type CompressionWatcher } from './hermes-context.js';
import {
  HERMES_MGR_BUNDLE_VERSION,
  METHODS,
  NOTIFICATIONS,
  SERVER_METHODS,
  type ApprovalRequestParams,
  type ApprovalRequestResult,
  type ConfigSetLocalContextWindowsParams,
  type HermesLocalContextWindowEntry,
  type HermesQueryEventNotification,
  type HermesQueryStartParams,
  type HermesQuerySendParams,
  type HermesQuerySetModelParams,
  type SessionClosedNotification,
  type SessionListResult,
} from './protocol.js';
import { SessionRegistry } from './session-registry.js';
import {
  prepareSessionHome,
  reapOrphanGateways,
  reapOrphanHomes,
  removeSessionHome,
  sessionHomePath,
  stopSessionGateway,
  type SessionHomeOptions,
} from './session-home.js';
import { ManagerServer, type ClientCtx, type ManagerLogger } from './server.js';
import {
  AUTO_REVIEW_CLIENT_TIMEOUT_MS,
  AutoReviewGate,
  buildAutoReviewHookCommand,
  AUTO_REVIEW_CREDENTIALS_FILE,
  AUTO_REVIEW_SOCKET_ENV,
  buildSessionHookCommand,
  injectAutoReviewHook,
  writeHookCredentials,
  normalizeVerdict,
  type AutoReviewVerdict,
} from './auto-review-gate.js';

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
  /**
   * Opt-in (ADR 0004): run each Cindy session in its own HERMES_HOME (and therefore its own
   * gateway) so the session env reaches MCP children. Omit to keep one shared home.
   */
  sessionHomes?: SessionHomeOptions;
  /**
   * ROADMAP 1.13b: argv Hermes runs as the `pre_tool_call` hook of an `auto`
   * session (production: `node <hermes-mgr.mjs> --auto-review-hook`). Omit to
   * refuse `auto` turns. Needs `sessionHomes` (the hook goes into the session's
   * own config.yaml, never the shared one).
   */
  autoReviewHookArgv?: string[];
  /** Socket the hook calls; defaults to `hermes-review.sock` next to `socketPath`. */
  autoReviewSocketPath?: string;
}

interface RunningTurn {
  handle: HermesRunHandle;
  killed: boolean;
  /** Follows the turn home's agent.log for Hermes's own mid-turn compression (ADR 0010). */
  compression?: CompressionWatcher;
}

/** Hermes logs nothing on stream-json while it summarizes (20–40 s live), so poll the log. */
const COMPRESSION_POLL_MS = 1_000;

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Upper bound for a session's `--max-turns`; Hermes' own home default is 150. */
const MAX_TURNS_LIMIT = 1000;

function isValidMaxTurns(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TURNS_LIMIT;
}

/** Plain built-in toolset names only: Hermes refuses tool-level `-t` values (0.22.5). */
const TOOLSET_NAME = /^[a-z][a-z0-9_]*$/;

function isValidToolsets(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((name) => typeof name === 'string' && TOOLSET_NAME.test(name)) &&
    new Set(value).size === value.length;
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
  private readonly logger?: ManagerLogger;
  private readonly sessionHomes?: SessionHomeOptions;
  /** In-flight home preparations deduplicated by sessionId to prevent concurrent prewarm/send races. */
  private readonly inFlightHomePrepares = new Map<string, Promise<string>>();
  /** Session homes whose gateway this daemon may have started; stopped on close/stop. */
  private readonly gatewayHomes = new Set<string>();
  /** ROADMAP 1.13b: the hook's endpoint; absent when no hook argv was configured. */
  private readonly autoReview?: AutoReviewGate;
  private readonly autoReviewHookCommand?: string;
  private autoReviewHookArgv?: readonly string[];
  /** Per-session hook token + env (memory only; dropped on close). */
  private readonly autoReviewTurnEnv = new Map<string, { token: string; env: Record<string, string> }>();
  /**
   * The client that sent a session's latest turn. The Cindy adapter never calls
   * session/attach, so review requests fall back to this client (ROADMAP 1.13b).
   */
  private readonly turnOwners = new Map<string, ClientCtx>();

  constructor(opts: HermesManagerOptions) {
    this.hermesHome = opts.hermesHome;
    this.hermesBin = opts.hermesBin ?? 'hermes';
    this.hermesExtraArgs = opts.hermesExtraArgs;
    this.defaultPreamble = opts.defaultPreamble;
    this.logger = opts.logger;
    this.sessionHomes = opts.sessionHomes;
    this.registry = new SessionRegistry(opts.registryFile ?? null);
    this.server = new ManagerServer({
      socketPath: opts.socketPath,
      managerVersion: HERMES_MGR_BUNDLE_VERSION,
      logger: opts.logger,
    });
    if (opts.autoReviewHookArgv?.length) {
      this.autoReviewHookCommand = buildAutoReviewHookCommand(opts.autoReviewHookArgv);
      this.autoReviewHookArgv = opts.autoReviewHookArgv;
      this.autoReview = new AutoReviewGate({
        socketPath:
          opts.autoReviewSocketPath ?? nodePath.join(nodePath.dirname(opts.socketPath), 'hermes-review.sock'),
        handler: (sessionId, payload) => this.askClientToReview(sessionId, payload),
      });
    }
    this.wireHandlers();
    this.server.onClientClose((ctx) => {
      for (const [sessionId, attached] of this.attached) {
        if (attached === ctx) this.attached.delete(sessionId);
      }
      for (const [sessionId, owner] of this.turnOwners) {
        if (owner === ctx) this.turnOwners.delete(sessionId);
      }
    });
  }

  async start(): Promise<void> {
    if (this.sessionHomes) {
      const known = this.registry.list().map((rec) => rec.sessionId);
      for (const sessionId of known) {
        this.gatewayHomes.add(sessionHomePath(this.hermesHome, sessionId));
      }
      try {
        const reaped = await reapOrphanGateways(this.hermesHome, known);
        if (reaped.length > 0) this.logger?.info('stopped orphan session gateways', { reaped });
      } catch (error) {
        this.logger?.warn('orphan gateway reap failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        const removed = await reapOrphanHomes(this.hermesHome, known, {
          ...(this.sessionHomes.orphanHomeMinAgeMs !== undefined
            ? { minAgeMs: this.sessionHomes.orphanHomeMinAgeMs }
            : {}),
        });
        if (removed.length > 0) this.logger?.info('removed orphan session homes', { removed });
      } catch (error) {
        this.logger?.warn('orphan home reap failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.autoReview) {
      try {
        await this.autoReview.start();
      } catch (error) {
        // `auto` turns then fail closed at send (the gate is required); other modes are unaffected.
        this.logger?.warn('auto-review gate failed to start', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.server.start();
  }

  /**
   * ROADMAP 1.13b: one Hermes tool call of an `auto` session, asked of the
   * client attached to it. Anything but a valid `allow` blocks.
   */
  private async askClientToReview(
    sessionId: string,
    payload: { toolName: string; toolInput: unknown; toolCallId?: string },
  ): Promise<AutoReviewVerdict> {
    const rec = this.registry.get(sessionId);
    if (!rec || rec.permissionMode !== 'auto') {
      return { decision: 'block', reason: 'This session is no longer in Auto-review mode.' };
    }
    const ctx = this.attached.get(sessionId) ?? this.turnOwners.get(sessionId);
    if (!ctx) return { decision: 'block', reason: 'Cindy is not connected to this session.' };
    const input =
      payload.toolInput && typeof payload.toolInput === 'object' && !Array.isArray(payload.toolInput)
        ? (payload.toolInput as Record<string, unknown>)
        : { value: payload.toolInput };
    const params: ApprovalRequestParams = {
      sessionId,
      requestId: payload.toolCallId ?? `hook-${randomUUID()}`,
      kind: 'permission',
      toolName: payload.toolName,
      input,
    };
    try {
      const result = await this.server.sendRequest<ApprovalRequestResult>(
        ctx,
        SERVER_METHODS.APPROVAL_REQUEST,
        params,
        { timeoutMs: AUTO_REVIEW_CLIENT_TIMEOUT_MS },
      );
      return normalizeVerdict(
        result && result.kind === 'permission' && result.behavior === 'allow'
          ? { decision: 'allow' }
          : { decision: 'block', reason: result?.reason },
      );
    } catch (error) {
      this.logger?.warn('auto-review request failed; blocking', {
        sessionId,
        toolName: payload.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { decision: 'block', reason: 'Cindy auto-review did not answer.' };
    }
  }

  async stop(): Promise<void> {
    this.inFlightHomePrepares.clear();
    await this.autoReview?.stop().catch(() => {});
    const kills: Array<Promise<void>> = [];
    for (const [, turn] of this.running) {
      turn.killed = true;
      kills.push(turn.handle.kill());
    }
    await Promise.allSettled(kills);
    await Promise.allSettled([...this.gatewayHomes].map((home) => stopSessionGateway(home)));
    await this.server.stop();
  }

  /** One session's hook command: the shared argv plus that session's credentials file. */
  private hookCommandFor(sessionId: string): string | undefined {
    if (!this.autoReviewHookArgv) return undefined;
    return buildSessionHookCommand(
      this.autoReviewHookArgv,
      nodePath.join(sessionHomePath(this.hermesHome, sessionId), AUTO_REVIEW_CREDENTIALS_FILE),
    );
  }

  /** The home a session's turns run in: the shared home, or the session's own when enabled. */
  private async homeForSession(sessionId: string): Promise<string> {
    if (!this.sessionHomes) return this.hermesHome;
    // Prepares of one session run one after another (no EEXIST race), and each reads the
    // permission mode when it runs, so the last write always matches the current mode: an
    // older prewarm can never land after an `auto` send and strip the hook (ROADMAP 1.13b).
    const previous = this.inFlightHomePrepares.get(sessionId) ?? Promise.resolve('');
    const preparePromise: Promise<string> = previous.catch(() => '').then(async () => {
      try {
        const autoReview = this.registry.get(sessionId)?.permissionMode === 'auto';
        const base = this.sessionHomes!;
        const hookCommand = this.hookCommandFor(sessionId);
        const options: SessionHomeOptions =
          autoReview && hookCommand
            ? {
                ...base,
                transformConfig: (text, ctx) =>
                  injectAutoReviewHook(base.transformConfig ? base.transformConfig(text, ctx) : text, hookCommand),
              }
            : base;
        const prepared = await prepareSessionHome(this.hermesHome, sessionId, options);
        if (autoReview && hookCommand) {
          let review = this.autoReviewTurnEnv.get(sessionId);
          if (!review) {
            review = this.autoReview!.registerTurn(sessionId);
            this.autoReviewTurnEnv.set(sessionId, review);
          }
          await writeHookCredentials(nodePath.join(prepared.home, AUTO_REVIEW_CREDENTIALS_FILE), {
            socketPath: review.env[AUTO_REVIEW_SOCKET_ENV]!,
            token: review.token,
          });
        }
        this.gatewayHomes.add(prepared.home);
        return prepared.home;
      } finally {
        if (this.inFlightHomePrepares.get(sessionId) === preparePromise) {
          this.inFlightHomePrepares.delete(sessionId);
        }
      }
    });

    this.inFlightHomePrepares.set(sessionId, preparePromise);
    return preparePromise;
  }

  /** Start the session's gateway ahead of its first turn (hides the cold start). Best effort. */
  private prewarmGateway(sessionId: string): void {
    if (!this.sessionHomes || this.sessionHomes.prewarmGateway === false) return;
    void this.homeForSession(sessionId)
      .then((home) => {
        const child = spawn(this.hermesBin, [...(this.hermesExtraArgs ?? []), 'gateway', 'ensure'], {
          env: {
            ...process.env,
            HERMES_HOME: home,
            HERMES_MGR_CHILD: '1',
            ...this.sessionEnv.get(sessionId),
          },
          stdio: 'ignore',
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
        timer.unref();
        child.once('error', (error) => {
          clearTimeout(timer);
          this.logger?.warn('gateway prewarm failed to spawn', { sessionId, error: error.message });
        });
        child.once('exit', () => clearTimeout(timer));
      })
      .catch((error: unknown) => {
        this.logger?.warn('gateway prewarm skipped', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
      if (p.maxTurns !== undefined && !isValidMaxTurns(p.maxTurns)) {
        throw rpcError('INVALID_PARAMS', `maxTurns must be an integer from 1 to ${MAX_TURNS_LIMIT}`);
      }
      if (p.toolsets !== undefined && !isValidToolsets(p.toolsets)) {
        throw rpcError('INVALID_PARAMS', 'toolsets must be a non-empty list of distinct toolset names');
      }
      const created = this.registry.create({
        sessionId: p.sessionId,
        cwd: p.cwd,
        ...(p.resumeHermesSessionId ? { hermesSessionId: p.resumeHermesSessionId } : {}),
        ...(p.model ? { model: p.model } : {}),
        ...(p.provider ? { provider: p.provider } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
        ...(p.systemPromptPreamble ? { preamble: p.systemPromptPreamble } : {}),
        ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
        ...(p.toolsets ? { toolsets: [...p.toolsets] } : {}),
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
      this.prewarmGateway(p.sessionId);
      return {
        sessionId: p.sessionId,
        ...(rec.hermesSessionId ? { hermesSessionId: rec.hermesSessionId } : {}),
      };
    });

    s.setHandler(METHODS.QUERY_SEND, async (raw, ctx) => {
      const p = raw as HermesQuerySendParams;
      const rec = this.registry.get(p?.sessionId ?? '');
      if (!rec) {
        throw rpcError('SESSION_NOT_FOUND', 'query/start first');
      }
      this.turnOwners.set(rec.sessionId, ctx);
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
      let routeBaseUrl = rec.baseUrl;
      let routeApiKey = rec.apiKey;
      // ROADMAP 1.13b: `auto` needs its gate and its own home (the hook lives in that home's
      // config). Without either it must not run, never fall back to an unchecked `--yolo`.
      const autoReview = rec.permissionMode === 'auto';
      if (autoReview && (!this.autoReview || !this.autoReviewHookCommand || !this.sessionHomes)) {
        throw rpcError(
          'INTERNAL',
          'Hermes Auto-review is not available in this daemon (no review hook or no per-session homes); switch the task to another permission mode',
        );
      }
      if (!autoReview && rec.permissionMode !== 'bypassPermissions' && (!routeModel || !routeProvider)) {
        const homeRoute = await readHermesDefaultRoute(this.hermesHome);
        routeModel = routeModel ?? homeRoute.model;
        routeProvider = routeProvider ?? homeRoute.provider;
        routeBaseUrl = routeBaseUrl ?? homeRoute.baseUrl;
        if (!routeModel) {
          throw rpcError(
            'INVALID_PARAMS',
            'Hermes default/ask permissions need an explicit model: set model.default in $HERMES_HOME/config.yaml (or switch the task to Full access)',
          );
        }
      }

      let turnHome: string;
      try {
        turnHome = await this.homeForSession(rec.sessionId);
      } catch (error) {
        throw rpcError(
          'INTERNAL',
          `could not prepare the session home: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let turnEnv = this.sessionEnv.get(rec.sessionId);
      if (autoReview) {
        // Defense in depth: the home this turn runs in must carry the hook right now.
        const config = await readFile(nodePath.join(turnHome, 'config.yaml'), 'utf8').catch(() => '');
        if (!config.includes(this.hookCommandFor(rec.sessionId)!.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))) {
          throw rpcError('INTERNAL', 'Hermes Auto-review hook is missing from the session home; the turn was not started');
        }
        let review = this.autoReviewTurnEnv.get(rec.sessionId);
        if (!review) {
          review = this.autoReview!.registerTurn(rec.sessionId);
          this.autoReviewTurnEnv.set(rec.sessionId, review);
        }
        turnEnv = { ...(turnEnv ?? {}), ...review.env };
      }

      const baseSpec = {
        hermesBin: this.hermesBin,
        hermesHome: turnHome,
        cwd: rec.cwd,
        text: p.text,
        ...(preamble ? { preamble } : {}),
        ...(rec.permissionMode ? { permissionMode: rec.permissionMode } : {}),
        ...(rec.maxTurns !== undefined ? { maxTurns: rec.maxTurns } : {}),
        ...(rec.toolsets ? { toolsets: rec.toolsets } : {}),
        ...(this.hermesExtraArgs ? { extraArgs: this.hermesExtraArgs } : {}),
        env: turnEnv,
      };

      const startTurn = (
        resumeHermesSessionId: string | undefined,
        allowResumeFallback: boolean,
      ): void => {
        // A resume Hermes cannot resolve fails before producing any turn output.
        // Hold the events back until the id is proven live so the retry below can
        // discard them instead of showing the user a phantom failed turn.
        const held: unknown[] = [];
        let holding = Boolean(resumeHermesSessionId);
        const flushHeld = (): void => {
          for (const event of held.splice(0)) this.onHermesEvent(rec.sessionId, event, turnHome);
        };
        const onEvent = (event: unknown): void => {
          if (!holding) {
            this.onHermesEvent(rec.sessionId, event, turnHome);
            return;
          }
          held.push(event);
          const evt = event as { type?: string; session_id?: string } | null;
          const type = evt?.type;
          // A non-empty id proves the resume resolved (a missing one reports
          // ''); any real content event means Hermes is past session lookup.
          if (type !== 'system' && type !== 'result') holding = false;
          else if (type === 'system' && typeof evt?.session_id === 'string' && evt.session_id) {
            holding = false;
          }
          if (!holding) flushHeld();
        };

        // A resume must repeat the launch route (Hermes rejects any difference);
        // only a fresh session takes the current route and freezes it.
        const frozen = resumeHermesSessionId ? this.registry.get(rec.sessionId)?.launch : undefined;
        const flagModel = frozen ? frozen.model : routeModel;
        const flagProvider = frozen ? frozen.provider : routeProvider;
        const flagBaseUrl = frozen ? frozen.baseUrl : routeBaseUrl;
        const flagApiKey = frozen ? frozen.apiKey : routeApiKey;
        if (!resumeHermesSessionId) {
          this.registry.update(rec.sessionId, {
            launch: {
              model: routeModel,
              provider: routeProvider,
              baseUrl: routeBaseUrl,
              apiKey: routeApiKey,
              // Never undefined, so the key survives the sessions.json round-trip.
              permissionMode: rec.permissionMode ?? 'default',
            },
            appliedModel: routeModel,
          });
        }
        // Created before the spawn: only lines this run writes are reported.
        const compression = createCompressionWatcher(turnHome);
        const run = startHermesRun(
          {
            ...baseSpec,
            ...(flagModel ? { model: flagModel } : {}),
            ...(flagProvider ? { provider: flagProvider } : {}),
            ...(flagBaseUrl ? { baseUrl: flagBaseUrl } : {}),
            ...(flagApiKey ? { apiKey: flagApiKey } : {}),
            ...(resumeHermesSessionId ? { resumeHermesSessionId } : {}),
          },
          onEvent,
        );
        const turn: RunningTurn = { handle: run, killed: false, compression };
        this.running.set(rec.sessionId, turn);
        this.registry.update(rec.sessionId, { running: true });
        const compressionTimer = setInterval(() => {
          if (this.running.get(rec.sessionId) === turn) this.emitCompression(rec.sessionId, compression);
        }, COMPRESSION_POLL_MS);
        compressionTimer.unref?.();

        void run.result.then((res) => {
          clearInterval(compressionTimer);
          // A fallback turn replaces this record; only the live turn settles.
          if (this.running.get(rec.sessionId) !== turn) return;
          if (
            allowResumeFallback &&
            resumeHermesSessionId &&
            !turn.killed &&
            isInvalidResumeFailure(res) &&
            this.registry.get(rec.sessionId)?.hermesSessionId === resumeHermesSessionId
          ) {
            held.length = 0;
            // The home lost the session (purged, reset, or replaced). Drop the
            // dead id so later turns stop resuming it, tell the client why, and
            // replay this same input against a fresh session — the user's
            // message must not fail over a bookkeeping detail.
            this.registry.update(rec.sessionId, { hermesSessionId: undefined });
            this.emitEvent(rec.sessionId, {
              type: 'hermes-mgr',
              subtype: 'resume-reset',
              previousHermesSessionId: resumeHermesSessionId,
            });
            startTurn(undefined, false);
            return;
          }
          flushHeld();
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
      };

      // Resuming with a different model: switch in-session with `/model` first
      // (a local command, no model call). A failed switch ends the turn rather
      // than silently running the wrong model.
      const resumeId = this.registry.get(rec.sessionId)?.hermesSessionId;
      const current = this.registry.get(rec.sessionId);
      const launch = current?.launch;
      const providerChanged = Boolean(
        launch && (
          (launch.provider ?? '') !== (routeProvider ?? '') ||
          (launch.baseUrl ?? '') !== (routeBaseUrl ?? '')
        ),
      );

      // Hermes keeps --yolo and --safe-mode sessions apart: resuming under the
      // other flag silently starts an empty session (0.22.5). The new mode must
      // take effect (fail closed), so start fresh on purpose and say so.
      // A launch recorded before the mode was tracked counts as unchanged.
      // `auto` and `bypassPermissions` are both `--yolo` sessions to Hermes (`auto` only adds
      // `--accept-hooks` and a hook in config), so switching between them keeps the history.
      const yoloClass = (mode: typeof rec.permissionMode): boolean =>
        permissionModeToFlags(mode).includes('--yolo');
      const permissionChanged = Boolean(
        launch?.permissionMode && yoloClass(launch.permissionMode) !== yoloClass(rec.permissionMode),
      );

      let effectiveResumeId = resumeId;
      if (permissionChanged && effectiveResumeId) {
        this.emitEvent(rec.sessionId, {
          type: 'hermes-mgr',
          subtype: 'resume-reset',
          previousHermesSessionId: effectiveResumeId,
          reason: 'permission-mode-changed',
        });
      }
      if ((providerChanged || permissionChanged) && effectiveResumeId) {
        // Provider or baseUrl changed: Hermes CLI rejects changing provider flags on resume.
        // Start a fresh Hermes session on the target provider.
        effectiveResumeId = undefined;
        this.registry.update(rec.sessionId, {
          hermesSessionId: undefined,
          launch: undefined,
          appliedModel: undefined,
        });
      }

      let switchTo: string | undefined;
      if (effectiveResumeId && current?.launch && !providerChanged) {
        const running = current.appliedModel ?? current.launch.model;
        let desired = routeModel;
        if (!desired && running) desired = (await readHermesDefaultRoute(this.hermesHome)).model;
        if (desired && desired !== running) switchTo = desired;
      }
      if (effectiveResumeId && switchTo) {
        const target = switchTo;
        const switchRun = startHermesRun(
          {
            ...baseSpec,
            text: `/model ${target}`,
            preamble: undefined,
            resumeHermesSessionId: effectiveResumeId,
            ...(current?.launch?.model ? { model: current.launch.model } : {}),
            ...(current?.launch?.provider ? { provider: current.launch.provider } : {}),
            ...(current?.launch?.baseUrl ? { baseUrl: current.launch.baseUrl } : {}),
          },
          () => undefined,
        );
        const switchTurn: RunningTurn = { handle: switchRun, killed: false };
        this.running.set(rec.sessionId, switchTurn);
        this.registry.update(rec.sessionId, { running: true });
        void switchRun.result.then((res) => {
          if (this.running.get(rec.sessionId) !== switchTurn) return;
          const ok = !switchTurn.killed && !res.spawnError && res.code === 0;
          if (ok) {
            this.registry.update(rec.sessionId, { appliedModel: target });
            startTurn(effectiveResumeId, true);
            return;
          }
          this.running.delete(rec.sessionId);
          this.registry.update(rec.sessionId, { running: false });
          this.emitClosed(
            rec.sessionId,
            switchTurn.killed ? 'killed' : 'error',
            `could not switch the Hermes session to model "${target}": ${res.stderrTail || res.spawnError || `exit ${res.code}`}`,
          );
        });
      } else {
        startTurn(effectiveResumeId, true);
      }

      return {
        sessionId: rec.sessionId,
        ...(rec.hermesSessionId ? { hermesSessionId: rec.hermesSessionId } : {}),
      };
    });

    s.setHandler(METHODS.CONFIG_STATUS, async () => {
      try {
        const installedVersion = await readInstalledHermesVersion({
          hermesBin: this.hermesBin,
          hermesHome: this.hermesHome,
          ...(this.hermesExtraArgs ? { hermesExtraArgs: this.hermesExtraArgs } : {}),
        });
        const matches = installedVersion === HERMES_CLI_PINNED_VERSION;
        if (!matches) {
          this.logger?.warn('Hermes CLI version mismatch', {
            installedVersion,
            pinnedVersion: HERMES_CLI_PINNED_VERSION,
          });
        }
        return {
          installedVersion,
          pinnedVersion: HERMES_CLI_PINNED_VERSION,
          matches,
        };
      } catch (error) {
        this.logger?.warn('Unable to verify Hermes CLI version', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          installedVersion: null,
          pinnedVersion: HERMES_CLI_PINNED_VERSION,
          matches: null,
        };
      }
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

    s.setHandler(METHODS.CONFIG_LIST_MCP_SERVERS, async () => {
      return { servers: await readHermesMcpServers(this.hermesHome) };
    });

    s.setHandler(METHODS.CONFIG_SET_MCP_SERVER, async (raw) => {
      const p = raw as { name?: string; server?: import('./protocol.js').HermesMcpServerConfig };
      const name = typeof p?.name === 'string' ? p.name.trim() : '';
      if (!name) {
        throw rpcError('INVALID_PARAMS', 'server name is required');
      }
      if (!p.server || typeof p.server !== 'object') {
        throw rpcError('INVALID_PARAMS', 'server configuration is required');
      }
      return {
        servers: await writeHermesMcpServer(this.hermesHome, name, p.server),
      };
    });

    s.setHandler(METHODS.CONFIG_REMOVE_MCP_SERVER, async (raw) => {
      const p = raw as { name?: string };
      const name = typeof p?.name === 'string' ? p.name.trim() : '';
      if (!name) {
        throw rpcError('INVALID_PARAMS', 'server name is required');
      }
      return {
        servers: await removeHermesMcpServer(this.hermesHome, name),
      };
    });

    s.setHandler(METHODS.CONFIG_SET_LOCAL_CONTEXT_WINDOWS, async (raw) => {
      // 1.12b: replace the global model.ollama_num_ctx clamp with per-endpoint
      // custom_providers context windows (removes the key + upserts entries in
      // one atomic write).
      const p = raw as ConfigSetLocalContextWindowsParams;
      const list: unknown[] = Array.isArray(p?.entries) ? p.entries : [];
      if (list.length === 0) {
        throw rpcError('INVALID_PARAMS', 'at least one entry is required');
      }
      const entries: HermesLocalContextWindowEntry[] = [];
      for (const item of list) {
        const rec = (item ?? {}) as { name?: unknown; baseUrl?: unknown; contextLength?: unknown };
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        const baseUrl = typeof rec.baseUrl === 'string' ? rec.baseUrl.trim() : '';
        const contextLength = rec.contextLength;
        if (
          !name ||
          !/^https?:\/\//.test(baseUrl) ||
          typeof contextLength !== 'number' ||
          !Number.isInteger(contextLength) ||
          contextLength <= 0
        ) {
          throw rpcError(
            'INVALID_PARAMS',
            'each entry needs a name, an http(s) baseUrl and a positive integer contextLength',
          );
        }
        entries.push({ name, baseUrl, contextLength });
      }
      return await writeHermesLocalContextWindows(this.hermesHome, entries);
    });

    s.setHandler(METHODS.CONFIG_SET_PLUGIN_ENABLED, async (raw) => {
      const p = raw as { name?: unknown; enabled?: unknown };
      const name = typeof p?.name === 'string' ? p.name.trim() : '';
      if (!isValidHermesPluginName(name) || typeof p.enabled !== 'boolean') {
        throw rpcError('INVALID_PARAMS', 'a plugin name and enabled:boolean are required');
      }
      try {
        await setHermesPluginEnabled(
          {
            hermesBin: this.hermesBin,
            hermesHome: this.hermesHome,
            ...(this.hermesExtraArgs ? { hermesExtraArgs: this.hermesExtraArgs } : {}),
          },
          name,
          p.enabled,
        );
      } catch (error) {
        throw rpcError('INTERNAL', error instanceof Error ? error.message : String(error));
      }
      return { name, enabled: p.enabled };
    });

    s.setHandler(METHODS.QUERY_SET_MODEL, async (raw) => {
      const p = raw as HermesQuerySetModelParams;
      this.requireRecord(p.sessionId);
      if (typeof p.model !== 'string') {
        throw rpcError('INVALID_PARAMS', 'model is required');
      }
      // Empty string = drop the per-session override: the next turn reads the
      // home default route again (config.yaml). Cindy's 'hermes-default'
      // sentinel arrives here as '' for exactly that reason.
      const model = p.model.trim();
      this.registry.update(p.sessionId!, {
        model: model || undefined,
        provider: p.provider?.trim() || undefined,
        baseUrl: p.baseUrl?.trim() || undefined,
        apiKey: p.apiKey?.trim() || undefined,
      });
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
      this.turnOwners.delete(p.sessionId!);
      const review = this.autoReviewTurnEnv.get(p.sessionId!);
      if (review) {
        this.autoReview?.unregisterTurn(review.token);
        this.autoReviewTurnEnv.delete(p.sessionId!);
      }
      if (this.sessionHomes) {
        // Closing ends the Cindy session for good (it cannot be resumed), so its gateway and
        // home go with it. Best effort: a failure here must not fail the close.
        const home = sessionHomePath(this.hermesHome, p.sessionId!);
        this.gatewayHomes.delete(home);
        try {
          await stopSessionGateway(home);
          await removeSessionHome(this.hermesHome, p.sessionId!);
        } catch (error) {
          this.logger?.warn('session home cleanup failed', {
            sessionId: p.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
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

  private onHermesEvent(sessionId: string, event: unknown, turnHome?: string): void {
    const evt = event as { type?: string; subtype?: string; session_id?: string } | null;
    // Two bind points: lifecycle init on older builds, and the terminal result
    // on current ones (this CLI sends init with an empty session_id and puts
    // the id only on `result`). Without the result path the registry never
    // learns a fresh session's id, so the next turn cannot resume it.
    const reportedId = evt && (evt.type === 'system' || evt.type === 'result')
      && typeof evt.session_id === 'string'
      ? evt.session_id.trim()
      : '';
    if (reportedId) {
      const rec = this.registry.get(sessionId);
      if (rec?.hermesSessionId !== reportedId) {
        this.registry.bindHermes(sessionId, reportedId);
        this.emitEvent(sessionId, {
          type: 'hermes-mgr',
          subtype: 'session-bound',
          hermesSessionId: reportedId,
        });
      }
    }
    // A compression logged before this event belongs before it in the stream.
    const compression = this.running.get(sessionId)?.compression;
    if (compression) this.emitCompression(sessionId, compression);
    if (evt?.type === 'result' && turnHome) {
      // `result.tokens.input` sums every API call of the session; the context
      // size is the last call's prompt, which Hermes only logs (hermes-context.ts).
      const hermesSessionId = reportedId || this.registry.get(sessionId)?.hermesSessionId;
      const usage = hermesSessionId ? readTurnContextUsage(turnHome, hermesSessionId) : null;
      if (usage) this.emitEvent(sessionId, { type: 'hermes-mgr', subtype: 'context-usage', ...usage });
    }
    this.emitEvent(sessionId, event);
  }

  private emitCompression(sessionId: string, watcher: CompressionWatcher): void {
    const hermesSessionId = this.registry.get(sessionId)?.hermesSessionId;
    for (const compression of watcher.poll(hermesSessionId)) {
      this.emitEvent(sessionId, { type: 'hermes-mgr', subtype: 'compression', ...compression });
    }
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
