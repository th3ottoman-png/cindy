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
import * as fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
import type { Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { AgentEvent, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import type {
  AgentBuiltinCommand,
  AgentSkillCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from '../../types/palette.js';
import { listSkillsWithState, readBundledSkillNames } from '../../skills/skill-manager.js';
import {
  HERMES_METHODS,
  HERMES_NOTIFICATIONS,
  HERMES_SERVER_METHODS,
  type HermesApprovalRequestParams,
  type HermesApprovalRequestResult,
  type HermesClientReplacedNotification,
  type HermesPermissionMode,
  type HermesQueryEventNotification,
  type HermesQueryStartResult,
  type HermesSessionClosedNotification,
} from './protocol.js';
import { normalizeHermesEvent, type NormalizedHermesTokens } from './translator.js';
import { createHermesTransport, type HermesTransport } from './transport.js';
import { normalizeHermesToolForAutoReview } from './auto-review-policy.js';
import {
  annotatePermissionRequestForAutoReview,
  appendAutoReviewUserIntent,
  createAutoReviewActionContext,
  createAutoReviewUnavailableNotice,
  resolveAutoReviewDecision,
  withAutoReviewContext,
  type AutoReviewRequest,
  type AutoReviewUserIntent,
} from '../shared/auto-review-decision.js';
import { collectHermesProviderEnv } from './hermes-provider-env.js';
import { resolveModelRoute } from '../../providers/model-route-resolver.js';
import { preflightModelRoute } from '../../providers/route-preflight.js';

export const HERMES_AGENT_COMMANDS: AgentBuiltinCommand[] = [
  {
    kind: 'agent-builtin',
    name: 'compact',
    description: 'Compress conversation history when nearing context limit.',
  },
];

const HERMES_DEFAULT_MODEL_ID = 'hermes-default';
/** Fallback window until the daemon reports the model's own (context-usage event). */
const HERMES_CONTEXT_WINDOW = 200_000;
/** query/close waits for the daemon's SIGINT→SIGTERM→SIGKILL escalation. */
const QUERY_CLOSE_TIMEOUT_MS = 10_000;
/**
 * Turn cap for a delegated job (ADR 0005, ROADMAP 3.9b): every run of an Orca worker session
 * gets `--max-turns` with this many tool-calling iterations. Leads and solo sessions keep the
 * Hermes home default.
 */
export const HERMES_ORCA_WORKER_MAX_TURNS = 40;

/** The stored chat line for a Hermes auto-compression (ROADMAP 1.11). */
function compressionNotice(preTokens?: number, postTokens?: number): string {
  const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  if (preTokens !== undefined && postTokens !== undefined) {
    return `Context compressed automatically: ${k(preTokens)} → ${k(postTokens)} tokens.`;
  }
  if (postTokens !== undefined) return `Context compressed automatically: now about ${k(postTokens)} tokens.`;
  return 'Context compressed automatically.';
}

function unsupported(): { supported: false; reason: 'not-implemented' } {
  return { supported: false, reason: 'not-implemented' };
}

/**
 * Cindy permission modes → the daemon's `HermesPermissionMode`. The daemon maps
 * `bypassPermissions` to `--yolo`, `auto` to `--yolo --accept-hooks` plus a
 * fail-closed review hook (ROADMAP 1.13), and everything else to `--safe-mode`.
 * `ask` therefore maps to Hermes's confirm-before-acting default, while modes
 * whose native behavior would be silently collapsed are rejected.
 */
function mapPermissionMode(mode: PermissionMode | undefined): HermesPermissionMode | undefined {
  switch (mode) {
    case undefined:
      return undefined;
    case 'default':
    case 'bypassPermissions':
    case 'auto':
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
    if (block.type === 'image') {
      const name = attachmentName(block.path);
      const mime = block.mimeType ? ` (${block.mimeType})` : '';
      parts.push(
        `Attached image \`${name}\`${mime} located at: \`${block.path}\` (available on the local filesystem).`,
      );
      continue;
    }
    throw new Error(`hermes: ${(block as { type: string }).type} attachments are not supported yet`);
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
      // Per-session model override is implemented (handle.setModel → query/setModel,
      // applied to the next turn by the daemon). 1.8c-1 and 1.8d proved it against the
      // real CLI. Declaring it unsupported made session.setModel throw before reaching
      // the handle, so the desktop picker could never change a Hermes session's model.
      switchModel: { supported: true },
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
      // Only these modes have distinct daemon behavior (--safe-mode, --yolo, and
      // --yolo behind the auto-review hook); acceptEdits/plan would silently collapse.
      permissionModes: [
        {
          id: 'default',
          displayName: 'Default permissions',
          description:
            'Hermes safe mode: tool actions follow the Hermes home policy. Cindy document tools are off (safe mode disables MCP).',
        },
        {
          id: 'auto',
          displayName: 'Auto-review',
          description:
            'Full Hermes tools, but every tool call is checked first: safe actions run, risky ones are blocked or ask you. Cindy document tools are available when the chat starts in this mode.',
        },
        {
          id: 'bypassPermissions',
          displayName: 'Full access',
          description:
            'Runs Hermes with --yolo and no further confirmation. Highest risk. Cindy document tools (cindy_docs) are available when the chat starts in this mode.',
        },
      ],
      setPermissionModeMidSession: { supported: true },
      planMode: unsupported(),
      multimodal: {
        text: { supported: true },
        image: { supported: true },
        file: unsupported(),
      },
      fork: { supported: true },
      rewind: unsupported(),
      sessionTree: unsupported(),
      abort: { supported: true },
      sameTurnSteer: unsupported(),
      memory: { supported: unsupported() },
      extraDirs: unsupported(),
      writableDirs: unsupported(),
    };
  }

  override listAgentCommands(): AgentBuiltinCommand[] {
    return HERMES_AGENT_COMMANDS;
  }

  override async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    const skills: AgentSkillCommand[] = [];
    const errors: Array<{ path?: string; message: string }> = [];

    // 1. Home skills (~/.hermes-cindy/skills)
    const home = this.deps.resolveHermesHome?.() ?? path.join(os.homedir(), '.hermes-cindy');
    const skillsRoot = path.join(home, 'skills');
    const disabledRoot = path.join(home, 'skills-disabled');

    if (fs.existsSync(skillsRoot)) {
      try {
        const skillsWithState = listSkillsWithState(skillsRoot, disabledRoot);
        const bundled = readBundledSkillNames(skillsRoot);
        for (const s of skillsWithState) {
          if (s.enabled) {
            skills.push({
              kind: 'agent-skill',
              name: s.name,
              description: s.description,
              source: 'skill',
              path: path.join(s.dir, 'SKILL.md'),
              scope: 'global',
              enabled: true,
              builtIn: bundled.has(s.name),
            });
          }
        }
      } catch (err) {
        errors.push({ path: skillsRoot, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // 2. Project / repo skills (<workingDir>/.hermes/skills)
    if (opts.workingDir) {
      const repoSkillsRoot = path.join(opts.workingDir, '.hermes', 'skills');
      const repoDisabledRoot = path.join(opts.workingDir, '.hermes', 'skills-disabled');
      if (fs.existsSync(repoSkillsRoot)) {
        try {
          const repoSkills = listSkillsWithState(repoSkillsRoot, repoDisabledRoot);
          for (const s of repoSkills) {
            if (s.enabled && !skills.some((existing) => existing.name === s.name)) {
              skills.push({
                kind: 'agent-skill',
                name: s.name,
                description: s.description,
                source: 'skill',
                path: path.join(s.dir, 'SKILL.md'),
                scope: 'repo',
                enabled: true,
              });
            }
          }
        } catch (err) {
          errors.push({ path: repoSkillsRoot, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { skills, ...(errors.length > 0 ? { errors } : {}) };
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
    // Only a non-empty native id is resumable; an empty string is the documented
    // "start fresh" recovery path (Maker persists handle.id as sdk_session_id).
    const requestedResumeId = opts.resumeSessionId?.trim();
    // The expert's toolsets lock (ROADMAP 3.10). Fixed at start: Hermes refuses a resume whose
    // -t differs from the launch, so a lock that cannot be resolved refuses the start.
    let toolsets: string[] | null = null;
    if (this.deps.resolveHermesToolsets && opts.sessionId) {
      try {
        toolsets = this.deps.resolveHermesToolsets({ sessionId: opts.sessionId, fresh: !requestedResumeId });
      } catch (error) {
        throw new AgentStartupStoppedError(error);
      }
    }
    // Provider credentials from this process' env (desktop main inherits the
    // user shell). Keys travel the local socket per session and are never
    // persisted by the daemon.
    const providerEnv = collectHermesProviderEnv();
    // Cindy tool bridge identity: failure degrades to a session without Cindy
    // tools (convenience), never blocks the chat (daily driver).
    let bridgeSession: {
      env: Record<string, string>;
      dispose: () => void;
      setVendorOptions?: (patch: Record<string, unknown>) => void;
    } | null = null;
    // No Cindy session id means no identity to register.
    if (this.deps.prepareHermesBridgeSession && opts.sessionId) {
      try {
        bridgeSession = await this.deps.prepareHermesBridgeSession({
          sessionId: opts.sessionId,
          ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
          workingDir: opts.workingDir,
          permissionMode: requestedPermissionMode,
          ...(opts.vendorOptions ? { vendorOptions: { ...opts.vendorOptions } } : {}),
          ...(toolsets ? { toolsets } : {}),
        });
      } catch (error) {
        this.deps.logger.warn('hermes bridge session prep failed, continuing without cindy tools', {
          error: String(error),
        });
      }
    }
    const sessionEnv = { ...providerEnv, ...(bridgeSession?.env ?? {}) };
    let transport: HermesTransport | undefined;

    try {
      transport = createHermesTransport({
        socketPath,
        logger: this.deps.logger,
      });
      await transport.hello();
      const route = resolveModelRoute(opts.model);
      const targetModel = route ? route.model : (opts.model && opts.model !== HERMES_DEFAULT_MODEL_ID ? opts.model : undefined);
      const targetProvider = route ? route.provider : opts.providerId;
      const targetBaseUrl = route?.baseUrl;
      const targetApiKey = route?.apiKey;

      const startResult = await transport.request<HermesQueryStartResult>(
        HERMES_METHODS.QUERY_START,
        {
          sessionId,
          cwd: opts.workingDir,
          ...(requestedResumeId ? { resumeHermesSessionId: requestedResumeId } : {}),
          ...(targetModel ? { model: targetModel } : {}),
          ...(targetProvider ? { provider: targetProvider } : {}),
          ...(targetBaseUrl ? { baseUrl: targetBaseUrl } : {}),
          ...(targetApiKey ? { apiKey: targetApiKey } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(opts.vendorOptions?.orcaRole === 'worker' ? { maxTurns: HERMES_ORCA_WORKER_MAX_TURNS } : {}),
          ...(toolsets ? { toolsets } : {}),
          // Provider keys ride per-session env (the daemon's own env is
          // deliberately secret-free). Hermes reads provider credentials from
          // env; without this a DeepSeek-direct home cannot authenticate.
          ...(Object.keys(sessionEnv).length ? { env: sessionEnv } : {}),
        },
      );
      const resumableSessionId = typeof startResult?.hermesSessionId === 'string'
        ? startResult.hermesSessionId.trim()
        : '';
      return this.createSessionHandle({
        sessionId,
        resumableSessionId,
        ...(opts.sessionId ? { cindySessionId: opts.sessionId } : {}),
        freshHermesSession: !requestedResumeId,
        vendorOptions: { ...(opts.vendorOptions ?? {}) },
        ...(bridgeSession?.setVendorOptions ? { setBridgeVendorOptions: bridgeSession.setVendorOptions } : {}),
        model: opts.model,
        permissionMode: requestedPermissionMode,
        workingDir: opts.workingDir,
        providerId: opts.providerId ?? null,
        ...(toolsets ? { toolsets } : {}),
        transport,
        ...(bridgeSession ? { disposeBridgeSession: bridgeSession.dispose } : {}),
      });
    } catch (error) {
      try {
        bridgeSession?.dispose();
      } catch (disposeError) {
        this.deps.logger.warn('hermes bridge session dispose failed', { error: String(disposeError) });
      }
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
    /** The task folder: the only read/write root Auto-review grants (ROADMAP 1.13c). */
    workingDir: string;
    providerId: string | null;
    transport: HermesTransport;
    /** Unregisters the bridge identity; idempotent, called on close. */
    disposeBridgeSession?: () => void;
    /** Cindy session id (expert binding key, ROADMAP 3.2a). */
    cindySessionId?: string;
    /** True when this handle started a new Hermes session (no `--resume`). */
    freshHermesSession?: boolean;
    /** Live vendorOptions (Orca role/team), updated by setVendorOptions (ROADMAP 3.7a). */
    vendorOptions?: Record<string, unknown>;
    /** Pushes a vendorOptions patch into the Cindy tool bridge identity. */
    setBridgeVendorOptions?: (patch: Record<string, unknown>) => void;
    /** The toolsets lock this session launched with (ROADMAP 3.10). */
    toolsets?: string[];
  }): AgentSessionHandle {
    const { sessionId, transport } = input;
    const logger = this.deps.logger;
    const queue = createAsyncQueue<AgentEvent>();
    const usage = { tokenUsage: 0, contextTokens: 0, costUsd: 0 };
    // The model's window, once a context-usage event reported it (models.dev or providers.yaml).
    const initialRoute = resolveModelRoute(input.model);
    let contextWindow = initialRoute?.contextLength ?? HERMES_CONTEXT_WINDOW;
    // The current turn's last API call prompt size, from the daemon's
    // context-usage event; consumed by that turn's result.
    let turnPromptTokens: number | undefined;
    let hermesSessionId: string | undefined;
    // The model the current turn actually ran on. Hermes reports it in its
    // `system/init` event (per spawned CLI process, so it is exact even when
    // the home default changed between turns or a `/model` switch happened
    // mid-session). The Cindy-side session model is not a substitute: it is
    // either the 'hermes-default' sentinel or an override for the *next* turn.
    let turnModel: string | undefined;
    // providers.yaml endpoint id of the current turn's per-session route (undefined =
    // Hermes home route). Stamped on the done usage so the turn is labelled and priced
    // by the endpoint it actually ran on (ROADMAP 1.9b-3c).
    let turnProviderId: string | undefined;
    // A fresh Hermes session has not seen its expert instructions yet; they ride the
    // first accepted turn only (a resumed session already holds them in its history).
    let expertPreamblePending = input.freshHermesSession === true && Boolean(input.cindySessionId);
    // Orca (ROADMAP 3.7a): the lead/worker instructions ride the next turn whenever they
    // change (a session can become a lead mid-chat via start_team). A resumed session is
    // assumed to already hold the instructions matching its persisted role.
    const liveVendorOptions: Record<string, unknown> = { ...(input.vendorOptions ?? {}) };
    const resolveOrcaPreamble = this.deps.resolveHermesOrcaPreamble;
    const orcaPreambleFor = (): string | null => (input.cindySessionId && resolveOrcaPreamble
      ? resolveOrcaPreamble({ sessionId: input.cindySessionId, vendorOptions: liveVendorOptions })
      : null);
    let lastSentOrcaPreamble: string | null = input.freshHermesSession === true ? null : orcaPreambleFor();
    // Monotonic per-send epoch. `session/closed` has no epoch on the wire, so
    // each result-settled turn leaves exactly one close to be consumed; any
    // other close belongs to the currently active epoch only.
    let sendEpoch = 0;
    let activeEpoch: number | null = null;
    let awaitingCloseEpoch: number | null = null;
    // The epoch of the turn the user asked to stop (handle.abort). Real Hermes
    // answers SIGINT with a failing terminal `result` (exit code 130 = 128 +
    // SIGINT) before the daemon's killed close arrives, so the result handler
    // needs this to settle that turn as a user cancellation instead of a
    // provider failure: a Stop must not raise an error banner or count as a
    // provider-group failure (ROADMAP 1.10b, observed live 2026-10-31).
    let userAbortEpoch: number | null = null;
    // Session/closed is per-turn; only losing the daemon connection or the
    // handle's own close ends the logical session.
    let connectionLost = false;
    let closedByUser = false;
    let closePromise: Promise<void> | null = null;
    // Asks the owner when Auto-review says `ask` (ROADMAP 1.13c).
    const interactionState: { resolver?: InteractionResolver } = {};
    // Auto-review state (ROADMAP 1.13c): the live mode, the owner's own words so far,
    // and the calls blocked since the last message.
    let permissionModeNow: PermissionMode = input.permissionMode;
    let autoReviewIntent: AutoReviewUserIntent | undefined;
    const autoReviewActionContext = createAutoReviewActionContext();
    // A function, not a narrowed read: the mode can change while a review awaits.
    const currentPermissionMode = (): PermissionMode => permissionModeNow;
    const autoReviewUnavailableNotice = createAutoReviewUnavailableNotice((message) => {
      queue.push({ type: 'error', data: { message, isTerminal: false }, source: 'hermes' });
    });
    // Hermes emits nothing for a call its hook blocked (probed 1.13a), so Cindy shows it.
    const showBlockedToolCall = (
      requestId: string,
      toolName: string,
      toolInput: Record<string, unknown>,
      why: string,
    ): void => {
      const toolUseId = `auto-review-${requestId}`;
      queue.push({ type: 'tool_use', data: { toolUseId, toolName, input: toolInput }, source: 'hermes' });
      queue.push({
        type: 'tool_result_full',
        data: { toolUseId, fullText: `Blocked by Auto-review: ${why}`, isError: true },
        source: 'hermes',
      });
      queue.push({ type: 'tool_result', data: { summary: 'failed', toolUseIds: [toolUseId] }, source: 'hermes' });
    };
    const reviewToolCall = async (raw: unknown): Promise<HermesApprovalRequestResult> => {
      const deny = (reason: string): HermesApprovalRequestResult => ({ kind: 'permission', behavior: 'deny', reason });
      const params = raw as HermesApprovalRequestParams | null;
      if (!params || params.kind !== 'permission' || typeof params.toolName !== 'string' || !params.toolName) {
        return deny('Cindy could not read this approval request.');
      }
      const toolName = params.toolName;
      const toolInput = params.input && typeof params.input === 'object' ? params.input : {};
      const requestId = typeof params.requestId === 'string' && params.requestId ? params.requestId : randomUUID();
      if (permissionModeNow !== 'auto') return deny('This task is no longer in Auto-review mode.');
      const action = normalizeHermesToolForAutoReview(toolName, toolInput);
      const request: AutoReviewRequest = {
        ...(input.cindySessionId ? { sessionId: input.cindySessionId } : {}),
        agentKind: 'hermes',
        providerId: input.providerId,
        model: currentModel,
        userIntent: autoReviewIntent ?? '',
        precedingBlockedActions: autoReviewActionContext.precedingBlockedActions,
        action,
        workspaceRoots: [input.workingDir],
        writableRoots: [input.workingDir],
        platform: process.platform,
      };
      const reviewer = this.deps.reviewAutoPermissionAction;
      const decision = await withAutoReviewContext(
        request,
        reviewer,
        (prepared) => resolveAutoReviewDecision(prepared, reviewer),
        (settled) => {
          autoReviewActionContext.record(action, settled);
          return settled;
        },
      );
      // The owner may have changed the mode while the review ran: follow the latest.
      const modeAfterReview = currentPermissionMode();
      if (modeAfterReview === 'bypassPermissions') return { kind: 'permission', behavior: 'allow' };
      if (modeAfterReview !== 'auto') return deny('This task is no longer in Auto-review mode.');
      if (decision.verdict === 'allow') return { kind: 'permission', behavior: 'allow' };
      if (decision.verdict === 'block') {
        const why = decision.reason?.trim() || 'Auto-review judged this action unsafe here.';
        showBlockedToolCall(requestId, toolName, toolInput, why);
        return deny(why);
      }
      if (decision.unavailable) autoReviewUnavailableNotice.notify();
      const resolver = interactionState.resolver;
      if (!resolver) {
        const why = 'Auto-review wanted your confirmation, but no confirmation window is available.';
        showBlockedToolCall(requestId, toolName, toolInput, why);
        return deny(why);
      }
      let answer: Awaited<ReturnType<InteractionResolver>>;
      try {
        answer = await resolver(annotatePermissionRequestForAutoReview({
          kind: 'permission' as const,
          requestId,
          toolUseId: requestId,
          toolName,
          input: toolInput,
        }, decision));
      } catch {
        const why = 'The confirmation was not answered.';
        showBlockedToolCall(requestId, toolName, toolInput, why);
        return deny(why);
      }
      if (answer.kind === 'permission' && answer.behavior === 'allow') return { kind: 'permission', behavior: 'allow' };
      const why = (answer.kind === 'permission' && answer.reason?.trim()) || 'You declined this action.';
      showBlockedToolCall(requestId, toolName, toolInput, why);
      return deny(why);
    };
    transport.setRequestHandler(HERMES_SERVER_METHODS.APPROVAL_REQUEST, reviewToolCall);

    const usageSnapshot = (): UsageSnapshot => ({
      tokenUsage: usage.tokenUsage,
      contextTokens: usage.contextTokens,
      contextWindow,
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
        case 'session-init':
          // The route this CLI process launched with. Remembered for the turn
          // so the done event can name the model the tokens were spent on.
          // The session id is not touched here: the daemon owns that binding.
          turnModel = normalized.model;
          return;
        case 'context-usage':
          turnPromptTokens = normalized.promptTokens;
          if (normalized.contextWindow !== undefined) {
            contextWindow = normalized.contextWindow;
          } else {
            const activeRoute = resolveModelRoute(currentModel);
            if (activeRoute?.contextLength) {
              contextWindow = activeRoute.contextLength;
            }
          }
          return;
        case 'compression':
          // Hermes compresses the context on its own mid-turn (ROADMAP 1.11, ADR 0010):
          // say so while it summarizes, then mark the boundary in the chat.
          if (normalized.phase === 'started') {
            queue.push({
              type: 'status',
              data: { status: 'Compacting context…', ...usageSnapshot(), isRunning: true },
              source: 'hermes',
            });
            return;
          }
          if (normalized.postTokens !== undefined) usage.contextTokens = normalized.postTokens;
          queue.push({
            type: 'compact_boundary',
            data: {
              boundaryId: `hermes-compression:${normalized.id}`,
              trigger: 'auto',
              ...(normalized.preTokens !== undefined ? { preTokens: normalized.preTokens } : {}),
              ...(normalized.postTokens !== undefined ? { postTokens: normalized.postTokens } : {}),
            },
            source: 'hermes',
          });
          // The divider above is local-only and did not show for Hermes live; this
          // one-liner is stored with the chat, like the resume-reset notice.
          queue.push({
            type: 'text',
            data: { text: compressionNotice(normalized.preTokens, normalized.postTokens), isFinal: true },
            source: 'hermes',
            standaloneText: true,
          });
          return;
        case 'resume-reset':
          // The daemon started this turn on a fresh session: the stored id vanished
          // from the Hermes home, or the permission flag changed (Hermes keeps
          // --yolo and --safe-mode sessions apart). Surface it as its own
          // durable one-liner so the transcript explains the missing history
          // instead of silently continuing without it.
          queue.push({
            type: 'text',
            data: {
              text: normalized.reason === 'permission-mode-changed'
                ? 'Permission mode changed, so this message starts a new Hermes session without the earlier history.'
                : 'Hermes no longer has the previous session, so this message starts a new one.',
              isFinal: true,
            },
            source: 'hermes',
            standaloneText: true,
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
          const userAborted = settledEpoch !== null && userAbortEpoch === settledEpoch;
          if (userAborted) userAbortEpoch = null;
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
          // Context = the last API call's prompt (daemon context-usage event).
          // Without it, fall back to `tokens.input`: a sum over every call of
          // the session (cache reads included), so it over-reports, which is
          // the safe direction for the context banner.
          usage.contextTokens = turnPromptTokens ?? tokens.input;
          turnPromptTokens = undefined;
          const succeeded = normalized.exitCode === 0;
          // A turn the user stopped reports a failing result (SIGINT → exit
          // code 130); that is the cancellation itself, not a provider fault.
          // Surfacing it as an error would show a banner over a deliberate
          // Stop and feed the desktop's turn-failure machinery (auto-resume,
          // provider-group failure decisions) on a healthy provider.
          if (!succeeded && !userAborted) {
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
              status: succeeded ? 'completed' : userAborted ? 'cancelled' : 'failed',
              ...(normalized.error && !userAborted ? { error: normalized.error } : {}),
              usage: {
                // `tokens.input` is the full prompt, cache reads included; the
                // desktop counts and prices `cacheReadTokens` separately, so
                // only the uncached part goes here.
                inputTokens: Math.max(0, tokens.input - tokens.cacheRead),
                outputTokens: tokens.output,
                cacheReadTokens: tokens.cacheRead,
                cacheCreationTokens: tokens.cacheWrite,
                ...(normalized.durationMs !== undefined
                  ? { durationMs: normalized.durationMs }
                  : {}),
                // The model the tokens were spent on, as the CLI reported it.
                // Without it the tokens cannot be priced at all.
                ...(turnModel ? { model: turnModel } : {}),
                ...(turnProviderId ? { provider: turnProviderId } : {}),
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
      // Whatever the reason, this turn is settling here; a recorded user-stop
      // intent belongs to it and must not leak into a later epoch.
      userAbortEpoch = null;
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

    const preflightRoute = this.deps.preflightHermesRoute ?? ((model: string) => preflightModelRoute(model));
    const resolveExpertPreamble = this.deps.resolveHermesExpertPreamble;
    // The current Cindy model id ('hermes-default' sentinel or an override).
    // Session.model reads it and expects it to follow successful switches.
    let currentModel = input.model;
    const handle: AgentSessionHandle = {
      // Maker persists this as sessions.sdk_session_id and feeds it back as
      // resumeSessionId. It must be the Hermes-native id or '' (fresh), never the
      // daemon's logical routing id.
      id: input.resumableSessionId,
      agentKind: 'hermes',
      get model(): string {
        return currentModel;
      },
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
        // Fail fast when the session's local/API endpoint is down or lacks the model,
        // instead of letting the Hermes CLI retry for minutes (ROADMAP 2.4c). Never
        // switches model: the owner decides what to use instead.
        const preflight = await preflightRoute(currentModel);
        if (!preflight.ok) throw new Error(preflight.message);
        turnProviderId = resolveModelRoute(currentModel)?.providerId;
        const expertPreamble = expertPreamblePending && input.cindySessionId && resolveExpertPreamble
          ? await resolveExpertPreamble({
            sessionId: input.cindySessionId,
            model: currentModel,
            ...(input.toolsets ? { toolsets: input.toolsets } : {}),
          })
          : null;
        const orcaPreamble = orcaPreambleFor();
        const orcaPreambleToSend = orcaPreamble && orcaPreamble !== lastSentOrcaPreamble ? orcaPreamble : null;
        const userText = await flattenUserMessage(message);
        const text = [expertPreamble, orcaPreambleToSend, userText].filter(Boolean).join('\n\n');
        // Auto-review judges tool calls against the owner's own words, never the preambles.
        autoReviewIntent = appendAutoReviewUserIntent(autoReviewIntent, message.content, sendOpts);
        autoReviewActionContext.advance(true);
        // Mark the turn before the RPC so a terminal notification arriving in
        // the same socket chunk cannot be cleared by the accepted-send path.
        const epoch = ++sendEpoch;
        const previousEpoch = activeEpoch;
        activeEpoch = epoch;
        // A new turn re-announces its route in its own `system/init`. Clear the
        // previous turn's model so a turn whose CLI never reached init cannot
        // inherit the last turn's model and be priced against it.
        turnModel = undefined;
        turnPromptTokens = undefined;
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
          expertPreamblePending = false;
          if (orcaPreambleToSend) lastSentOrcaPreamble = orcaPreambleToSend;
        } catch (error) {
          if (activeEpoch === epoch) activeEpoch = previousEpoch;
          throw error;
        }
      },
      async setVendorOptions(patch: Record<string, unknown>): Promise<void> {
        // Orca start_team/end_team (ROADMAP 3.7a): update in place so the next turn's
        // instructions and the bridge's tool-call identity both see the new role.
        Object.assign(liveVendorOptions, patch);
        input.setBridgeVendorOptions?.(patch);
      },
      async steer(): Promise<void> {
        throw new NotSupportedError('sameTurnSteer', {
          supported: false,
          reason: 'not-implemented',
        });
      },
      async abort(): Promise<void> {
        if (closedByUser || transport.isClosed()) return;
        // Mark the intent before the RPC: the failing terminal result of a
        // SIGINTed run can arrive while the interrupt request is still in
        // flight, and it must already settle as cancelled, not failed.
        if (activeEpoch !== null) userAbortEpoch = activeEpoch;
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
          try {
            input.disposeBridgeSession?.();
          } catch (error) {
            logger.warn('hermes bridge session dispose failed', { error: String(error) });
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
        permissionModeNow = mode;
        autoReviewUnavailableNotice.reset();
      },
      // Per-session model override, live for the *next* turn (each turn spawns
      // the CLI with the record's model; the home default route applies when the
      // override is absent). 'hermes-default' is Cindy's sentinel for "follow
      // the home default again" and maps to an empty override on the wire.
      async setModel(
        model: string,
        options?: {
          providerId?: string | null;
          effort?: Effort;
          thinkingEnabled?: boolean;
          contextWindowBudget?: number | null;
          provider?: string;
          baseUrl?: string;
          apiKey?: string;
        },
      ): Promise<void> {
        const trimmed = model.trim();
        if (!trimmed) throw new Error('hermes: model is required');
        const route = options?.baseUrl
          ? {
              provider: options.provider ?? 'custom',
              baseUrl: options.baseUrl,
              apiKey: options.apiKey,
              model: trimmed,
            }
          : resolveModelRoute(trimmed);
        const targetModel = trimmed === HERMES_DEFAULT_MODEL_ID ? '' : (route?.model ?? trimmed);
        await transport.request(HERMES_METHODS.QUERY_SET_MODEL, {
          sessionId,
          model: targetModel,
          ...(route?.provider ? { provider: route.provider } : {}),
          ...(route?.baseUrl ? { baseUrl: route.baseUrl } : {}),
          ...(route?.apiKey ? { apiKey: route.apiKey } : {}),
        });
        currentModel = trimmed;
        if (route && 'contextLength' in route && typeof route.contextLength === 'number' && route.contextLength > 0) {
          contextWindow = route.contextLength;
        }
      },
    };

    return handle;
  }
}
