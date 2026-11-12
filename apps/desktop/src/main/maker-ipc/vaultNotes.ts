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
import {
  resolveProjectName,
  parseGitLogOneline,
  parseGitStatusShort,
  matchVaultProjectNote,
  formatGitProgressBlock,
  syncGitProgressToVault,
  type GitWorkspaceInspection,
} from '@cindy/maker-core/vault-git-sync';

import {
  buildRelevantAdrsPreamble,
  getSessionAdrs,
  matchAdrsForPrompt,
  setSessionAdrs,
  type SessionAdrsEntry,
} from '@cindy/maker-core/vault-adr';

import { gitExec } from '../worktree/gitExec.js';
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
  /** ROADMAP 11.8: per-session record of the ADRs injected at session start. */
  sessionAdrsFile?: string;
  embeddingsDbFile?: string;
  sqliteFactory?: (file: string) => Database.Database;
  embedder?: EmbeddingClient;
  showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  notifyChanged?: () => void;
  watchDebounceMs?: number;
  gitExecFn?: typeof gitExec;
}

export function defaultVaultConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'vault.json');
}

export function defaultPinnedNotesConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'pinned-vault-notes.json');
}

export function defaultSessionAdrsFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'session-adrs.json');
}

export function defaultVaultEmbeddingsFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'vault-embeddings.db');
}

export class VaultNotesHost {
  private readonly configFile: string;
  private readonly pinnedNotesConfigFile: string;
  private readonly sessionAdrsFile: string;
  private readonly embeddingsDbFile: string;
  private readonly sqliteFactory: (file: string) => Database.Database;
  private readonly embedder?: EmbeddingClient;
  private readonly showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  private readonly notifyChanged?: () => void;
  private readonly watchDebounceMs: number;
  private readonly gitExecFn?: typeof gitExec;
  private watcher: VaultWatcher | null = null;
  private currentWatchedDir: string = '';
  private cachedGraph: VaultGraph | null = null;
  private semanticIndex: VaultSemanticIndex | null = null;

  constructor(deps: VaultNotesHostDeps = {}) {
    this.configFile = deps.configFile ?? defaultVaultConfigFile();
    this.pinnedNotesConfigFile = deps.pinnedNotesConfigFile ?? defaultPinnedNotesConfigFile();
    this.sessionAdrsFile = deps.sessionAdrsFile ?? defaultSessionAdrsFile();
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
    this.gitExecFn = deps.gitExecFn;
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

  /** ROADMAP 11.8: the ADRs injected into this session's first turn, and its workspace. */
  getSessionAdrs(sessionId: string): SessionAdrsEntry {
    return getSessionAdrs(this.sessionAdrsFile, sessionId);
  }

  /**
   * ROADMAP 11.8: keyword-match past ADRs (vault `Cindy/Decisions/` + the workspace's
   * `docs/decisions/`) against the first prompt of a fresh session. Records what matched so the
   * manifest strip shows it, and returns the titles block for that turn. Convenience feature, so it
   * fails open: any error means no block, never a refused turn.
   */
  resolveRelevantAdrsPreamble(input: {
    sessionId: string;
    prompt?: string;
    workingDir?: string;
  }): string {
    try {
      const cfg = this.getConfig();
      const vaultDir = cfg.issue ? '' : cfg.vaultDir;
      const adrs = input.prompt
        ? matchAdrsForPrompt(input.prompt, vaultDir, { repoDir: input.workingDir })
        : [];
      setSessionAdrs(this.sessionAdrsFile, input.sessionId, {
        workspaceDir: input.workingDir,
        adrs,
      });
      return buildRelevantAdrsPreamble(adrs);
    } catch {
      return '';
    }
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

  async inspectGitWorkspace(workspaceDir?: string): Promise<{
    ok: boolean;
    inspection?: GitWorkspaceInspection;
    targetNotePath?: string;
    matchType?: 'exact' | 'heuristic' | 'default';
    error?: string;
  }> {
    const cwd = workspaceDir?.trim() || process.cwd();
    const runGit = this.gitExecFn ?? gitExec;
    try {
      const topLevelRes = await runGit(['rev-parse', '--show-toplevel'], cwd, { timeoutMs: 5000 });
      const rootDir = topLevelRes.stdout.trim() || cwd;
      const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], rootDir, { timeoutMs: 5000 });
      const branch = branchRes.stdout.trim() || 'HEAD';
      const logRes = await runGit(['log', '-n', '5', '--pretty=format:%h%x09%s%x09%an%x09%cs'], rootDir, { timeoutMs: 5000 });
      const statusRes = await runGit(['status', '--porcelain=v1'], rootDir, { timeoutMs: 5000 });

      const commits = parseGitLogOneline(logRes.stdout, 5);
      const status = parseGitStatusShort(statusRes.stdout);
      const projectName = resolveProjectName(rootDir);

      const inspection: GitWorkspaceInspection = {
        projectName,
        workspaceDir: rootDir,
        branch,
        recentCommits: commits,
        staged: status.staged,
        modified: status.modified,
        untracked: status.untracked,
        totalDirty: status.totalDirty,
      };

      const cfg = this.getConfig();
      let targetNotePath = `memory/Project — ${projectName}.md`;
      let matchType: 'exact' | 'heuristic' | 'default' = 'default';

      if (cfg.vaultDir && !cfg.issue) {
        const notes = listNotes(cfg.vaultDir);
        if (Array.isArray(notes)) {
          const matched = matchVaultProjectNote(
            notes.map((n) => n.path),
            projectName,
          );
          targetNotePath = matched.notePath;
          matchType = matched.matchType;
        }
      }

      return {
        ok: true,
        inspection,
        targetNotePath,
        matchType,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message || 'Failed to inspect git workspace',
      };
    }
  }

