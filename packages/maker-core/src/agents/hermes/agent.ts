/**
 * HermesAgent — in-process adapter for the out-of-process `hermes-mgr` daemon.
 *
 * One logical Cindy session maps to one daemon session; the daemon runs one
 * Hermes child per turn and forwards verbatim Hermes stream-json events. This
 * file owns only the session/handle lifecycle and the AgentEvent projection:
 * event normalization lives in `./translator.ts`, wire framing in
 * `./transport.ts`, and the protocol mirror in `./protocol.ts`.
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import {
  AgentNotAuthenticatedError,
  AgentStartupStoppedError,
  BaseAgent,
  TurnPermissionPolicyUnsupportedError,
  type AgentDeps,
  type AgentSessionHandle,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { NotSupportedError, type Capabilities } from '../../types/capabilities.js';
import type { PermissionMode, UserMessage } from '../../types/common.js';
import type { AgentEvent, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import {
  HERMES_METHODS,
  HERMES_NOTIFICATIONS,
  type HermesClientReplacedNotification,
  type HermesPermissionMode,
  type HermesQueryEventNotification,
  type HermesQueryStartResult,
  type HermesSessionClosedNotification,
} from './protocol.js';
import { normalizeHermesEvent, type NormalizedHermesTokens } from './translator.js';
import { createHermesTransport, type HermesTransport } from './transport.js';
import { collectHermesProviderEnv } from './hermes-provider-env.js';

const HERMES_DEFAULT_MODEL_ID = 'hermes-default';
/** Advertised window; the daemon does not report a runtime value. */
const HERMES_CONTEXT_WINDOW = 200_000;
/** query/close waits for the daemon's SIGINT→SIGTERM→SIGKILL escalation. */
const QUERY_CLOSE_TIMEOUT_MS = 10_000;

function unsupported(): { supported: false; reason: 'not-implemented' } {
  return { supported: false, reason: 'not-implemented' };
}

/**
 * Cindy permission modes → the daemon's `HermesPermissionMode`. The daemon maps
 * only `bypassPermissions` to `--yolo`; everything else becomes `--safe-mode`.
 * `ask` therefore maps to Hermes's confirm-before-acting default, while modes
 * whose native behavior would be silently collapsed are rejected.
 */
function mapPermissionMode(mode: PermissionMode | undefined): HermesPermissionMode | undefined {
  switch (mode) {
    case undefined:
      return undefined;
    case 'default':
    case 'bypassPermissions':
      return mode;
    case 'ask':
      return 'default';
    default:
      throw new NotSupportedError(`permissionMode:${mode}`, {
        supported: false,
        reason: 'not-implemented',
      });
  }
}

/** Text attachments larger than this are refused rather than silently truncated. */
const HERMES_ATTACHMENT_MAX_BYTES = 256 * 1024;

function attachmentName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** A NUL byte in the leading window is the practical text/binary split. */
function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

/**
 * Hermes's chat channel has no native attachment flag, so a text file the user
 * attached is inlined into the turn (same convention as remote Pi) instead of
 * being dropped. Binaries and oversized files fail closed with an actionable
 * message.
 */
