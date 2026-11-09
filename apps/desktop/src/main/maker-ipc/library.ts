/**
 * Library index host (ROADMAP 8.5).
 *
 * Reads the notes vault once and returns one flat index over vault notes,
 * auto-saved chat transcripts and generated summaries. Classification, excerpts,
 * search and citations all live in `@cindy/maker-core/library-index`; this file
 * only does the file reading, so the logic stays unit-testable without a vault.
 *
 * Local only. No network, no telemetry, no writes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildLibraryIndex, type LibraryEntry } from '@cindy/maker-core/library-index';
import { scanVaultGraph } from '@cindy/maker-core/vault-graph';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** A single note is bounded; the graph already caps the note count. */
const MAX_BODY_BYTES = 200_000;

export interface LibraryScanResult {
  ok: boolean;
  entries: LibraryEntry[];
  vaultDir?: string;
  scannedAt?: string;
  error?: string;
}

export function scanLibrary(vaultDir: string): LibraryScanResult {
  if (!vaultDir || !vaultDir.trim()) {
    return { ok: false, entries: [], error: 'no notes vault configured' };
  }

  const root = path.resolve(vaultDir);
  let graph;
  try {
    graph = scanVaultGraph(root);
  } catch (error) {
    return {
      ok: false,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const sources = Object.values(graph.nodes).map((node) => {
    let body = '';
    try {
      const full = path.resolve(root, node.path);
      // The graph only lists vault-relative .md paths, but resolve again so a
      // crafted path can never read outside the vault.
      if (full.startsWith(root)) {
        body = fs.readFileSync(full, 'utf8').slice(0, MAX_BODY_BYTES);
      }
    } catch {
      // An unreadable note is still worth listing, just without an excerpt.
    }
    return {
      path: node.path,
      title: node.title,
      tags: node.tags,
      mtimeMs: node.mtimeMs,
      body,
    };
  });

  return {
    ok: true,
    entries: buildLibraryIndex(sources),
    vaultDir: root,
    scannedAt: graph.scannedAt,
  };
}

export interface LibraryHandlerDeps {
  getVaultDir(): string;
  assertTrusted(event: unknown): void;
}

export function registerLibraryHandlers(
  registry: IpcHandlerRegistry,
  deps: LibraryHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.LIBRARY_SCAN, async (event: unknown) => {
    deps.assertTrusted(event);
    return scanLibrary(deps.getVaultDir());
  });
}
