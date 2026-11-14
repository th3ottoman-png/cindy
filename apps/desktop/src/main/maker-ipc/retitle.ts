/**
 * Titles that follow the conversation (ROADMAP 13.9, blueprint §13).
 *
 * Modelled on RecapHost: the renderer reports that a turn ended, this host decides whether a
 * re-title is owed, and asks the routed title model for a {changed, title} decision. Only an
 * auto title ever changes; an owner rename is permanent.
 *
 * Not routed = off, with no fallback to the chat model (AGENTS.md §6.3). The route and model
 * are named in the log and in Settings so background spend is visible (§6.4).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  RETITLE_TIMEOUT_MS,
  buildRetitlePrompt,
  parseRetitleDecision,
  pushTitleHistory,
  readRetitleConfig,
  shouldRetitle,
  writeRetitleConfig,
} from '@cindy/maker-core/retitle';
import { loadProvidersFile } from '@cindy/maker-core/providers-file';
import { loadRoutingFile, resolveTaskRoute } from '@cindy/maker-core/routing-file';
import { requestRoutedTaskText } from '@cindy/maker-core/routed-auxiliary';

import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** Durable per-session ownership + undo ring. File-backed and human-editable (AGENTS.md §6.1). */
export interface RetitleSessionState {
  source: 'auto' | 'owner';
  /** Previous titles, newest first. The undo ring. */
  history: string[];
  /** User-turn count when the current title was written. */
  lastTitleUserTurns: number;
}

export interface RetitleConfigView {
  enabled: boolean;
  routed: boolean;
  routeName?: string;
  model?: string;
  issue?: string;
}

export interface RetitleResult {
  changed: boolean;
  title?: string;
  previousTitle?: string;
  routeName?: string;
  model?: string;
  reason?: string;
}

export interface RetitleHostDeps {
  configFile?: string;
  stateFile?: string;
  harnessDir?: string;
  readSessionTitle: (sessionId: string) => Promise<string | null>;
  countUserTurns: (sessionId: string) => Promise<number>;
  listMessages: (sessionId: string) => Promise<Array<{ role: string; content: unknown }>>;
  /** Conditional write: only when the title still equals expectedTitle (user rename wins). */
  persistTitle: (sessionId: string, title: string, expectedTitle: string) => Promise<boolean>;
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  fetchImpl?: typeof fetch;
}

export function defaultRetitleConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'retitle.json');
}

export function defaultRetitleStateFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'retitle-state.json');
}

function readStateFile(file: string): Record<string, RetitleSessionState> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, RetitleSessionState> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      out[key] = {
        source: v.source === 'owner' ? 'owner' : 'auto',
        history: Array.isArray(v.history) ? v.history.filter((h): h is string => typeof h === 'string') : [],
        lastTitleUserTurns: typeof v.lastTitleUserTurns === "number" && Number.isFinite(v.lastTitleUserTurns)
          ? v.lastTitleUserTurns : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}
