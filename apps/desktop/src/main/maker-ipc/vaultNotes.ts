/**
 * Local notes vault bridge host and IPC support (ROADMAP 5.1).
 *
 * Persists the notes vault path in ~/.cindy-harness/vault.json.
 * Validates that the vault directory exists and is a directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import {
  listNotes,
  readVaultConfig,
  watchVault,
  writeVaultConfig,
  type NoteError,
  type SearchHit,
  type VaultWatcher,
} from '@cindy/maker-core/vault-notes';
import { runVaultSynthesis, type VaultSynthesisResult } from '@cindy/maker-core/vault-synthesis';
import { scanVaultGraph, type VaultGraph } from '@cindy/maker-core/vault-graph';
import {
  quickCaptureNote,
  pinNoteToSession,
  unpinNoteFromSession,
  getPinnedNotesForSession,
  buildPinnedNotesPreamble,
  type QuickCaptureInput,
  type QuickCaptureResult,
} from '@cindy/maker-core/vault-capture';
import {
  VaultSemanticIndex,
  hybridSearchVault,
  type EmbeddingClient,
  type HybridSearchOptions,
} from '@cindy/maker-core/vault-semantic';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface VaultConfigView {
  vaultDir: string;
  allSessionsSearch?: boolean;
  issue?: string;
  noteCount?: number;
}

export interface VaultNotesHostDeps {
  configFile?: string;
  pinnedNotesConfigFile?: string;
  embeddingsDbFile?: string;
  sqliteFactory?: (file: string) => Database.Database;
  embedder?: EmbeddingClient;
  showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  notifyChanged?: () => void;
  watchDebounceMs?: number;
}

export function defaultVaultConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'vault.json');
}

export function defaultPinnedNotesConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'pinned-vault-notes.json');
}

export function defaultVaultEmbeddingsFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'vault-embeddings.db');
}

export class VaultNotesHost {
  private readonly configFile: string;
  private readonly pinnedNotesConfigFile: string;
  private readonly embeddingsDbFile: string;
  private readonly sqliteFactory: (file: string) => Database.Database;
  private readonly embedder?: EmbeddingClient;
  private readonly showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  private readonly notifyChanged?: () => void;
  private readonly watchDebounceMs: number;
  private watcher: VaultWatcher | null = null;
  private currentWatchedDir: string = '';
  private cachedGraph: VaultGraph | null = null;
  private semanticIndex: VaultSemanticIndex | null = null;

  constructor(deps: VaultNotesHostDeps = {}) {
    this.configFile = deps.configFile ?? defaultVaultConfigFile();
    this.pinnedNotesConfigFile = deps.pinnedNotesConfigFile ?? defaultPinnedNotesConfigFile();
    this.embeddingsDbFile = deps.embeddingsDbFile ?? defaultVaultEmbeddingsFile();
    this.sqliteFactory =
      deps.sqliteFactory ??
      ((file: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return new Database(file);
      });
    this.embedder = deps.embedder;
    this.showOpenDialog = deps.showOpenDialog;
    this.notifyChanged = deps.notifyChanged;
    this.watchDebounceMs = deps.watchDebounceMs ?? 150;
    this.armWatcher();
  }

  private armWatcher(): void {
    const { config, issue } = readVaultConfig(this.configFile);
    const targetDir = (!issue && config.vaultDir) ? config.vaultDir : '';
    if (targetDir === this.currentWatchedDir && this.watcher) {
      return;
    }
    this.watcher?.close();
    this.watcher = null;
    this.cachedGraph = null;
    this.currentWatchedDir = targetDir;
    if (targetDir) {
      this.watcher = watchVault(
        targetDir,
        () => {
          this.cachedGraph = null;
          this.notifyChanged?.();
        },
        this.watchDebounceMs,
      );
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.currentWatchedDir = '';
  }

  getConfig(): VaultConfigView {
    const { config, issue } = readVaultConfig(this.configFile);
    if (!config.vaultDir) {
      return {
        vaultDir: '',
        ...(config.allSessionsSearch !== undefined ? { allSessionsSearch: config.allSessionsSearch } : {}),
        ...(issue ? { issue } : {}),
      };
    }
    if (issue) {
      return {
        vaultDir: config.vaultDir,
        ...(config.allSessionsSearch !== undefined ? { allSessionsSearch: config.allSessionsSearch } : {}),
        issue,
      };
    }
    const notes = listNotes(config.vaultDir);
    const noteCount = Array.isArray(notes) ? notes.length : undefined;
    return {
      vaultDir: config.vaultDir,
      allSessionsSearch: config.allSessionsSearch,
      noteCount,
    };
  }

  setConfig(patch: string | { vaultDir?: string; allSessionsSearch?: boolean }): VaultConfigView {
    const current = readVaultConfig(this.configFile).config;
    let nextVaultDir = current.vaultDir;
    let nextAllSessionsSearch = current.allSessionsSearch;

    if (typeof patch === 'string') {
      nextVaultDir = patch.trim();
    } else if (patch && typeof patch === 'object') {
      if (typeof patch.vaultDir === 'string') {
        nextVaultDir = patch.vaultDir.trim();
      }
      if (typeof patch.allSessionsSearch === 'boolean') {
        nextAllSessionsSearch = patch.allSessionsSearch;
      }
    } else {
      throw new Error('vaultDir must be a string or config object');
    }

    writeVaultConfig(this.configFile, {
      vaultDir: nextVaultDir,
      ...(nextAllSessionsSearch !== undefined ? { allSessionsSearch: nextAllSessionsSearch } : {}),
    });
    this.armWatcher();
    this.notifyChanged?.();
    return this.getConfig();
  }

  async pickFolder(): Promise<string | null> {
    if (!this.showOpenDialog) return null;
    const res = await this.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0];
  }

  synthesizeMemory(opts?: { limit?: number; targetFile?: string }): VaultSynthesisResult {
    const cfg = this.getConfig();
    if (cfg.issue || !cfg.vaultDir) {
      return { ok: false, reason: 'no-vault', message: 'no valid notes vault configured' };
    }
    return runVaultSynthesis(cfg.vaultDir, opts);
  }

  getGraph(forceRefresh?: boolean): { ok: boolean; graph?: VaultGraph; error?: string } {
    const cfg = this.getConfig();
    if (cfg.issue || !cfg.vaultDir) {
      return { ok: false, error: 'no-vault' };
    }
    if (!this.cachedGraph || forceRefresh) {
      this.cachedGraph = scanVaultGraph(cfg.vaultDir);
    }
    return { ok: true, graph: this.cachedGraph };
  }

  quickCapture(input: QuickCaptureInput): QuickCaptureResult {
    const cfg = this.getConfig();
    if (cfg.issue || !cfg.vaultDir) {
      return { ok: false, reason: 'no-vault', message: 'no valid notes vault configured' };
    }
    const res = quickCaptureNote(cfg.vaultDir, input);
    if (res.ok) {
      this.cachedGraph = null;
      this.notifyChanged?.();
    }
    return res;
  }

  getPinnedNotes(sessionId: string): string[] {
    return getPinnedNotesForSession(this.pinnedNotesConfigFile, sessionId);
  }

  pinNote(sessionId: string, notePath: string): { ok: boolean; pinnedNotes: string[]; error?: string } {
    return pinNoteToSession(this.pinnedNotesConfigFile, sessionId, notePath);
  }

  unpinNote(sessionId: string, notePath: string): { ok: boolean; pinnedNotes: string[] } {
    return unpinNoteFromSession(this.pinnedNotesConfigFile, sessionId, notePath);
  }

  getPinnedNotesPreamble(sessionId: string, maxCharsPerNote?: number): string {
    const cfg = this.getConfig();
    if (cfg.issue || !cfg.vaultDir) return '';
    const pinned = this.getPinnedNotes(sessionId);
    return buildPinnedNotesPreamble(cfg.vaultDir, pinned, maxCharsPerNote);
  }

  getSemanticIndex(): VaultSemanticIndex | null {
    if (this.semanticIndex) return this.semanticIndex;
    try {
      const db = this.sqliteFactory(this.embeddingsDbFile);
      this.semanticIndex = new VaultSemanticIndex(db, this.embedder);
      this.semanticIndex.init();
      return this.semanticIndex;
    } catch {
      return null;
    }
  }

  async searchNotes(
    query: string,
    opts: HybridSearchOptions = {},
  ): Promise<SearchHit[] | NoteError> {
    const cfg = this.getConfig();
    if (cfg.issue || !cfg.vaultDir) {
      return { ok: false, reason: 'no-vault', message: 'no valid notes vault configured' };
    }
    const idx = this.getSemanticIndex();
    return hybridSearchVault(cfg.vaultDir, query, idx, opts);
  }

  async indexEmbeddings(): Promise<{ indexed: number; skipped: number; pruned: number }> {
    const cfg = this.getConfig();
    if (cfg.issue || !cfg.vaultDir) {
      return { indexed: 0, skipped: 0, pruned: 0 };
    }
    const idx = this.getSemanticIndex();
    if (!idx) return { indexed: 0, skipped: 0, pruned: 0 };
    return idx.syncVault(cfg.vaultDir);
  }
}

export interface VaultNotesHandlerDeps {
  host: VaultNotesHost;
  assertTrusted(event: unknown): void;
  broadcast(channel: string, payload?: unknown): void;
}

export function registerVaultNotesHandlers(
  registry: IpcHandlerRegistry,
  deps: VaultNotesHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.VAULT_GET_CONFIG, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });
  registry.handle(MAKER_INVOKE.VAULT_SET_CONFIG, async (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    let patch: string | { vaultDir?: string; allSessionsSearch?: boolean };
    if (typeof request === 'string') {
      patch = request;
    } else {
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      patch = {
        ...(typeof r.vaultDir === 'string' ? { vaultDir: r.vaultDir } : {}),
        ...(typeof r.allSessionsSearch === 'boolean' ? { allSessionsSearch: r.allSessionsSearch } : {}),
      };
    }
    const fresh = deps.host.setConfig(patch);
    deps.broadcast(MAKER_PUSH.VAULT_CHANGED, fresh);
    return fresh;
  });
  registry.handle(MAKER_INVOKE.VAULT_PICK_FOLDER, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.pickFolder();
  });
  registry.handle(MAKER_INVOKE.VAULT_SYNTHESIZE_MEMORY, async (event: unknown, opts: unknown) => {
    deps.assertTrusted(event);
    const options = (opts && typeof opts === 'object' ? opts : {}) as { limit?: number; targetFile?: string };
    const res = deps.host.synthesizeMemory(options);
    if (res.ok) {
      deps.broadcast(MAKER_PUSH.VAULT_CHANGED, deps.host.getConfig());
    }
    return res;
  });
  registry.handle(MAKER_INVOKE.VAULT_GET_GRAPH, async (event: unknown, force?: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getGraph(Boolean(force));
  });
  registry.handle(MAKER_INVOKE.VAULT_QUICK_CAPTURE, async (event: unknown, input: unknown) => {
    deps.assertTrusted(event);
    const captureInput = (input && typeof input === 'object' ? input : {}) as QuickCaptureInput;
    const res = deps.host.quickCapture(captureInput);
    if (res.ok) {
      deps.broadcast(MAKER_PUSH.VAULT_CHANGED, deps.host.getConfig());
    }
    return res;
  });
  registry.handle(MAKER_INVOKE.VAULT_GET_PINNED_NOTES, async (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getPinnedNotes(String(sessionId ?? ''));
  });
  registry.handle(MAKER_INVOKE.VAULT_PIN_NOTE, async (event: unknown, payload: unknown) => {
    deps.assertTrusted(event);
    const { sessionId, notePath } = (payload && typeof payload === 'object' ? payload : {}) as {
      sessionId: string;
      notePath: string;
    };
    const res = deps.host.pinNote(sessionId, notePath);
    if (res.ok) {
      deps.broadcast(MAKER_PUSH.VAULT_PINNED_CHANGED, { sessionId, pinnedNotes: res.pinnedNotes });
    }
    return res;
  });
  registry.handle(MAKER_INVOKE.VAULT_UNPIN_NOTE, async (event: unknown, payload: unknown) => {
    deps.assertTrusted(event);
    const { sessionId, notePath } = (payload && typeof payload === 'object' ? payload : {}) as {
      sessionId: string;
      notePath: string;
    };
    const res = deps.host.unpinNote(sessionId, notePath);
    if (res.ok) {
      deps.broadcast(MAKER_PUSH.VAULT_PINNED_CHANGED, { sessionId, pinnedNotes: res.pinnedNotes });
    }
    return res;
  });
  registry.handle(MAKER_INVOKE.VAULT_SEARCH_NOTES, async (event: unknown, input: unknown) => {
    deps.assertTrusted(event);
    const p = (input && typeof input === 'object' ? input : {}) as {
      query?: unknown;
      limit?: unknown;
    };
    const query = typeof p.query === 'string' ? p.query : '';
    const limit = typeof p.limit === 'number' ? p.limit : undefined;
    return deps.host.searchNotes(query, { limit });
  });
  registry.handle(MAKER_INVOKE.VAULT_INDEX_EMBEDDINGS, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.indexEmbeddings();
  });
}

let desktopVaultNotesHost: VaultNotesHost | null = null;

export function getDesktopVaultNotesHost(deps?: VaultNotesHostDeps): VaultNotesHost {
  if (!desktopVaultNotesHost || deps) {
    desktopVaultNotesHost = new VaultNotesHost(deps);
  }
  return desktopVaultNotesHost;
}

