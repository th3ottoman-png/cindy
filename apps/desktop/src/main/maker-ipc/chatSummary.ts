/**
 * Auto-summary note per conversation (ROADMAP 5.6): host and IPC.
 *
 * Runs the routed `summary` model when a conversation has been idle for a configured
 * duration (default 10 min) or when the conversation is closed.
 * Writes a concise markdown summary (decisions, facts learned, open questions, next steps)
 * to <vault>/Cindy/Memory/ linking the 5.5 chat file.
 *
 * Regenerated ONLY when the conversation has new turns since the last summary.
 * If `summary` is not routed in routing.yaml, fails open and quietly stays off (no silent fallback).
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  CONVERSATION_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_IDLE_MINUTES,
  buildSummaryUserPrompt,
  findSummaryFile,
  readSummaryConfig,
  readSummaryTurnsCount,
  writeConversationSummary,
  writeSummaryConfig,
} from '@cindy/maker-core/conversation-summary';
import { requestRoutedTaskText } from '@cindy/maker-core/routed-auxiliary';
import { buildExportSession, type StoredMessageInput } from '@cindy/maker-core/session-export';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ChatSummaryView {
  enabled: boolean;
  folder: string;
  idleMinutes: number;
  vaultDir: string;
  issue?: string;
  lastSummaryPath?: string;
  lastSummaryModel?: string;
  lastSummaryAt?: string;
  lastError?: string;
}

export interface ChatSummaryHostDeps {
  configFile?: string;
  harnessDir?: string;
  getVaultDir: () => string;
  getAutosaveFolder?: () => string;
  getSessionRow: (sessionId: string) => Promise<{
    title?: string | null;
    agentKind?: string | null;
    model?: string | null;
  } | null>;
  listMessages: (sessionId: string) => Promise<StoredMessageInput[]>;
  /** Fired when a summary note is successfully generated and written (no hidden state). */
  onWritten?: (info: { sessionId: string; path: string; model: string; routeName: string }) => void;
  /** Pushed once per failure streak, never on quiet off or when no vault is set. */
  onFailure?: (info: { sessionId: string; message: string }) => void;
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => Date;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function defaultChatSummaryConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'chat-summary.json');
}

export class ChatSummaryHost {
  private readonly configFile: string;
  private readonly harnessDir: string;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly chains = new Map<string, Promise<void>>();
  private failureShown = false;
  private lastSummaryPath?: string;
  private lastSummaryModel?: string;
  private lastSummaryAt?: string;
  private lastError?: string;

  constructor(private readonly deps: ChatSummaryHostDeps) {
    this.configFile = deps.configFile ?? defaultChatSummaryConfigFile();
    this.harnessDir = deps.harnessDir ?? path.join(os.homedir(), '.cindy-harness');
  }

  getConfig(): ChatSummaryView {
    const { config, issue } = readSummaryConfig(this.configFile);
    return {
      enabled: config.enabled,
      folder: config.folder,
      idleMinutes: config.idleMinutes,
      vaultDir: this.deps.getVaultDir(),
      ...(issue ? { issue } : {}),
      ...(this.lastSummaryPath ? { lastSummaryPath: this.lastSummaryPath } : {}),
      ...(this.lastSummaryModel ? { lastSummaryModel: this.lastSummaryModel } : {}),
      ...(this.lastSummaryAt ? { lastSummaryAt: this.lastSummaryAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  setConfig(request: unknown): ChatSummaryView {
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const current = readSummaryConfig(this.configFile).config;
    writeSummaryConfig(this.configFile, {
      enabled: typeof r.enabled === 'boolean' ? r.enabled : current.enabled,
      folder: typeof r.folder === 'string' ? r.folder : current.folder,
      idleMinutes: typeof r.idleMinutes === 'number' ? r.idleMinutes : current.idleMinutes,
    });
    this.failureShown = false;
    this.lastError = undefined;
    return this.getConfig();
  }

  /**
   * Called when a turn ends. Resets the idle timer for this session.
   */
  onTurnEnded(sessionId: string): void {
    if (!sessionId) return;
    const { config } = readSummaryConfig(this.configFile);
    if (!config.enabled) return;

    const pending = this.timers.get(sessionId);
    if (pending) clearTimeout(pending);

    const idleMs = (config.idleMinutes ?? DEFAULT_SUMMARY_IDLE_MINUTES) * 60 * 1000;
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.summarizeNow(sessionId);
      }, idleMs),
    );
  }

  /**
   * Called when a session is closed. Clears pending idle timer and triggers immediate summary.
   */
  onSessionClosed(sessionId: string): void {
    if (!sessionId) return;
    const pending = this.timers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(sessionId);
    }
    const { config } = readSummaryConfig(this.configFile);
    if (!config.enabled) return;
    void this.summarizeNow(sessionId);
  }

