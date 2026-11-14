/**
 * Tool-batch label host (ROADMAP 13.4, blueprint §6).
 *
 * The renderer reports the top-level work groups of a turn that just FINISHED (never while
 * streaming); this host asks the routed `tool-label` model for a label of at most 6 words per
 * group and caches it per session in `~/.cindy-harness/tool-labels/<sessionId>.json`, so
 * reopening history reads the cache and never re-bills. History groups without a cached label
 * keep the generic header: there is no backfill.
 *
 * Not routed = off, with no fallback to the chat model (AGENTS.md §6.3). Cached labels are also
 * hidden while the route is off, so the headers revert to the generic text. The route and model
 * travel with every label for the header tooltip, so background spend is visible (§6.4).
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  TOOL_LABEL_SYSTEM_PROMPT,
  TOOL_LABEL_TIMEOUT_MS,
  buildToolLabelDigest,
  parseToolLabel,
  readToolLabelCache,
  toolLabelCacheFile,
  writeToolLabelEntry,
  type ToolLabelCall,
  type ToolLabelEntry,
} from '@cindy/maker-core/tool-label';
import { loadProvidersFile } from '@cindy/maker-core/providers-file';
import { loadRoutingFile, resolveTaskRoute } from '@cindy/maker-core/routing-file';
import { requestRoutedTaskText } from '@cindy/maker-core/routed-auxiliary';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** One finished turn rarely has more; anything beyond is left generic rather than billed. */
export const TOOL_LABEL_MAX_GROUPS_PER_REQUEST = 8;
/** Bounds the IPC payload; the digest only reads the first argument of each call anyway. */
export const TOOL_LABEL_MAX_CALLS_PER_GROUP = 200;
/** One call, plus one retry when the reply is empty or not a short label. */
export const TOOL_LABEL_ATTEMPTS = 2;

export interface ToolLabelConfigView {
  /** False when `tool-label` has no usable rule: the feature is inert and Settings says so. */
  routed: boolean;
  routeName?: string;
  model?: string;
}

export interface ToolLabelGroupRequest {
  /** Stable cache key: the group's first tool call (its tool_use id when known). */
  key: string;
  calls: ToolLabelCall[];
}

export type ToolLabelMap = Record<string, ToolLabelEntry>;

export interface ToolLabelHostDeps {
  harnessDir?: string;
  cacheDir?: string;
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
  /** A thunk is re-read per call, so a key the owner adds needs no restart. */
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  fetchImpl?: typeof fetch;
}

export function defaultToolLabelCacheDir(): string {
  return path.join(os.homedir(), '.cindy-harness', 'tool-labels');
}

