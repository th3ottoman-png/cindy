/**
 * maker:experts:* IPC (ROADMAP 3.1b). Bridge over the file-backed expert loader: the renderer
 * lists `~/.cindy-harness/experts` and is told when it changes. The files stay the source of
 * truth. The watcher starts on the first list call so an app that never opens an expert
 * surface pays nothing.
 *
 * ROADMAP 3.3: the Settings editor reads one expert (`EXPERTS_READ`) and writes through one
 * RPC (`EXPERTS_SAVE`: create / duplicate / edit), all on the 3.8 draft write path in
 * `@cindy/maker-core/expert-draft` (atomic, validated by the loader, never overwrites a hand
 * edit made since the editor read the file).
 *
 * ROADMAP 3.6b: `EXPERTS_HANDOFF` turns a stored session into the first message for a NEW
 * session with a Hermes expert (`buildExpertHandoff`) and makes that expert the pending pick.
 * It starts nothing: the renderer only prefills the new-task draft, and the owner sends it.
 *
 * ROADMAP 3.10c: `EXPERTS_GO_AHEAD` does the same for a session locked by its expert's
 * `toolsets:` (Options first), but for a plain task with no expert: it clears the pending pick
 * and returns the source folder and access level so the new task can act on the picked option.
 */

import { readFileSync } from 'node:fs';

import {
  duplicateExpert,
  readExpertSource,
  saveExpertEdit,
  writeExpertDraft,
  hashExpertMarkdown,
  type ExpertSaveResult,
} from '@cindy/maker-core/expert-draft';
import { buildExpertHandoff, buildGoAheadHandoff } from '@cindy/maker-core/expert-handoff';
import { loadExpert, loadExperts, watchExperts, type ExpertEntry, type ExpertWatcher } from '@cindy/maker-core/experts';
import * as path from 'node:path';

import type { HandoffSourceMessage } from './agentHandoff.js';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { ExpertDraftConfirm } from './expertDraftConfirm.js';
import { toExpertHandoffMessages } from './expertHandoffSource.js';
import { isValidExpertSlug, type ExpertSessionStore } from './expertSessions.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ExpertsHandlerDeps {
  /** Directory holding one sub-directory per expert (production: ~/.cindy-harness/experts). */
  rootDir: string;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production: send to every BrowserWindow. */
  broadcast(channel: string, payload: unknown): void;
  /** Directory watcher; production default is the real `watchExperts`. Injected so tests need no native fs.watch. */
  watch?: typeof watchExperts;
  /** ROADMAP 3.2a: pending pick + session bindings. Omit to register the list only. */
  sessions?: ExpertSessionStore;
  /** ROADMAP 3.8: owner approval of expert drafts. Omit to register without it. */
  drafts?: ExpertDraftConfirm;
  /** ROADMAP 3.6b: a stored session for "Ask expert" (production: DB rows). Needs `sessions`. */
  handoffSource?: (sessionId: string) => Promise<ExpertHandoffSource | null>;
}

export interface ExpertHandoffSource {
  title: string;
  agent: string;
  model?: string;
  /** ROADMAP 3.10c: where the source task ran and its access level, for "Go ahead". */
  workingDir?: string | null;
  permissionMode?: string | null;
  rows: HandoffSourceMessage[];
}

export type ExpertHandoffResult =
  | {
      ok: true;
      slug: string;
      prompt: string;
      model?: string;
      includedMessages: number;
      omittedMessages: number;
      truncated: boolean;
    }
  | { ok: false; reason: 'invalid' | 'expert-unavailable' | 'no-session' | 'no-messages'; message: string };