  /**
   * Summarize this session now, serialized per session. Never throws.
   */
  summarizeNow(sessionId: string): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.summarize(sessionId));
    this.chains.set(sessionId, next);
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
    return next;
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async summarize(sessionId: string): Promise<void> {
    try {
      const { config } = readSummaryConfig(this.configFile);
      if (!config.enabled) return;

      const vaultDir = this.deps.getVaultDir();
      if (!vaultDir) {
        this.deps.log?.debug?.('chat summary skipped: no vault configured', { sessionId });
        return;
      }

      const row = await this.deps.getSessionRow(sessionId);
      if (!row) return;

      const rows = await this.deps.listMessages(sessionId);
      const session = buildExportSession(
        { title: row.title ?? '', agent: row.agentKind ?? '', model: row.model ?? undefined },
        rows ?? [],
      );
      if (session.messages.length === 0) return;

      // Check if existing summary note is already up to date
      const targetDir = path.join(vaultDir, ...config.folder.split('/'));
      const existing = findSummaryFile(targetDir, sessionId);
      if (existing) {
        const turnsSummarized = readSummaryTurnsCount(existing);
        if (turnsSummarized !== undefined && session.messages.length <= turnsSummarized) {
          this.deps.log?.debug?.('chat summary skipped: already up to date', {
            sessionId,
            turnsCount: session.messages.length,
            turnsSummarized,
          });
          return;
        }
      }

      // Query routed summary model
      const prompt = buildSummaryUserPrompt(session);
      const routed = await requestRoutedTaskText(
        {
          taskClass: 'summary',
          prompt,
          systemPrompt: CONVERSATION_SUMMARY_SYSTEM_PROMPT,
          maxTokens: 1024,
          timeoutMs: 45_000,
        },
        {
          harnessDir: this.harnessDir,
          env: this.deps.env ?? process.env,
          fetchImpl: this.deps.fetchImpl ?? fetch,
        },
      );

      if (routed.kind === 'not-routed') {
        this.deps.log?.debug?.('chat summary skipped: task "summary" is not routed', { sessionId });
        return;
      }

      if (routed.kind === 'blocked') {
        this.deps.log?.warn('chat summary route blocked (no silent fallback)', {
          sessionId,
          reason: routed.reason,
          message: routed.message,
        });
        return;
      }

      if (routed.kind === 'failed') {
        this.fail(sessionId, routed.message);
        return;
      }

      // routed.kind === 'ok'
      const now = (this.deps.now ?? (() => new Date()))();
      const res = writeConversationSummary({
        vaultDir,
        folder: config.folder,
        sessionId,
        session,
        summaryText: routed.text,
        model: routed.model,
        provider: routed.provider,
        routeName: routed.routeName,
        summarizedAt: now,
        autosaveFolder: this.deps.getAutosaveFolder?.(),
      });

      if (res.ok) {
        this.lastSummaryPath = res.path;
        this.lastSummaryModel = routed.routeName || routed.model;
        this.lastSummaryAt = now.toISOString();
        this.lastError = undefined;
        this.failureShown = false;
        this.deps.log?.info?.('chat summary note written', {
          sessionId,
          path: res.path,
          model: routed.model,
          routeName: routed.routeName,
        });
        this.deps.onWritten?.({
          sessionId,
          path: res.path,
          model: routed.model,
          routeName: routed.routeName,
        });
        return;
      }

      if (res.reason === 'no-vault') {
        this.deps.log?.debug?.('chat summary skipped: vault folder missing', {
          sessionId,
          message: res.message,
        });
        return;
      }

      this.fail(sessionId, res.message);
    } catch (err) {
      this.fail(sessionId, err instanceof Error ? err.message : String(err));
    }
  }

  private fail(sessionId: string, message: string): void {
    this.lastError = message;
    this.deps.log?.warn('chat summary failed', { sessionId, message });
    if (this.failureShown) return;
    this.failureShown = true;
    try {
      this.deps.onFailure?.({ sessionId, message });
    } catch {
      // Ignore broadcast errors
    }
  }
}

export function registerChatSummaryHandlers(
  registry: IpcHandlerRegistry,
  deps: { host: ChatSummaryHost; assertTrusted: (event: unknown) => void },
): void {
  registry.handle(MAKER_INVOKE.CHAT_SUMMARY_GET_CONFIG, (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });
  registry.handle(MAKER_INVOKE.CHAT_SUMMARY_SET_CONFIG, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    return deps.host.setConfig(request);
  });
  registry.handle(MAKER_INVOKE.CHAT_SUMMARY_TRIGGER_NOW, (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    if (typeof sessionId === 'string' && sessionId) {
      return deps.host.summarizeNow(sessionId);
    }
    return Promise.resolve();
  });
}
