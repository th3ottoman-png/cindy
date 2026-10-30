/**
 * maker:experts:* IPC (ROADMAP 3.1b). Read-only bridge over the file-backed expert loader:
 * the renderer lists `~/.cindy-harness/experts` and is told when it changes. The files stay
 * the source of truth; nothing here writes them. The watcher starts on the first list call
 * so an app that never opens an expert surface pays nothing.
 */

import { loadExperts, watchExperts, type ExpertEntry, type ExpertWatcher } from '@cindy/maker-core/experts';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ExpertsHandlerDeps {
  /** Directory holding one sub-directory per expert (production: ~/.cindy-harness/experts). */
  rootDir: string;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production: send to every BrowserWindow. */
  broadcast(channel: string, payload: ExpertEntry[]): void;
  /** Directory watcher; production default is the real `watchExperts`. Injected so tests need no native fs.watch. */
  watch?: typeof watchExperts;
}

export interface ExpertsHandlerHandle {
  dispose(): void;
}

export function registerExpertsHandlers(
  registry: IpcHandlerRegistry,
  deps: ExpertsHandlerDeps,
): ExpertsHandlerHandle {
  let watcher: ExpertWatcher | undefined;
  registry.handle(MAKER_INVOKE.EXPERTS_LIST, (event) => {
    deps.assertTrusted(event);
    watcher ??= (deps.watch ?? watchExperts)(deps.rootDir, (entries) => deps.broadcast(MAKER_PUSH.EXPERTS_CHANGED, entries));
    return loadExperts(deps.rootDir);
  });
  return {
    dispose() {
      watcher?.close();
      watcher = undefined;
    },
  };
}
