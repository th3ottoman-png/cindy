/**
 * maker:providers:* IPC (ROADMAP 2.1b/2.2b, IPC part only). Read-only bridge over
 * `~/.cindy-harness/providers.yaml`: list the configured endpoints (plus file issues) and
 * probe them for online/offline and loaded models. The file stays the source of truth;
 * nothing here writes it. Probing happens only when the renderer asks.
 */

import { discoverEndpoints, type DiscoveryOptions, type EndpointProbe } from '@cindy/maker-core/providers-discovery';
import { loadProvidersFile, type ProviderFileResult } from '@cindy/maker-core/providers-file';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ProvidersHandlerDeps {
  /** Production: ~/.cindy-harness/providers.yaml. */
  file: string;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production default: the real `discoverEndpoints`. Injected so tests can pass a fake `fetch`. */
  discover?: typeof discoverEndpoints;
  discoveryOptions?: DiscoveryOptions;
}

export function registerProvidersHandlers(registry: IpcHandlerRegistry, deps: ProvidersHandlerDeps): void {
  registry.handle(MAKER_INVOKE.PROVIDERS_LIST, (event): ProviderFileResult => {
    deps.assertTrusted(event);
    return loadProvidersFile(deps.file);
  });
  registry.handle(MAKER_INVOKE.PROVIDERS_DISCOVER, async (event): Promise<EndpointProbe[]> => {
    deps.assertTrusted(event);
    const { providers } = loadProvidersFile(deps.file);
    return (deps.discover ?? discoverEndpoints)(providers, deps.discoveryOptions);
  });
}