async function buildHandoff(
  deps: ExpertsHandlerDeps,
  sessions: ExpertSessionStore,
  source: NonNullable<ExpertsHandlerDeps['handoffSource']>,
  request: unknown,
): Promise<ExpertHandoffResult> {
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  if (!sessionId || !isValidExpertSlug(r.slug)) return { ok: false, reason: 'invalid', message: 'invalid session or expert' };
  const slug = r.slug;
  // Check the expert before reading any session data.
  const entry = loadExpert(path.join(deps.rootDir, slug));
  if (!entry.expert) {
    return { ok: false, reason: 'expert-unavailable', message: `Expert "${slug}" cannot be loaded: ${entry.error ?? 'unknown error'}` };
  }
  if (entry.expert.agent !== 'hermes') {
    return { ok: false, reason: 'expert-unavailable', message: `Expert "${entry.expert.name}" is set to agent "${entry.expert.agent}"; only Hermes experts can be asked yet.` };
  }
  const found = await source(sessionId);
  if (!found) return { ok: false, reason: 'no-session', message: 'that session was not found' };
  const handoff = buildExpertHandoff(entry.expert, {
    title: found.title,
    agent: found.agent,
    ...(found.model ? { model: found.model } : {}),
    messages: toExpertHandoffMessages(found.rows),
  });
  if ('error' in handoff) {
    return { ok: false, reason: handoff.error === 'no-messages' ? 'no-messages' : 'expert-unavailable', message: handoff.message };
  }
  sessions.setPending(slug);
  return {
    ok: true,
    slug,
    prompt: handoff.prompt,
    ...(entry.expert.model ? { model: entry.expert.model } : {}),
    includedMessages: handoff.includedMessages,
    omittedMessages: handoff.omittedMessages,
    truncated: handoff.truncated,
  };
}

export type GoAheadResult =
  | {
      ok: true;
      prompt: string;
      workingDir: string | null;
      permissionMode: string | null;
      includedMessages: number;
      omittedMessages: number;
      truncated: boolean;
    }
  | { ok: false; reason: 'invalid' | 'not-locked' | 'no-session' | 'no-messages'; message: string };

async function buildGoAhead(
  sessions: ExpertSessionStore,
  source: NonNullable<ExpertsHandlerDeps['handoffSource']>,
  request: unknown,
): Promise<GoAheadResult> {
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  if (!sessionId) return { ok: false, reason: 'invalid', message: 'invalid session' };
  // Only a chat locked by its expert offers "Go ahead"; check that before reading any session data.
  let toolsets: string[] | null;
  try {
    toolsets = sessions.expertToolsets(sessionId);
  } catch (error) {
    return { ok: false, reason: 'not-locked', message: error instanceof Error ? error.message : String(error) };
  }
  if (!toolsets || toolsets.length === 0) {
    return { ok: false, reason: 'not-locked', message: 'Go ahead is only offered in a chat locked by its expert (for example Options first).' };
  }
  const found = await source(sessionId);
  if (!found) return { ok: false, reason: 'no-session', message: 'that session was not found' };
  const handoff = buildGoAheadHandoff({
    title: found.title,
    agent: found.agent,
    ...(found.model ? { model: found.model } : {}),
    messages: toExpertHandoffMessages(found.rows),
  });
  if ('error' in handoff) return { ok: false, reason: 'no-messages', message: handoff.message };
  // The new task has no expert: drop any pending pick so its first send binds nothing.
  sessions.setPending(null);
  return {
    ok: true,
    prompt: handoff.prompt,
    workingDir: found.workingDir ?? null,
    permissionMode: found.permissionMode ?? null,
    includedMessages: handoff.includedMessages,
    omittedMessages: handoff.omittedMessages,
    truncated: handoff.truncated,
  };
}

/** What the Settings editor sends to `EXPERTS_SAVE`. */
export type ExpertSaveRequest =
  | { op: 'create'; slug: string; fields: unknown }
  | { op: 'duplicate'; from: string; slug: string; name: string }
  | { op: 'edit'; slug: string; baseHash: string; fields: unknown };

const readFileUtf8 = (file: string): string => readFileSync(file, 'utf8');

