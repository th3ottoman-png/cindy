/**
 * git-review council IPC (ROADMAP 11.4).
 *
 * Two channels, kept out of the large `ipc.ts` so the review surface stays readable:
 * - `git-review:council-options` returns the live picker list plus the remembered selection.
 * - `git-review:council-run` validates, dispatches every selected reviewer in parallel, and
 *   returns the consensus verdict.
 *
 * The diff is read through the same `readReviewData` path the Review panel uses, wrapped in
 * `withSessionReviewExecution`, so a remote session reviews its remote working tree rather than
 * this machine's.
 */

import { discoverEndpoints } from '@cindy/maker-core/providers-discovery';
import { requestRouteTargetText } from '@cindy/maker-core/routed-auxiliary';
import type { CouncilDiffFile } from '@cindy/maker-core/council-review';
import * as path from 'node:path';
import { ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import {
  COUNCIL_DEFAULT_TIMEOUT_MS,
  readCouncilCatalogue,
  readCouncilSelectionFile,
  runCouncilReview,
  writeCouncilSelectionFile,
  type CouncilModelOption,
  type CouncilReviewDeps,
} from './councilReview.js';
import { readReviewData } from './ipc.js';
import { withSessionReviewExecution } from './sshReviewBackend.js';
import { WorktreeCouncilHost } from '../worktree/worktreeCouncil.js';

/** ROADMAP 11.11: worktree Council review and the gated "Merge to Main Worktree". */
export const WORKTREE_COUNCIL_INVOKE = {
  STATUS: 'worktree:council-status',
  RUN: 'worktree:council-run',
  MERGE_CLEANUP: 'worktree:merge-cleanup',
} as const;

export const COUNCIL_REVIEW_INVOKE = {
  OPTIONS: 'git-review:council-options',
  RUN: 'git-review:council-run',
} as const;

/**
 * A review is a short structured answer, but a local reasoning model spends most of the budget
 * thinking before it emits any JSON. 2k was measured to run out mid-thought on a 12-line diff,
 * so the cap is sized for reasoning plus the findings list, not for the findings alone.
 */
const COUNCIL_MAX_TOKENS = 8_000;
const COUNCIL_SYSTEM_PROMPT =
  'You review code diffs and report concrete defects as JSON. You never comment on style.';

export interface CouncilIpcOptions {
  /** Production: ~/.cindy-harness/providers.yaml. */
  providersFile: string;
  /** Production: ~/.cindy-harness/routing.yaml (the managed council block lives here). */
  routingFile: string;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted?: (event: unknown) => void;
  /** Keys for provider discovery; production merges the Hermes home `.env` over process.env. */
  env?: () => Record<string, string | undefined>;
  discover?: typeof discoverEndpoints;
  dispatch?: typeof requestRouteTargetText;
  timeoutMs?: number;
}

export interface CouncilOptionsResponse {
  reviewers: CouncilModelOption[];
  selection: { providerId: string; model: string }[];
}

/** Only text diffs the panel would render anyway; binaries and over-size files are skipped. */
async function readCouncilDiffFiles(sessionId: string): Promise<CouncilDiffFile[]> {
  const data = await readReviewData(sessionId);
  const files: CouncilDiffFile[] = [];
  for (const diff of [...data.diffs.staged, ...data.diffs.unstaged]) {
    if (diff.isBinary || diff.isTooLarge || !diff.rawPatch) continue;
    files.push({ path: diff.path, patch: diff.rawPatch });
  }
  return files;
}

export function registerCouncilReviewIpc(options: CouncilIpcOptions): void {
  const log = createLogger('git-review/council');
  const assertTrusted = options.assertTrusted ?? (() => {});

  const readAvailable = (): Promise<CouncilModelOption[]> => readCouncilCatalogue({
    providersFile: options.providersFile,
    ...(options.discover ? { discover: options.discover } : {}),
    ...(options.env ? { env: options.env() } : {}),
  });

  /** One place that knows how to reach a reviewer; the session review and the 11.11 worktree review share it. */
  const buildDeps = (readFiles: CouncilReviewDeps['readFiles']): CouncilReviewDeps => {
    const harnessDir = path.dirname(options.providersFile);
    const env = options.env?.() ?? process.env;
    return {
      readAvailable,
      readFiles,
      dispatch: async (reviewer, prompt, signal) => {
        const result = await (options.dispatch ?? requestRouteTargetText)(
          {
            provider: reviewer.providerId,
            model: reviewer.model,
            prompt,
            systemPrompt: COUNCIL_SYSTEM_PROMPT,
            maxTokens: COUNCIL_MAX_TOKENS,
            timeoutMs: options.timeoutMs ?? COUNCIL_DEFAULT_TIMEOUT_MS,
            signal,
            // A local reasoning model often returns its JSON in `reasoning_content` with an
            // empty `content`. The council only needs to find JSON anywhere in the reply.
            acceptReasoningContent: true,
          },
          { harnessDir, env },
        );
        return result.kind === 'ok'
          ? { ok: true, text: result.text }
          : { ok: false, reason: `${result.reason}: ${result.message}`.slice(0, 200) };
      },
      readSelection: () => readCouncilSelectionFile(options.routingFile),
      writeSelection: (reviewers) => writeCouncilSelectionFile(options.routingFile, reviewers),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      log: (message, fields) => log.info(message, fields),
    };
  };

  ipcMain.handle(COUNCIL_REVIEW_INVOKE.OPTIONS, async (event): Promise<CouncilOptionsResponse> => {
    assertTrusted(event);
    try {
      const [reviewers, selection] = await Promise.all([
        readAvailable(),
        readCouncilSelectionFile(options.routingFile),
      ]);
      return { reviewers, selection };
    } catch (error) {
      log.warn('council options failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throwIpcError('INTERNAL', 'could not read the reviewer list');
    }
  });

  ipcMain.handle(COUNCIL_REVIEW_INVOKE.RUN, async (event, payload: unknown) => {
    assertTrusted(event);
    const body = requireObject(payload, 'councilReview');
    const sessionId = requireString(body.sessionId, 'sessionId');
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    const deps = buildDeps(() => withSessionReviewExecution(sessionId, () => readCouncilDiffFiles(sessionId)));

    return runCouncilReview(
      { reviewers: body.reviewers, ...(note ? { note } : {}) },
      deps,
    );
  });

  // ── ROADMAP 11.11: Council review of a task worktree and the gated merge + cleanup ──────────
  const worktreeCouncil = new WorktreeCouncilHost({
    getForSession: async (sessionId) => (await import('../worktree/WorktreeManager.js')).getForSession(sessionId),
    readSelection: () => readCouncilSelectionFile(options.routingFile),
    runCouncil: async (files, reviewers) => {
      const result = await runCouncilReview(
        { reviewers, note: 'This is the full diff of an isolated task worktree branch against its base branch.' },
        buildDeps(async () => files),
      );
      return result.ok ? { ok: true, verdict: result.verdict } : result;
    },
    // The merge is the owner's go-ahead to retire this task worktree; the guarded recycle path
    // still refuses while another session references it and keeps a recovery snapshot.
    removeWorktree: async (sessionId) =>
      (await import('../worktree/WorktreeManager.js')).removeWorktreeForSession(sessionId, { canRemove: async () => true }),
  });
  const worktreeSessionId = (payload: unknown): string =>
    requireString(requireObject(payload, 'worktreeCouncil').sessionId, 'sessionId');

  ipcMain.handle(WORKTREE_COUNCIL_INVOKE.STATUS, async (event, payload: unknown) => {
    assertTrusted(event);
    return worktreeCouncil.status(worktreeSessionId(payload));
  });
  ipcMain.handle(WORKTREE_COUNCIL_INVOKE.RUN, async (event, payload: unknown) => {
    assertTrusted(event);
    const auto = Boolean((payload as { auto?: unknown } | null)?.auto === true);
    return worktreeCouncil.run(worktreeSessionId(payload), { auto });
  });
  ipcMain.handle(WORKTREE_COUNCIL_INVOKE.MERGE_CLEANUP, async (event, payload: unknown) => {
    assertTrusted(event);
    return worktreeCouncil.mergeAndCleanup(worktreeSessionId(payload));
  });
}