  async applyGitWorkspaceSync(options: {
    workspaceDir?: string;
    targetNotePath?: string;
    summaryNote?: string;
  } = {}): Promise<{
    ok: boolean;
    path?: string;
    created?: boolean;
    block?: string;
    error?: string;
  }> {
    const inspected = await this.inspectGitWorkspace(options.workspaceDir);
    if (!inspected.ok || !inspected.inspection) {
      return { ok: false, error: inspected.error ?? 'Failed to inspect git workspace' };
    }

    const cfg = this.getConfig();
    if (cfg.issue || !cfg.vaultDir) {
      return { ok: false, error: cfg.issue || 'No notes vault configured in Settings -> Notes Vault' };
    }

    const targetNote = options.targetNotePath?.trim() || inspected.targetNotePath;
    const syncRes = syncGitProgressToVault(cfg.vaultDir, inspected.inspection, {
      targetNotePath: targetNote,
      summaryNote: options.summaryNote,
    });

    if (!syncRes.ok) {
      return { ok: false, error: syncRes.message };
    }

    this.notifyChanged?.();
    return {
      ok: true,
      path: syncRes.path,
      created: syncRes.created,
      block: syncRes.block,
    };
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
  registry.handle(MAKER_INVOKE.VAULT_GET_SESSION_ADRS, async (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getSessionAdrs(String(sessionId ?? ''));
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
  registry.handle(MAKER_INVOKE.VAULT_GIT_SYNC_INSPECT, async (event: unknown, workspaceDir?: unknown) => {
    deps.assertTrusted(event);
    return deps.host.inspectGitWorkspace(typeof workspaceDir === 'string' ? workspaceDir : undefined);
  });
  registry.handle(MAKER_INVOKE.VAULT_GIT_SYNC_APPLY, async (event: unknown, options?: unknown) => {
    deps.assertTrusted(event);
    const opts = (options && typeof options === 'object' ? options : {}) as {
      workspaceDir?: string;
      targetNotePath?: string;
      summaryNote?: string;
    };
    const res = await deps.host.applyGitWorkspaceSync(opts);
    if (res.ok) {
      deps.broadcast(MAKER_PUSH.VAULT_CHANGED, deps.host.getConfig());
    }
    return res;
  });
}

let desktopVaultNotesHost: VaultNotesHost | null = null;

export function getDesktopVaultNotesHost(deps?: VaultNotesHostDeps): VaultNotesHost {
  if (!desktopVaultNotesHost || deps) {
    desktopVaultNotesHost = new VaultNotesHost(deps);
  }
  return desktopVaultNotesHost;
}