async function inlineFileAttachment(filePath: string): Promise<string> {
  const name = attachmentName(filePath);
  const info = await stat(filePath).catch((error: unknown) => {
    throw new Error(
      `hermes: failed to read file attachment ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!info.isFile()) {
    throw new Error(`hermes: file attachment is not a regular file: ${name}`);
  }
  if (info.size > HERMES_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `hermes: file attachment ${name} is ${info.size} bytes (limit ${HERMES_ATTACHMENT_MAX_BYTES}) — send a smaller file or paste the relevant part`,
    );
  }
  const data = await readFile(filePath);
  if (looksBinary(data)) {
    throw new Error(`hermes: binary file attachments are not supported yet (${name})`);
  }
  return `Attached file \`${name}\` (inlined from Cindy; Hermes has no native attachment channel):\n\`\`\`\n${data.toString('utf8')}\n\`\`\``;
}

/** Flatten a Cindy user turn for the daemon's stdin; text files are inlined. */
async function flattenUserMessage(message: UserMessage): Promise<string> {
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'file' || (block.type === 'mention' && block.kind === 'file')) {
      parts.push(await inlineFileAttachment(block.path));
      continue;
    }
    if (block.type === 'mention') {
      // Directory/agent mentions carry no content; keep the reference visible.
      parts.push(`Referenced ${block.kind ?? 'resource'}: ${block.name} (${block.path})`);
      continue;
    }
    throw new Error(`hermes: ${block.type} attachments are not supported yet`);
  }
  return parts.join('\n');
}

export class HermesAgent extends BaseAgent {
  readonly kind = 'hermes' as const;
  readonly capabilities: Capabilities;

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(HermesAgent.baseCapabilities());
  }

  private static baseCapabilities(): Capabilities {
    return {
      switchModel: unsupported(),
      // Model selection comes from the Hermes home's own config; the daemon
      // omits `-m` for this descriptor.
      availableModels: [{
        id: HERMES_DEFAULT_MODEL_ID,
        displayName: 'Hermes (default from Hermes home)',
        contextWindow: HERMES_CONTEXT_WINDOW,
        efforts: [],
        defaultEffort: null,
      }],
      hasFastMode: false,
      effort: unsupported(),
      effortLevels: [],
      reasoningDisplay: ['off'],
      // Only these two modes have distinct daemon behavior (--safe-mode vs
      // --yolo); offering acceptEdits/auto/plan would silently collapse them.
      permissionModes: [
        {
          id: 'default',
          displayName: 'Default permissions',
          description: 'Hermes safe mode: tool actions follow the Hermes home policy.',
        },
        {
          id: 'bypassPermissions',
          displayName: 'Full access',
          description: 'Runs Hermes with --yolo and no further confirmation. Highest risk.',
        },
      ],
      setPermissionModeMidSession: { supported: true },
      planMode: unsupported(),
      multimodal: {
        text: { supported: true },
        // v1 daemons reject image attachments rather than dropping them.
        image: unsupported(),
        file: unsupported(),
      },
      fork: unsupported(),
      rewind: unsupported(),
      sessionTree: unsupported(),
      abort: { supported: true },
      sameTurnSteer: unsupported(),
      memory: { supported: unsupported() },
      extraDirs: unsupported(),
      writableDirs: unsupported(),
    };
  }

  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    // The host owns the daemon; without a socket path no Hermes state exists yet.
    const socketPath = this.deps.resolveHermesManagerSocketPath?.(opts.sessionId);
    if (!socketPath) {
      throw new AgentStartupStoppedError(new Error(
        'hermes daemon not provisioned: '
        + 'AgentDeps.resolveHermesManagerSocketPath returned no socket path',
      ));
    }

    let permissionMode: HermesPermissionMode | undefined;
    let authState: Awaited<ReturnType<AgentDeps['auth']['getState']>>;
    try {
      permissionMode = mapPermissionMode(opts.permissionMode);
      authState = await this.deps.auth.getState({
        providerId: opts.providerId ?? null,
        model: opts.model,
      });
    } catch (error) {
      // Nothing was started yet, so this startup's directory lease is safe to release.
      throw new AgentStartupStoppedError(error);
    }
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError(
        'hermes',
        `hermes not authenticated: ${authState.errorReason ?? 'no_credentials'}`,
      );
    }

    const sessionId = randomUUID();
    const requestedPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    // Provider credentials from this process' env (desktop main inherits the
    // user shell). Keys travel the local socket per session and are never
    // persisted by the daemon.
    const providerEnv = collectHermesProviderEnv();
    // Only a non-empty native id is resumable; an empty string is the documented
    // "start fresh" recovery path (Maker persists handle.id as sdk_session_id).
    const requestedResumeId = opts.resumeSessionId?.trim();
    let transport: HermesTransport | undefined;

    try {
      transport = createHermesTransport({
        socketPath,
        logger: this.deps.logger,
      });
      await transport.hello();
      const startResult = await transport.request<HermesQueryStartResult>(
        HERMES_METHODS.QUERY_START,
        {
          sessionId,
          cwd: opts.workingDir,
          ...(requestedResumeId ? { resumeHermesSessionId: requestedResumeId } : {}),
          ...(opts.model && opts.model !== HERMES_DEFAULT_MODEL_ID ? { model: opts.model } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          // Provider keys ride per-session env (the daemon's own env is
          // deliberately secret-free). Hermes reads provider credentials from
          // env; without this a DeepSeek-direct home cannot authenticate.
          ...(Object.keys(providerEnv).length ? { env: providerEnv } : {}),
        },
      );
      const resumableSessionId = typeof startResult?.hermesSessionId === 'string'
        ? startResult.hermesSessionId.trim()
        : '';
      return this.createSessionHandle({
        sessionId,
        resumableSessionId,
        model: opts.model,
        permissionMode: requestedPermissionMode,
        transport,
      });
    } catch (error) {
      if (transport) {
        try {
          await transport.close();
        } catch (closeError) {
          this.deps.logger.warn('hermes-mgr startup disconnect failed', {
            error: String(closeError),
          });
        }
      }
      // A protocol mismatch is an environment-preparation failure: the daemon is
      // external to this process, so Maker must treat this startup as stopped (and
      // release the worktree runtime lease) while surfacing the mismatch as cause.
      throw new AgentStartupStoppedError(error);
    }
  }

  private createSessionHandle(input: {
    sessionId: string;
    /** Hermes-native id suitable for `--resume`; '' until the daemon reports one. */
    resumableSessionId: string;
    model: string;
    permissionMode: PermissionMode;
    transport: HermesTransport;
  }): AgentSessionHandle {
    const { sessionId, transport } = input;
    const logger = this.deps.logger;
    const queue = createAsyncQueue<AgentEvent>();
    const usage = { tokenUsage: 0, contextTokens: 0, costUsd: 0 };
    let hermesSessionId: string | undefined;
    // Monotonic per-send epoch. `session/closed` has no epoch on the wire, so
    // each result-settled turn leaves exactly one close to be consumed; any
    // other close belongs to the currently active epoch only.
    let sendEpoch = 0;
    let activeEpoch: number | null = null;
    let awaitingCloseEpoch: number | null = null;
    // Session/closed is per-turn; only losing the daemon connection or the
    // handle's own close ends the logical session.
    let connectionLost = false;
    let closedByUser = false;
    let closePromise: Promise<void> | null = null;
    // v1 never receives approval requests from the daemon; M3 will dispatch
    // through this resolver.
    const interactionState: { resolver?: InteractionResolver } = {};

    const usageSnapshot = (): UsageSnapshot => ({
      tokenUsage: usage.tokenUsage,
      contextTokens: usage.contextTokens,
      contextWindow: HERMES_CONTEXT_WINDOW,
      costUsd: usage.costUsd,
    });

    const rejectUnsupportedSendOptions = (sendOpts: SendOptions | undefined): void => {
      if (!sendOpts) return;
      // No Hermes-side tool gating exists in v1, so these safety boundaries
      // cannot be honored; fail closed before dispatch.
      if (sendOpts.toolsDisabled === true) {
        throw new NotSupportedError('toolsDisabled', {
          supported: false,
          reason: 'not-implemented',
        });
      }
      if (sendOpts.turnPermissionPolicy !== undefined) {
        throw new TurnPermissionPolicyUnsupportedError('hermes', input.permissionMode);
      }
    };

    const emitTerminal = (
      kind: 'cancelled' | 'failed',
      detail?: string,
    ): void => {
      if (kind === 'failed') {
        queue.push({
          type: 'error',
          data: {
            message: detail?.trim() || 'Hermes turn failed',
            isTerminal: true,
          },
          source: 'hermes',
        });
      }
      queue.push({
        type: 'status',
        data: { status: 'Done', ...usageSnapshot(), isRunning: false },
        source: 'hermes',
      });
      queue.push({
        type: 'done',
        data: {
          type: 'hermes/session-closed',
          result: '',
          status: kind,
        },
        source: 'hermes',
      });
    };

    const handleHermesEvent = (event: unknown): void => {
      const normalized = normalizeHermesEvent(event);
      switch (normalized.kind) {
        case 'session-bound':
          hermesSessionId = normalized.hermesSessionId;
          queue.push({
            type: 'session_id',
            data: normalized.hermesSessionId,
            source: 'hermes',
          });
          return;
        case 'assistant-delta':
          queue.push({
            type: 'text',
            data: { text: normalized.text },
            source: 'hermes',
          });
          return;
        case 'tool-use':
          queue.push({
            type: 'tool_use',
            data: {
              ...(normalized.toolCallId ? { toolUseId: normalized.toolCallId } : {}),
              toolName: normalized.name,
              input: normalized.input ?? {},
            },
            source: 'hermes',
          });
          return;
        case 'tool-result': {
          const toolUseId = normalized.toolCallId;
          queue.push({
            type: 'tool_result_full',
            data: {
              ...(toolUseId ? { toolUseId } : {}),
              fullText: normalized.output,
              isError: normalized.isError,
            },
            source: 'hermes',
          });
          queue.push({
            type: 'tool_result',
            data: {
              summary: normalized.isError ? 'failed' : 'done',
              toolUseIds: toolUseId ? [toolUseId] : [],
            },
            source: 'hermes',
          });
          return;
        }
        case 'turn-complete': {
          const settledEpoch = activeEpoch;
          activeEpoch = null;
          // The daemon emits exactly one session/closed per run after `result`;
          // remember that close so it cannot settle a later turn.
          if (settledEpoch !== null) awaitingCloseEpoch = settledEpoch;
          const tokens: NormalizedHermesTokens = normalized.tokens;
          if (normalized.hermesSessionId && normalized.hermesSessionId !== hermesSessionId) {
            // Fallback for a lost session-bound lifecycle event: the result event
            // also carries the Hermes session id used for resume.
            hermesSessionId = normalized.hermesSessionId;
            queue.push({
              type: 'session_id',
              data: normalized.hermesSessionId,
              source: 'hermes',
            });
          }
          usage.tokenUsage += tokens.input + tokens.output;
          usage.contextTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
          const succeeded = normalized.exitCode === 0;
          if (!succeeded) {
            queue.push({
              type: 'error',
              data: {
                message: normalized.error?.trim()
                  || `Hermes exited with code ${normalized.exitCode}`,
                isTerminal: true,
                ...(normalized.error ? { sdkError: normalized.error } : {}),
              },
              source: 'hermes',
            });
          }
          queue.push({
            type: 'status',
            data: { status: 'Done', ...usageSnapshot(), isRunning: false },
            source: 'hermes',
          });
          queue.push({
            type: 'done',
            data: {
              type: 'hermes/turn-complete',
              result: succeeded ? normalized.text : '',
              status: succeeded ? 'completed' : 'failed',
              ...(normalized.error ? { error: normalized.error } : {}),
              usage: {
                inputTokens: tokens.input,
                outputTokens: tokens.output,
                cacheReadTokens: tokens.cacheRead,
                cacheCreationTokens: tokens.cacheWrite,
                ...(normalized.durationMs !== undefined
                  ? { durationMs: normalized.durationMs }
                  : {}),
              },
            },
            source: 'hermes',
          });
          return;
        }
        case 'unknown':
          // Forward compatibility: Hermes evolves its event set. The translator
          // already normalized this; do not log on the hot path.
          return;
      }
    };

    const handleSessionClosed = (notification: HermesSessionClosedNotification): void => {
      if (awaitingCloseEpoch !== null) {
        // This closes the turn whose `result` already settled it. It must never
        // settle a newer turn that started before this notification arrived.
        awaitingCloseEpoch = null;
        return;
      }
      if (activeEpoch === null) return;
      const settledEpoch = activeEpoch;
      activeEpoch = null;
      logger.debug('hermes session closed during a turn', {
        reason: notification.reason,
        epoch: settledEpoch,
      });
      switch (notification.reason) {
        case 'completed':
          // A code-0 child that produced no result still ends the turn.
          queue.push({
            type: 'status',
            data: { status: 'Done', ...usageSnapshot(), isRunning: false },
            source: 'hermes',
          });
          queue.push({
            type: 'done',
            data: { type: 'hermes/session-closed', result: '', status: 'completed' },
            source: 'hermes',
          });
          return;
        case 'killed':
        case 'closed':
          emitTerminal('cancelled');
          return;
        case 'error':
          // The daemon keeps the session record and the next send resumes it;
          // only this turn failed.
          emitTerminal('failed', notification.detail);
          return;
      }
    };

    transport.onNotification((notification) => {
      if (closedByUser) return;
      const { method, params } = notification;
      if (method === HERMES_NOTIFICATIONS.QUERY_EVENT) {
        const event = params as HermesQueryEventNotification | null;
        if (!event || event.sessionId !== sessionId) return;
        handleHermesEvent(event.event);
        return;
      }
      if (method === HERMES_NOTIFICATIONS.SESSION_CLOSED) {
        const closed = params as HermesSessionClosedNotification | null;
        if (!closed || closed.sessionId !== sessionId) return;
        handleSessionClosed(closed);
        return;
      }
      if (method === HERMES_NOTIFICATIONS.CLIENT_REPLACED) {
        const replaced = params as HermesClientReplacedNotification | null;
        if (!replaced || replaced.sessionId !== sessionId) return;
        // Another client took the daemon's event stream; this handle can no
        // longer observe the turn, so fail closed instead of hanging.
        logger.warn('hermes session control was taken over by another client', { sessionId });
        connectionLost = true;
        if (activeEpoch !== null) {
          activeEpoch = null;
          awaitingCloseEpoch = null;
          emitTerminal('failed', 'Hermes session control was taken over by another client');
        }
        closedByUser = true;
        void transport.close().catch(() => undefined);
        queue.end();
      }
    });

    transport.onClose((info) => {
      if (closedByUser) {
        queue.end();
        return;
      }
      logger.warn('hermes-mgr transport closed', { reason: info.reason });
      connectionLost = true;
      if (activeEpoch !== null) {
        activeEpoch = null;
        emitTerminal('failed', `Hermes runtime exited: ${info.reason}`);
      }
      queue.end();
    });

    const handle: AgentSessionHandle = {
      // Maker persists this as sessions.sdk_session_id and feeds it back as
      // resumeSessionId. It must be the Hermes-native id or '' (fresh), never the
      // daemon's logical routing id.
      id: input.resumableSessionId,
      agentKind: 'hermes',
      model: input.model,
      validateSendOptions(sendOpts: SendOptions): void {
        rejectUnsupportedSendOptions(sendOpts);
      },
      async send(message: UserMessage, sendOpts?: SendOptions): Promise<void> {
        rejectUnsupportedSendOptions(sendOpts);
        if (closedByUser) throw new Error('Hermes session is closed');
        if (connectionLost) {
          throw new Error(
            'hermes daemon connection lost; start a new session to reconnect',
          );
        }
        const text = await flattenUserMessage(message);
        // Mark the turn before the RPC so a terminal notification arriving in
        // the same socket chunk cannot be cleared by the accepted-send path.
        const epoch = ++sendEpoch;
        const previousEpoch = activeEpoch;
        activeEpoch = epoch;
        // Hermes can stay silent through the whole first model call (and tool
        // runs), unlike token-streaming harnesses; announce the turn now so the
        // composer shows a running state instead of a blank transcript.
        queue.push({
          type: 'status',
          data: { status: 'Working…', ...usageSnapshot(), isRunning: true },
          source: 'hermes',
        });
        try {
          await transport.request(HERMES_METHODS.QUERY_SEND, { sessionId, text });
        } catch (error) {
          if (activeEpoch === epoch) activeEpoch = previousEpoch;
          throw error;
        }
      },
      async steer(): Promise<void> {
        throw new NotSupportedError('sameTurnSteer', {
          supported: false,
          reason: 'not-implemented',
        });
      },
      async abort(): Promise<void> {
        if (closedByUser || transport.isClosed()) return;
        try {
          await transport.request(HERMES_METHODS.QUERY_INTERRUPT, { sessionId });
        } catch (error) {
          logger.warn('hermes abort request failed', { error: String(error) });
        }
      },
      async close(): Promise<void> {
        if (closePromise) return closePromise;
        closedByUser = true;
        const closing = (async (): Promise<void> => {
          if (!transport.isClosed()) {
            try {
              await transport.request(
                HERMES_METHODS.QUERY_CLOSE,
                { sessionId },
                { timeoutMs: QUERY_CLOSE_TIMEOUT_MS },
              );
            } catch (error) {
              logger.warn('hermes query/close failed', { error: String(error) });
            }
          }
          try {
            await transport.close();
          } catch (error) {
            logger.warn('hermes transport close failed', { error: String(error) });
          }
          queue.end();
        })();
        closePromise = closing;
        return closing;
      },
      events() {
        return queue;
      },
      getUsageSnapshot(): UsageSnapshot {
        return usageSnapshot();
      },
      setInteractionResolver(resolver: InteractionResolver): void {
        interactionState.resolver = resolver;
      },
      async setPermissionMode(mode: PermissionMode): Promise<void> {
        const mapped = mapPermissionMode(mode);
        if (!mapped) throw new Error('hermes: permission mode is required');
        await transport.request(HERMES_METHODS.QUERY_SET_PERMISSION_MODE, {
          sessionId,
          mode: mapped,
        });
      },
      // Per-session model override, live for the *next* turn (each turn spawns
      // the CLI with the record's model; the home default route applies when the
      // override is absent). 'hermes-default' is Cindy's sentinel for "follow
      // the home default again" and maps to an empty override on the wire.
      async setModel(model: string): Promise<void> {
        const trimmed = model.trim();
        if (!trimmed) throw new Error('hermes: model is required');
        await transport.request(HERMES_METHODS.QUERY_SET_MODEL, {
          sessionId,
          model: trimmed === HERMES_DEFAULT_MODEL_ID ? '' : trimmed,
        });
      },
    };

    return handle;
  }
}
