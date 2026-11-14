/**
 * "Where you left off" recap host (ROADMAP 13.3, blueprint §5).
 *
 * Modelled on ChatSummaryHost: the renderer reports that a session regained focus, this host
 * decides whether a recap is owed, and asks the routed `recap` model for one or two sentences.
 * The result is a transient strip above the composer — it is NEVER written to the transcript
 * and NEVER sent to the agent.
 *
 * Not routed = off, with no fallback to the chat model (AGENTS.md §6.3). The route and model
 * are named on the strip so background spend is visible (§6.4).
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  RECAP_MIN_TURNS,
  RECAP_SYSTEM_PROMPT,
  RECAP_TIMEOUT_MS,
  buildRecapPrompt,
  readRecapConfig,
  shouldRecap,
  writeRecapConfig,
  type RecapTurn,
} from '@cindy/maker-core/recap';
import { loadProvidersFile } from '@cindy/maker-core/providers-file';
import { loadRoutingFile, resolveTaskRoute } from '@cindy/maker-core/routing-file';
import { requestRoutedTaskText } from '@cindy/maker-core/routed-auxiliary';

import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface RecapConfigView {
  enabled: boolean;
  awayMinutes: number;
  /** False when `recap` has no usable rule: the feature is inert and Settings says so. */
  routed: boolean;
  routeName?: string;
  model?: string;
  issue?: string;
}

export interface RecapStrip {
  sessionId: string;
  text: string;
  routeName: string;
  model: string;
  provider: string;
  generatedAt: number;
  /** The turn count this recap covers, so the next one needs new turns. */
  turnCount: number;
}

export interface RecapFocusRequest {
  sessionId: string;
  /** When the owner last left this session; null when it has never been focused. */
  leftAt: number | null;
  turnCount: number;
  running: boolean;
}

export interface RecapHostDeps {
  configFile?: string;
  harnessDir?: string;
  listMessages: (sessionId: string) => Promise<Array<{ role: string; content: unknown }>>;
  getOpenGoal?: (sessionId: string) => Promise<string | null>;
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

export function defaultRecapConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'recap.json');
}

export class RecapHost {
  private readonly configFile: string;
  private readonly harnessDir: string;
  /** turnCount at the last delivered recap, per session. One recap per away period. */
  private readonly lastRecapTurn = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly dismissed = new Set<string>();

  constructor(private readonly deps: RecapHostDeps) {
    this.configFile = deps.configFile ?? defaultRecapConfigFile();
    this.harnessDir = deps.harnessDir ?? path.join(os.homedir(), '.cindy-harness');
  }

