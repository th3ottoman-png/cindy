/**
 * useHermesModelCatalog — real model ids for Hermes sessions.
 *
 * Hermes has no static catalog: the model set is whatever the active provider
 * answers on `{base_url}/models`. The daemon lists them (route from
 * config.yaml, Bearer key from this process' env); here we cache for a minute
 * and expose them as picker descriptors, headed by the "home default" sentinel
 * row (selecting it clears any per-session override).
 */
import { useEffect, useState } from 'react';

import type { ModelDescriptor } from './useAgentCapabilities';

export interface HermesCatalogState {
  /** Picker rows: the home-default sentinel first, then provider model ids. */
  descriptors: ModelDescriptor[];
  /** The home's configured default model id, if any. */
  homeModel: string | null;
  provider: string | null;
  loading: boolean;
  error: string | null;
}

const HERMES_CONTEXT_WINDOW = 200_000;
const CACHE_TTL_MS = 60_000;

export function buildHermesDescriptors(
  route: { model?: string; provider?: string },
  models: readonly string[],
): ModelDescriptor[] {
  const homeLabel = route.model
    ? `Hermes home default (${route.model})`
    : 'Hermes home default';
  const descriptors: ModelDescriptor[] = [
    {
      id: 'hermes-default',
      displayName: homeLabel,
      contextWindow: HERMES_CONTEXT_WINDOW,
      efforts: [],
      defaultEffort: null,
    },
  ];
  for (const id of models) {
    if (id === route.model) continue;
    descriptors.push({
      id,
      displayName: id,
      contextWindow: HERMES_CONTEXT_WINDOW,
      efforts: [],
      defaultEffort: null,
    });
  }
  return descriptors;
}

interface CacheEntry {
  at: number;
  state: HermesCatalogState;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<HermesCatalogState> | null = null;

async function fetchCatalog(): Promise<HermesCatalogState> {
  const result = await window.electronAPI.maker.hermesConfig.listModels();
  return {
    descriptors: buildHermesDescriptors(result.route ?? {}, result.models ?? []),
    homeModel: result.route?.model ?? null,
    provider: result.route?.provider ?? null,
    loading: false,
    error: result.error ?? null,
  };
}

export function invalidateHermesModelCatalog(): void {
  cache = null;
}

export function useHermesModelCatalog(enabled: boolean): HermesCatalogState {
  const [state, setState] = useState<HermesCatalogState>(
    () => cache?.state ?? {
      descriptors: [],
      homeModel: null,
      provider: null,
      loading: false,
      error: null,
    },
  );

  useEffect(() => {
    if (!enabled) return;
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      setState(cache.state);
      return;
    }
    if (!inFlight) {
      inFlight = fetchCatalog()
        .then((state) => {
          cache = { at: Date.now(), state };
          return state;
        })
        .catch((error: unknown) => ({
          descriptors: [],
          homeModel: null,
          provider: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          inFlight = null;
        });
    }
    void inFlight.then((state) => {
      setState(state);
    });
  }, [enabled]);

  return enabled ? state : {
    descriptors: [],
    homeModel: null,
    provider: null,
    loading: false,
    error: null,
  };
}