export class RetitleHost {
  private readonly configFile: string;
  private readonly stateFile: string;
  private readonly harnessDir: string;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: RetitleHostDeps) {
    this.configFile = deps.configFile ?? defaultRetitleConfigFile();
    this.stateFile = deps.stateFile ?? defaultRetitleStateFile();
    this.harnessDir = deps.harnessDir ?? path.join(os.homedir(), '.cindy-harness');
  }

  getConfig(): RetitleConfigView {
    const { config, issue } = readRetitleConfig(this.configFile);
    const route = this.resolveRoute();
    return {
      enabled: config.enabled,
      routed: route.routed,
      ...(route.routeName ? { routeName: route.routeName } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(issue ? { issue } : {}),
    };
  }

  setConfig(request: unknown): RetitleConfigView {
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    writeRetitleConfig(this.configFile, {
      ...(typeof r.enabled === 'boolean' ? { enabled: r.enabled } : {}),
    });
    return this.getConfig();
  }

  getState(sessionId: string): RetitleSessionState | null {
    if (!sessionId) return null;
    return readStateFile(this.stateFile)[sessionId] ?? null;
  }

  /** The auto-title path wrote a title: that is the baseline a re-title counts from. */
  noteAutoTitle(sessionId: string, userTurns: number): void {
    if (!sessionId) return;
    const all = readStateFile(this.stateFile);
    if (all[sessionId]?.source === 'owner') return;
    all[sessionId] = {
      source: 'auto',
      history: all[sessionId]?.history ?? [],
      lastTitleUserTurns: userTurns,
    };
    this.writeState(all);
  }

  /**
   * The auto-title path just wrote a title: read the authoritative user-turn count and
   * record the baseline. Best effort — a DB hiccup must never break auto-title.
   */
  async noteAutoTitleFromDb(sessionId: string): Promise<void> {
    try {
      const userTurns = await this.deps.countUserTurns(sessionId);
      this.noteAutoTitle(sessionId, userTurns);
    } catch (error) {
      this.deps.log?.warn('retitle baseline not recorded', { sessionId, error: String(error) });
    }
  }

  /** The owner renamed by hand: permanent, and the undo ring is cleared with it. */
  noteOwnerRename(sessionId: string): void {
    if (!sessionId) return;
    const all = readStateFile(this.stateFile);
    all[sessionId] = { source: 'owner', history: [], lastTitleUserTurns: all[sessionId]?.lastTitleUserTurns ?? 0 };
    this.writeState(all);
  }

  /** One-click undo: restore the most recent previous title. */
  async undo(sessionId: string): Promise<RetitleResult> {
    const all = readStateFile(this.stateFile);
    const state = all[sessionId];
    if (!state || state.history.length === 0) return { changed: false, reason: "no-history" };
    const current = await this.deps.readSessionTitle(sessionId);
    if (current === null) return { changed: false, reason: "session-not-found" };
    const [restore, ...rest] = state.history;
    const written = await this.deps.persistTitle(sessionId, restore, current);
    if (!written) return { changed: false, reason: "title-changed" };
    all[sessionId] = { ...state, history: rest };
    this.writeState(all);
    this.deps.log?.info?.("retitle undo applied", { sessionId, title: restore });
    return { changed: true, title: restore, previousTitle: current };
  }

  /**
   * Called when a turn ends. Returns the decision, or a quiet no-change for every off-path.
   * Never throws: a blocked or failed route means no rename and one warn line.
   */
  async maybeRetitle(request: { sessionId: string; running: boolean }): Promise<RetitleResult> {
    const { sessionId } = request;
    if (!sessionId) return { changed: false, reason: "no-session" };
    const { config } = readRetitleConfig(this.configFile);
    const route = this.resolveRoute();
    const state = this.getState(sessionId);
    // No record means we never wrote this title, so we cannot claim it is ours. Fail closed:
    // an owner rename that predates this feature must never be overwritten.
    const known = state !== null;
    const userTurns = known ? await this.deps.countUserTurns(sessionId) : 0;
    const decision = shouldRetitle({
      enabled: config.enabled,
      routed: route.routed,
      ownerRenamed: !known || state?.source === 'owner',
      running: request.running,
      userTurns,
      lastTitleUserTurns: state?.lastTitleUserTurns ?? 0,
    });
    if (!decision.retitle) {
      this.deps.log?.debug?.("retitle skipped", { sessionId, reason: decision.reason });
      return { changed: false, reason: decision.reason };
    }
    if (this.inFlight.has(sessionId)) return { changed: false, reason: "in-flight" };
    const currentTitle = await this.deps.readSessionTitle(sessionId);
    if (currentTitle === null) return { changed: false, reason: "session-not-found" };

    this.inFlight.add(sessionId);
    try {
      const rows = await this.deps.listMessages(sessionId);
      const lines: string[] = [];
      for (const row of rows ?? []) {
        if (row.role !== 'user' && row.role !== 'assistant') continue;
        const text = visibleMessageText(row.role, row.content);
        if (text.trim()) lines.push((row.role === 'user' ? 'User: ' : 'Assistant: ') + text);
      }
      if (lines.length === 0) return { changed: false, reason: "no-material" };
      const routed = await requestRoutedTaskText(
        {
          taskClass: 'title',
          prompt: buildRetitlePrompt(currentTitle, lines.join("\n")),
          systemPrompt: "Answer with one JSON object only. Never rename a conversation unless the topic changed.",
          maxTokens: 1024,
          timeoutMs: RETITLE_TIMEOUT_MS,
        },
        {
          harnessDir: this.harnessDir,
          env: typeof this.deps.env === 'function' ? this.deps.env() : (this.deps.env ?? process.env),
          fetchImpl: this.deps.fetchImpl ?? fetch,
        },
      );
      if (routed.kind === 'not-routed') return { changed: false, reason: 'not-routed' };
      if (routed.kind === 'blocked') {
        this.deps.log?.warn("retitle route blocked (no silent fallback)", {
          sessionId, reason: routed.reason, message: routed.message,
        });
        return { changed: false, reason: 'blocked' };
      }
      if (routed.kind === 'failed') {
        this.deps.log?.warn("retitle call failed", { sessionId, message: routed.message });
        return { changed: false, reason: 'failed' };
      }
      const parsed = parseRetitleDecision(routed.text);
      if (!parsed.changed) {
        // The model saw the conversation and kept the title: still count the turns, so the
        // next check is six turns later rather than on every turn end.
        this.bumpTurns(sessionId, userTurns);
        return { changed: false, reason: "model-kept-title", routeName: routed.routeName, model: routed.model };
      }
      if (parsed.title === currentTitle) {
        this.bumpTurns(sessionId, userTurns);
        return { changed: false, reason: "same-title" };
      }
      // The conditional write cannot catch an owner rename to the *identical* string, so
      // re-check ownership after the call (the same guard the auto-title path keeps).
      if (this.getState(sessionId)?.source === 'owner') {
        return { changed: false, reason: "owner-renamed" };
      }
      const written = await this.deps.persistTitle(sessionId, parsed.title, currentTitle);
      if (!written) return { changed: false, reason: "title-changed" };
      const all = readStateFile(this.stateFile);
      const prev = all[sessionId];
      all[sessionId] = {
        source: 'auto',
        history: pushTitleHistory(prev?.history ?? [], currentTitle),
        lastTitleUserTurns: userTurns,
      };
      this.writeState(all);
      this.deps.log?.info?.("retitle applied on routed endpoint", {
        sessionId, title: parsed.title, previousTitle: currentTitle,
        routeName: routed.routeName, model: routed.model, provider: routed.provider,
      });
      return {
        changed: true, title: parsed.title, previousTitle: currentTitle,
        routeName: routed.routeName, model: routed.model,
      };
    } catch (error) {
      this.deps.log?.warn("retitle failed", { sessionId, error: String(error) });
      return { changed: false, reason: 'error' };
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private bumpTurns(sessionId: string, userTurns: number): void {
    const all = readStateFile(this.stateFile);
    const prev = all[sessionId];
    if (!prev) return;
    all[sessionId] = { ...prev, lastTitleUserTurns: userTurns };
    this.writeState(all);
  }

  private writeState(all: Record<string, RetitleSessionState>): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = this.stateFile + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      this.deps.log?.warn("retitle state write failed", { error: String(error) });
    }
  }

  private resolveRoute(): { routed: boolean; routeName?: string; model?: string } {
    try {
      const providers = loadProvidersFile(path.join(this.harnessDir, 'providers.yaml'));
      const routing = loadRoutingFile(
        path.join(this.harnessDir, 'routing.yaml'),
        providers.providers.map((prov) => prov.id),
      );
      const resolution = resolveTaskRoute(routing, 'title');
      if (!resolution.ok) return { routed: false };
      return { routed: true, routeName: resolution.routeName, model: resolution.target.model };
    } catch {
      return { routed: false };
    }
  }
}
export function registerRetitleHandlers(
  registry: IpcHandlerRegistry,
  deps: { host: RetitleHost; assertTrusted: (event: unknown) => void },
): void {
  registry.handle(MAKER_INVOKE.RETITLE_GET_CONFIG, (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.getConfig();
  });
  registry.handle(MAKER_INVOKE.RETITLE_SET_CONFIG, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    return deps.host.setConfig(request);
  });
  registry.handle(MAKER_INVOKE.RETITLE_MAYBE, (event: unknown, request: unknown) => {
    deps.assertTrusted(event);
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    if (typeof r.sessionId !== 'string' || !r.sessionId) return Promise.resolve({ changed: false });
    return deps.host.maybeRetitle({ sessionId: r.sessionId, running: r.running === true });
  });
  registry.handle(MAKER_INVOKE.RETITLE_GET_STATE, (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    return typeof sessionId === 'string' ? deps.host.getState(sessionId) : null;
  });
  registry.handle(MAKER_INVOKE.RETITLE_UNDO, (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve({ changed: false });
    return deps.host.undo(sessionId);
  });
}