function saveExpert(rootDir: string, request: unknown): ExpertSaveResult {
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (r.op) {
    case 'create': {
      // Create is the expert creator's write path: same checks, a new folder, no tools.
      const fields = (r.fields && typeof r.fields === 'object' ? r.fields : {}) as Record<string, unknown>;
      const res = writeExpertDraft(rootDir, { ...fields, slug: str(r.slug) } as Parameters<typeof writeExpertDraft>[1]);
      if (!res.ok) return res;
      return { ok: true, slug: str(r.slug).trim(), dir: res.dir, file: res.file, hash: hashExpertMarkdown(readFileUtf8(res.file)) };
    }
    case 'duplicate':
      return duplicateExpert(rootDir, str(r.from), { slug: r.slug, name: r.name });
    case 'edit':
      return saveExpertEdit(rootDir, str(r.slug), { baseHash: str(r.baseHash), fields: r.fields });
    default:
      return { ok: false, reason: 'invalid', message: 'unknown expert save request' };
  }
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
  registry.handle(MAKER_INVOKE.EXPERTS_READ, (event, slug: unknown) => {
    deps.assertTrusted(event);
    return readExpertSource(deps.rootDir, typeof slug === 'string' ? slug : '');
  });
  registry.handle(MAKER_INVOKE.EXPERTS_SAVE, (event, request: unknown) => {
    deps.assertTrusted(event);
    const res = saveExpert(deps.rootDir, request);
    // Push at once; the watcher's debounced push follows and is harmless.
    if (res.ok) deps.broadcast(MAKER_PUSH.EXPERTS_CHANGED, loadExperts(deps.rootDir));
    return res;
  });
  const sessions = deps.sessions;
  const offSessionEvents = sessions?.onChange((event) => deps.broadcast(MAKER_PUSH.EXPERTS_SESSION_EVENT, event));
  if (sessions) {
    registry.handle(MAKER_INVOKE.EXPERTS_GET_PENDING, (event) => {
      deps.assertTrusted(event);
      return sessions.getPending();
    });
    registry.handle(MAKER_INVOKE.EXPERTS_SET_PENDING, (event, slug: unknown) => {
      deps.assertTrusted(event);
      if (slug !== null && !isValidExpertSlug(slug)) throw new Error('invalid expert slug');
      return sessions.setPending(slug);
    });
    registry.handle(MAKER_INVOKE.EXPERTS_SESSION_BINDING, (event, sessionId: unknown) => {
      deps.assertTrusted(event);
      if (typeof sessionId !== 'string' || !sessionId) return null;
      return sessions.describeBinding(sessionId);
    });
    const source = deps.handoffSource;
    if (source) {
      registry.handle(MAKER_INVOKE.EXPERTS_HANDOFF, (event, request: unknown) => {
        deps.assertTrusted(event);
        return buildHandoff(deps, sessions, source, request);
      });
      registry.handle(MAKER_INVOKE.EXPERTS_GO_AHEAD, (event, request: unknown) => {
        deps.assertTrusted(event);
        return buildGoAhead(sessions, source, request);
      });
    }
  }
  const drafts = deps.drafts;
  const offDraftEvents = drafts?.onChange((event) => deps.broadcast(MAKER_PUSH.EXPERTS_DRAFT_EVENT, event));
  if (drafts) {
    registry.handle(MAKER_INVOKE.EXPERTS_DRAFT_LIST, (event, sessionId: unknown) => {
      deps.assertTrusted(event);
      return drafts.list(typeof sessionId === 'string' && sessionId ? sessionId : undefined);
    });
    registry.handle(MAKER_INVOKE.EXPERTS_DRAFT_DECIDE, (event, requestId: unknown, decision: unknown) => {
      deps.assertTrusted(event);
      return drafts.decide(requestId, decision);
    });
  }
  return {
    dispose() {
      offDraftEvents?.();
      offSessionEvents?.();
      watcher?.close();
      watcher = undefined;
    },
  };
}