export class ToolLabelHost {
  private readonly harnessDir: string;
  private readonly cacheDir: string;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ToolLabelHostDeps = {}) {
    this.harnessDir = deps.harnessDir ?? path.join(os.homedir(), '.cindy-harness');
    this.cacheDir = deps.cacheDir ?? path.join(this.harnessDir, 'tool-labels');
  }

  getConfig(): ToolLabelConfigView {
    const route = this.resolveRoute();
    return {
      routed: route.routed,
      ...(route.routeName ? { routeName: route.routeName } : {}),
      ...(route.model ? { model: route.model } : {}),
    };
  }

  /** Cache only — never a model call. Empty while `tool-label` is not routed. */
  getLabels(sessionId: string): ToolLabelMap {
    if (!sessionId) return {};
    if (!this.resolveRoute().routed) return {};
    return readToolLabelCache(toolLabelCacheFile(this.cacheDir, sessionId)).labels;
  }

  /**
   * Label the finished groups that have no cached label yet, one routed call each, then return
   * every cached label for the session. Never throws: a failed or blocked route leaves the
   * group generic with one warn line.
   */
  async labelGroups(
    sessionId: string,
    groups: readonly ToolLabelGroupRequest[],
  ): Promise<ToolLabelMap> {
    if (!sessionId) return {};
    if (!this.resolveRoute().routed) {
      this.deps.log?.debug?.('tool-label skipped: task "tool-label" is not routed', { sessionId });
      return {};
    }
    const file = toolLabelCacheFile(this.cacheDir, sessionId);
    let cache = readToolLabelCache(file);

    for (const group of groups.slice(0, TOOL_LABEL_MAX_GROUPS_PER_REQUEST)) {
      if (!group.key || group.calls.length === 0) continue;
      if (cache.labels[group.key]) continue;
      const flightKey = `${sessionId}\u0000${group.key}`;
      if (this.inFlight.has(flightKey)) continue;
      this.inFlight.add(flightKey);
      try {
        const outcome = await this.labelOne(sessionId, group);
        if (outcome.kind === 'not-routed') return {};
        // A blocked route blocks every group alike; do not hammer it.
        if (outcome.kind === 'blocked') break;
        if (outcome.kind === 'labelled')
          cache = writeToolLabelEntry(file, group.key, outcome.entry);
      } catch (error) {
        this.deps.log?.warn('tool-label failed', {
          sessionId,
          key: group.key,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.inFlight.delete(flightKey);
      }
    }
    return cache.labels;
  }

  /**
   * One routed call, plus one retry when the reply is empty or not a short label: small local
   * models (qwen3-8b, live 2026-11-14) sometimes spend the turn thinking or answer with a sentence.
   */
  private async labelOne(
    sessionId: string,
    group: ToolLabelGroupRequest,
  ): Promise<
    { kind: 'labelled'; entry: ToolLabelEntry } | { kind: 'not-routed' | 'blocked' | 'none' }
  > {
    for (let attempt = 1; attempt <= TOOL_LABEL_ATTEMPTS; attempt += 1) {
      const routed = await requestRoutedTaskText(
        {
          taskClass: 'tool-label',
          prompt: buildToolLabelDigest(group.calls),
          systemPrompt: TOOL_LABEL_SYSTEM_PROMPT,
          // Reasoning models spend part of the budget thinking before they answer (13.3 live).
          maxTokens: 1024,
          timeoutMs: TOOL_LABEL_TIMEOUT_MS,
        },
        {
          harnessDir: this.harnessDir,
          env:
            typeof this.deps.env === 'function' ? this.deps.env() : (this.deps.env ?? process.env),
          fetchImpl: this.deps.fetchImpl ?? fetch,
        },
      );
      if (routed.kind === 'not-routed') return { kind: 'not-routed' };
      if (routed.kind === 'blocked') {
        this.deps.log?.warn('tool-label route blocked (no silent fallback)', {
          sessionId,
          reason: routed.reason,
          message: routed.message,
        });
        return { kind: 'blocked' };
      }
      if (routed.kind === 'failed') {
        // An empty reply arrives as `failed` ("no message content"), so it gets the retry too.
        this.deps.log?.warn('tool-label call failed', {
          sessionId,
          key: group.key,
          message: routed.message,
          attempt,
        });
        continue;
      }
      const label = parseToolLabel(routed.text);
      if (!label) {
        this.deps.log?.warn('tool-label reply rejected (not a short label)', {
          sessionId,
          key: group.key,
          chars: routed.text.length,
          attempt,
        });
        continue;
      }
      this.deps.log?.info?.('tool-label generated on routed endpoint', {
        sessionId,
        key: group.key,
        tools: group.calls.length,
        attempt,
        routeName: routed.routeName,
        model: routed.model,
        provider: routed.provider,
      });
      return {
        kind: 'labelled',
        entry: {
          label,
          toolCount: group.calls.length,
          routeName: routed.routeName,
          model: routed.model,
          provider: routed.provider,
          createdAt: (this.deps.now ?? Date.now)(),
        },
      };
    }
    return { kind: 'none' };
  }

  private resolveRoute(): { routed: boolean; routeName?: string; model?: string } {
    try {
      const providers = loadProvidersFile(path.join(this.harnessDir, 'providers.yaml'));
      const routing = loadRoutingFile(
        path.join(this.harnessDir, 'routing.yaml'),
        providers.providers.map((p) => p.id),
      );
      const resolution = resolveTaskRoute(routing, 'tool-label');
      if (!resolution.ok) return { routed: false };
      return { routed: true, routeName: resolution.routeName, model: resolution.target.model };
    } catch {
      return { routed: false };
    }
  }
}

/** Shape-check the renderer's request; anything malformed is dropped, never thrown. */
export function parseToolLabelGroups(value: unknown): ToolLabelGroupRequest[] {
  if (!Array.isArray(value)) return [];
  const groups: ToolLabelGroupRequest[] = [];
  for (const raw of value.slice(0, TOOL_LABEL_MAX_GROUPS_PER_REQUEST)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.key !== 'string' || !r.key || !Array.isArray(r.calls)) continue;
    const calls: ToolLabelCall[] = [];
    for (const c of r.calls.slice(0, TOOL_LABEL_MAX_CALLS_PER_GROUP)) {
      if (!c || typeof c !== 'object') continue;
      const call = c as Record<string, unknown>;
      if (typeof call.name !== 'string' || !call.name) continue;
      calls.push({ name: call.name, input: call.input });
    }
    if (calls.length > 0) groups.push({ key: r.key, calls });
  }
  return groups;
}

export function registerToolLabelHandlers(
  registry: IpcHandlerRegistry,
  deps: { host: ToolLabelHost; assertTrusted: (event: unknown) => void },
): void {
  registry.handle(MAKER_INVOKE.TOOL_LABEL_GET_CONFIG, (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });
  registry.handle(MAKER_INVOKE.TOOL_LABEL_GET_LABELS, (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    return typeof sessionId === 'string' ? deps.host.getLabels(sessionId) : {};
  });
  registry.handle(MAKER_INVOKE.TOOL_LABEL_LABEL_GROUPS, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    if (typeof r.sessionId !== 'string' || !r.sessionId) return Promise.resolve({});
    return deps.host.labelGroups(r.sessionId, parseToolLabelGroups(r.groups));
  });
}
