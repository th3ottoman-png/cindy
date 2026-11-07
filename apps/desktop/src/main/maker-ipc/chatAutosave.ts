/**
 * Auto-save every conversation to the notes vault (ROADMAP 5.5): host and IPC.
 *
 * `register.ts` calls `onTurnEnded(sessionId)` from its single turn-end point (after the message
 * persist queue has drained), for every agent. Saves are debounced per session and serialized,
 * and never block or fail the turn: no vault → quietly off; a write error is logged every time
 * and pushed to the renderer once (until a save succeeds or the settings change).
 *
 * Settings live in their own file, `~/.cindy-harness/chat-autosave.json`, so the 5.1 vault
 * writer (which rewrites `vault.json` whole) cannot drop them.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  readAutosaveConfig,
  writeAutosaveConfig,
  writeChatAutosave,
} from '@cindy/maker-core/chat-autosave';
import { buildExportSession, type StoredMessageInput } from '@cindy/maker-core/session-export';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export const CHAT_AUTOSAVE_DEBOUNCE_MS = 1500;

export interface ChatAutosaveView {
  enabled: boolean;
  folder: string;
  /** The vault from 5.1 settings; empty when none is configured. */
  vaultDir: string;
  issue?: string;
  lastSavedPath?: string;
  lastError?: string;
}

export interface ChatAutosaveHostDeps {
  configFile?: string;
  getVaultDir: () => string;
  getSessionRow: (sessionId: string) => Promise<{
    title?: string | null;
    agentKind?: string | null;
    model?: string | null;
  } | null>;
  listMessages: (sessionId: string) => Promise<StoredMessageInput[]>;
  /** Pushed once per failure streak, never on success or when no vault is set. */
  onFailure?: (message: string) => void;
  log?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => Date;
  debounceMs?: number;
}

export function defaultChatAutosaveConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'chat-autosave.json');
}

export class ChatAutosaveHost {
  private readonly configFile: string;
  private readonly debounceMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly chains = new Map<string, Promise<void>>();
  private failureShown = false;
  private lastSavedPath?: string;
  private lastError?: string;

  constructor(private readonly deps: ChatAutosaveHostDeps) {
    this.configFile = deps.configFile ?? defaultChatAutosaveConfigFile();
    this.debounceMs = deps.debounceMs ?? CHAT_AUTOSAVE_DEBOUNCE_MS;
  }

  getConfig(): ChatAutosaveView {
    const { config, issue } = readAutosaveConfig(this.configFile);
    return {
      enabled: config.enabled,
      folder: config.folder,
      vaultDir: this.deps.getVaultDir(),
      ...(issue ? { issue } : {}),
      ...(this.lastSavedPath ? { lastSavedPath: this.lastSavedPath } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  setConfig(request: unknown): ChatAutosaveView {
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const current = readAutosaveConfig(this.configFile).config;
    writeAutosaveConfig(this.configFile, {
      enabled: typeof r.enabled === 'boolean' ? r.enabled : current.enabled,
      folder: typeof r.folder === 'string' ? r.folder : current.folder,
    });
    this.failureShown = false;
    this.lastError = undefined;
    return this.getConfig();
  }

  /** Called at every turn end. Cheap when the feature is off. */
  onTurnEnded(sessionId: string): void {
    if (!sessionId) return;
    if (!readAutosaveConfig(this.configFile).config.enabled) return;
    const pending = this.timers.get(sessionId);
    if (pending) clearTimeout(pending);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.saveNow(sessionId);
      }, this.debounceMs),
    );
  }

  /** Save one session now, after any save already running for it. Never throws. */
  saveNow(sessionId: string): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.save(sessionId));
    this.chains.set(sessionId, next);
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
    return next;
  }

  /** Stop pending timers (app quit). Pending saves are dropped; the next turn end re-saves. */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async save(sessionId: string): Promise<void> {
    try {
      const { config } = readAutosaveConfig(this.configFile);
      if (!config.enabled) return;
      const vaultDir = this.deps.getVaultDir();
      if (!vaultDir) {
        this.deps.log?.debug?.('chat autosave skipped: no vault configured', { sessionId });
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
      const res = writeChatAutosave(
        vaultDir,
        config.folder,
        sessionId,
        session,
        (this.deps.now ?? (() => new Date()))(),
      );
      if (res.ok) {
        this.lastSavedPath = res.path;
        this.lastError = undefined;
        this.failureShown = false;
        return;
      }
      if (res.reason === 'no-vault') {
        this.deps.log?.debug?.('chat autosave skipped: vault folder missing', {
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
    this.deps.log?.warn('chat autosave failed', { sessionId, message });
    if (this.failureShown) return;
    this.failureShown = true;
    try {
      this.deps.onFailure?.(message);
    } catch {
      // A broken push must not surface into the turn.
    }
  }
}

export function registerChatAutosaveHandlers(
  registry: IpcHandlerRegistry,
  deps: { host: ChatAutosaveHost; assertTrusted: (event: unknown) => void },
): void {
  registry.handle(MAKER_INVOKE.CHAT_AUTOSAVE_GET_CONFIG, (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });
  registry.handle(MAKER_INVOKE.CHAT_AUTOSAVE_SET_CONFIG, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    return deps.host.setConfig(request);
  });
}