  getConfig(): RecapConfigView {
    const { config, issue } = readRecapConfig(this.configFile);
    const route = this.resolveRoute();
    return {
      enabled: config.enabled,
      awayMinutes: config.awayMinutes,
      routed: route.routed,
      ...(route.routeName ? { routeName: route.routeName } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(issue ? { issue } : {}),
    };
  }

  setConfig(request: unknown): RecapConfigView {
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    writeRecapConfig(this.configFile, {
      ...(typeof r.enabled === 'boolean' ? { enabled: r.enabled } : {}),
      ...(typeof r.awayMinutes === 'number' ? { awayMinutes: r.awayMinutes } : {}),
    });
    return this.getConfig();
  }

  /** The owner dismissed the strip: do not offer it again for the same turn count. */
  dismiss(sessionId: string): void {
    if (sessionId) this.dismissed.add(sessionId);
  }

  /**
   * Called when a session regains focus. Returns a strip, or null for every quiet off-path.
   * Never throws: a failed or blocked route means no strip and one warn line.
   */
  async onFocus(request: RecapFocusRequest): Promise<RecapStrip | null> {
    const { sessionId } = request;
    if (!sessionId) return null;
    const { config } = readRecapConfig(this.configFile);
    const now = (this.deps.now ?? Date.now)();
    const decision = shouldRecap({
      enabled: config.enabled,
      lastFocusAt: request.leftAt,
      now,
      awayMinutes: config.awayMinutes,
      turnCount: request.turnCount,
      lastRecapTurn: this.lastRecapTurn.get(sessionId) ?? null,
      running: request.running,
    });
    if (!decision.recap) {
      this.deps.log?.debug?.('recap skipped', { sessionId, reason: decision.reason });
      return null;
    }
    if (this.inFlight.has(sessionId)) return null;
    if (this.dismissed.has(sessionId)) {
      // A dismissal covers the turns it was shown for; new turns earn a new strip.
      const covered = this.lastRecapTurn.get(sessionId) ?? 0;
      if (request.turnCount <= covered) return null;
      this.dismissed.delete(sessionId);
    }

    this.inFlight.add(sessionId);
    try {
      const rows = await this.deps.listMessages(sessionId);
      const turns: RecapTurn[] = [];
      for (const row of rows ?? []) {
        if (row.role !== 'user' && row.role !== 'assistant') continue;
        const text = visibleMessageText(row.role, row.content);
        if (text.trim()) turns.push({ role: row.role, text });
      }
      if (turns.length < RECAP_MIN_TURNS) return null;
      const goal = await this.deps.getOpenGoal?.(sessionId).catch(() => null);
      const routed = await requestRoutedTaskText(
        {
          taskClass: 'recap',
          prompt: buildRecapPrompt(turns, goal),
          systemPrompt: RECAP_SYSTEM_PROMPT,
          // Reasoning models spend part of the budget thinking before they emit content: 200
          // produced an empty reply live on tokenhub deepseek-v4.1-flash (2026-11-14).
          maxTokens: 1024,
          timeoutMs: RECAP_TIMEOUT_MS,
        },
        {
          harnessDir: this.harnessDir,
          env: typeof this.deps.env === 'function' ? this.deps.env() : (this.deps.env ?? process.env),
          fetchImpl: this.deps.fetchImpl ?? fetch,
        },
      );

      if (routed.kind === 'not-routed') {
        this.deps.log?.debug?.('recap skipped: task "recap" is not routed', { sessionId });
        return null;
      }
      if (routed.kind === 'blocked') {
        this.deps.log?.warn('recap route blocked (no silent fallback)', {
          sessionId, reason: routed.reason, message: routed.message,
        });
        return null;
      }
      if (routed.kind === 'failed') {
        this.deps.log?.warn('recap call failed', { sessionId, message: routed.message });
        return null;
      }

      const text = routed.text.trim();
      if (!text) return null;
      this.lastRecapTurn.set(sessionId, request.turnCount);
      this.deps.log?.info?.('recap generated on routed endpoint', {
        sessionId, routeName: routed.routeName, model: routed.model, provider: routed.provider,
      });
      return {
        sessionId,
        text,
        routeName: routed.routeName,
        model: routed.model,
        provider: routed.provider,
        generatedAt: now,
        turnCount: request.turnCount,
      };
    } catch (error) {
      this.deps.log?.warn('recap failed', {
        sessionId, message: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private resolveRoute(): { routed: boolean; routeName?: string; model?: string } {
    try {
      const providers = loadProvidersFile(path.join(this.harnessDir, 'providers.yaml'));
      const routing = loadRoutingFile(
        path.join(this.harnessDir, 'routing.yaml'),
        providers.providers.map((p) => p.id),
      );
      const resolution = resolveTaskRoute(routing, 'recap');
      if (!resolution.ok) return { routed: false };
      return { routed: true, routeName: resolution.routeName, model: resolution.target.model };
    } catch {
      return { routed: false };
    }
  }
}

export function registerRecapHandlers(
  registry: IpcHandlerRegistry,
  deps: { host: RecapHost; assertTrusted: (event: unknown) => void },
): void {
  registry.handle(MAKER_INVOKE.RECAP_GET_CONFIG, (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });
  registry.handle(MAKER_INVOKE.RECAP_SET_CONFIG, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    return deps.host.setConfig(request);
  });
  registry.handle(MAKER_INVOKE.RECAP_ON_FOCUS, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    if (typeof r.sessionId !== 'string' || !r.sessionId) return Promise.resolve(null);
    return deps.host.onFocus({
      sessionId: r.sessionId,
      leftAt: typeof r.leftAt === 'number' && Number.isFinite(r.leftAt) ? r.leftAt : null,
      turnCount: typeof r.turnCount === 'number' && Number.isFinite(r.turnCount) ? r.turnCount : 0,
      running: r.running === true,
    });
  });
  registry.handle(MAKER_INVOKE.RECAP_DISMISS, (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    if (typeof sessionId === 'string') deps.host.dismiss(sessionId);
    return null;
  });
}