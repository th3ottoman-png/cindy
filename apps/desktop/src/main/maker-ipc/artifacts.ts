/**
 * Artifact store host (ROADMAP 8.5b).
 *
 * Local-first, file-backed artifact management within the configured notes vault.
 * Coordinates list, save, read, and delete operations over `<vault>/Cindy/Artifacts/`
 * via `@cindy/maker-core/artifact-store`.
 *
 * Emits `MAKER_PUSH.VAULT_CHANGED` on mutations so the vault file watcher,
 * graph, and Library index stay in sync.
 */

import {
  deleteArtifact,
  listArtifacts,
  readArtifact,
  saveArtifact,
  type SaveArtifactInput,
  type StoredArtifact,
  type StoredArtifactHeader,
} from '@cindy/maker-core/artifact-store';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ArtifactsHandlerDeps {
  getVaultDir(): string;
  assertTrusted(event: unknown): void;
  broadcast(channel: string, payload?: unknown): void;
}

export class ArtifactsHost {
  constructor(private readonly deps: ArtifactsHandlerDeps) {}

  private resolveVault(overrideVault?: string): string {
    const vault = overrideVault || this.deps.getVaultDir();
    if (!vault || !vault.trim()) {
      throw new Error('No notes vault configured');
    }
    return vault;
  }

  list(vaultDir?: string): { ok: boolean; artifacts: StoredArtifactHeader[]; error?: string } {
    try {
      const vault = this.resolveVault(vaultDir);
      const artifacts = listArtifacts(vault);
      return { ok: true, artifacts };
    } catch (err) {
      return {
        ok: false,
        artifacts: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  save(
    payload: SaveArtifactInput,
    vaultDir?: string,
  ): { ok: boolean; artifact?: StoredArtifact; error?: string } {
    try {
      const vault = this.resolveVault(vaultDir);
      const artifact = saveArtifact(vault, payload);
      this.deps.broadcast(MAKER_PUSH.VAULT_CHANGED, {
        noteCount: -1,
        path: artifact.path,
      });
      return { ok: true, artifact };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  read(
    idOrPath: string,
    vaultDir?: string,
  ): { ok: boolean; artifact?: StoredArtifact; error?: string } {
    try {
      const vault = this.resolveVault(vaultDir);
      const artifact = readArtifact(vault, idOrPath);
      return { ok: true, artifact };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  delete(
    idOrPath: string,
    vaultDir?: string,
  ): { ok: boolean; deleted: boolean; error?: string } {
    try {
      const vault = this.resolveVault(vaultDir);
      const deleted = deleteArtifact(vault, idOrPath);
      if (deleted) {
        this.deps.broadcast(MAKER_PUSH.VAULT_CHANGED, {
          noteCount: -1,
          path: idOrPath,
        });
      }
      return { ok: true, deleted };
    } catch (err) {
      return {
        ok: false,
        deleted: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function registerArtifactsHandlers(
  registry: IpcHandlerRegistry,
  deps: ArtifactsHandlerDeps,
): ArtifactsHost {
  const host = new ArtifactsHost(deps);

  registry.handle(MAKER_INVOKE.ARTIFACTS_LIST, async (event: unknown, rawArgs: unknown) => {
    deps.assertTrusted(event);
    const args = rawArgs as { vaultDir?: string } | undefined;
    return host.list(args?.vaultDir);
  });

  registry.handle(
    MAKER_INVOKE.ARTIFACTS_SAVE,
    async (event: unknown, rawArgs: unknown) => {
      deps.assertTrusted(event);
      const args = rawArgs as { payload: SaveArtifactInput; vaultDir?: string };
      return host.save(args.payload, args.vaultDir);
    },
  );

  registry.handle(
    MAKER_INVOKE.ARTIFACTS_READ,
    async (event: unknown, rawArgs: unknown) => {
      deps.assertTrusted(event);
      const args = rawArgs as { idOrPath: string; vaultDir?: string };
      return host.read(args.idOrPath, args.vaultDir);
    },
  );

  registry.handle(
    MAKER_INVOKE.ARTIFACTS_DELETE,
    async (event: unknown, rawArgs: unknown) => {
      deps.assertTrusted(event);
      const args = rawArgs as { idOrPath: string; vaultDir?: string };
      return host.delete(args.idOrPath, args.vaultDir);
    },
  );

  return host;
}
