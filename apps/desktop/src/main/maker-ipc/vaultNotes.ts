/**
 * Local notes vault bridge host and IPC support (ROADMAP 5.1).
 *
 * Persists the notes vault path in ~/.cindy-harness/vault.json.
 * Validates that the vault directory exists and is a directory.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  listNotes,
  readVaultConfig,
  writeVaultConfig,
} from '@cindy/maker-core/vault-notes';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface VaultConfigView {
  vaultDir: string;
  issue?: string;
  noteCount?: number;
}

export interface VaultNotesHostDeps {
  configFile?: string;
  showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  notifyChanged?: () => void;
}

export function defaultVaultConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'vault.json');
}

export class VaultNotesHost {
  private readonly configFile: string;
  private readonly showOpenDialog?: (options: { properties: ('openDirectory' | 'createDirectory')[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  private readonly notifyChanged?: () => void;

  constructor(deps: VaultNotesHostDeps = {}) {
    this.configFile = deps.configFile ?? defaultVaultConfigFile();
    this.showOpenDialog = deps.showOpenDialog;
    this.notifyChanged = deps.notifyChanged;
  }

  getConfig(): VaultConfigView {
    const { config, issue } = readVaultConfig(this.configFile);
    if (!config.vaultDir) {
      return { vaultDir: '', ...(issue ? { issue } : {}) };
    }
    if (issue) {
      return { vaultDir: config.vaultDir, issue };
    }
    const notes = listNotes(config.vaultDir);
    const noteCount = Array.isArray(notes) ? notes.length : undefined;
    return {
      vaultDir: config.vaultDir,
      noteCount,
    };
  }

  setConfig(vaultDir: string): VaultConfigView {
    if (typeof vaultDir !== 'string') {
      throw new Error('vaultDir must be a string');
    }
    writeVaultConfig(this.configFile, { vaultDir: vaultDir.trim() });
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
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const fresh = deps.host.setConfig(typeof r.vaultDir === 'string' ? r.vaultDir : '');
    deps.broadcast(MAKER_PUSH.VAULT_CHANGED, fresh);
    return fresh;
  });
  registry.handle(MAKER_INVOKE.VAULT_PICK_FOLDER, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.pickFolder();
  });
}

let desktopVaultNotesHost: VaultNotesHost | null = null;

export function getDesktopVaultNotesHost(deps?: VaultNotesHostDeps): VaultNotesHost {
  if (!desktopVaultNotesHost || deps) {
    desktopVaultNotesHost = new VaultNotesHost(deps);
  }
  return desktopVaultNotesHost;
}

