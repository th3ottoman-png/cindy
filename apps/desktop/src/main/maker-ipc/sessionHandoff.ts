import type { IpcMain } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleHandoffPrompt,
  extractPendingNextActions,
  extractSessionConstraints,
  extractSessionDecisions,
  type HandoffMessage,
  type SessionHandoffResult,
} from '@cindy/maker-core/session-compaction-handoff';
import {
  assembleSessionHandoff,
  extractOpenQuestions,
  filterCompletedPendingSteps,
  isCleanSlateHandoffText,
  parseCleanSlateHandoffPendingSteps,
  type SessionHandoffTruncation,
} from '@cindy/maker-core/session-handoff';
import { MAKER_INVOKE } from './channels';

/**
 * Stored user/assistant rows carry `{ text, images, files }` (as an object or as JSON
 * text). Their prose is `text`; stringifying the wrapper leaked `","images":[]…` into
 * the handoff's pending steps (live proof 2026-11-12). Tool rows keep the JSON form.
 */
function storedContentText(role: unknown, content: unknown): string | undefined {
  let value = content;
  if (
    (role === 'user' || role === 'assistant') &&
    typeof value === 'string' &&
    value.startsWith('{')
  ) {
    try {
      value = JSON.parse(value);
    } catch {
      return content as string;
    }
  }
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as { text?: unknown }).text;
  if ((role === 'user' || role === 'assistant') && typeof text === 'string') return text;
  return typeof content === 'string' ? content : JSON.stringify(value);
}

export interface StoredSessionInfo {
  id?: string;
  title?: string | null;
  agentKind?: string | null;
  model?: string | null;
  workingDir?: string | null;
  expertSlug?: string | null;
}

export interface SessionHandoffHostDeps {
  getSessionRow: (sessionId: string) => Promise<StoredSessionInfo | null>;
  listMessages: (sessionId: string) => Promise<HandoffMessage[]>;
  /** Raw text of the vault `Synthesis.md` note, or null when unconfigured/missing. */
  readSynthesisNote?: () => Promise<string | null>;
  /** Uncommitted working tree state of the session workdir. Defaults to real git. */
  gatherGitState?: (workingDir: string) => Promise<WorkingTreeState>;
}

export interface WorkingTreeState {
  gitDiff: string;
  modifiedFiles: string[];
}

/**
 * Uncommitted tracked changes (`git diff HEAD`) plus `git status --porcelain`
 * paths, gathered with a timeout and capped buffer. A non-git directory or a
 * git failure yields an empty state, never a rejected handoff: the payload's
 * other sections still carry the work forward.
 */
export function gatherGitWorkingTree(workingDir: string): Promise<WorkingTreeState> {
  const run = (args: readonly string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        'git',
        [...args],
        { cwd: workingDir, timeout: 8_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout) => resolve(error ? '' : String(stdout)),
      );
    });
  return (async () => {
    const [status, gitDiff] = await Promise.all([
      run(['status', '--porcelain']),
      run(['diff', 'HEAD', '--no-color']),
    ]);
    const modifiedFiles = status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return { gitDiff, modifiedFiles };
  })();
}

/**
 * Read the vault `Cindy/Memory/Synthesis.md` note (6.3's cross-session memory
 * synthesis) as raw markdown. Missing note or unconfigured vault yields null;
 * the handoff then reports its constraints section as "None recorded.".
 */
export function readSynthesisNoteFromVault(vaultDir: string | undefined | null): string | null {
  if (!vaultDir) return null;
  try {
    return readFileSync(join(vaultDir, 'Cindy', 'Memory', 'Synthesis.md'), 'utf8');
  } catch {
    return null;
  }
}

export type BuildHandoffResponse =
  | {
      ok: true;
      handoff: SessionHandoffResult;
    }
  | {
      ok: false;
      reason: 'no-session' | 'no-messages' | 'internal-error';
      message: string;
    };

export interface ExecuteHandoffResponse {
  ok: boolean;
  prompt: string;
  title: string;
  workingDir?: string;
  model?: string;
  expertSlug?: string;
  error?: string;
}

export interface CleanSlateHandoffResponse {
  ok: boolean;
  prompt: string;
  title: string;
  workingDir?: string;
  model?: string;
  /** Estimated tokens of the assembled payload (ROADMAP 11.5 budget guard). */
  tokenCount: number;
  truncated?: SessionHandoffTruncation;
  error?: string;
}

export class SessionHandoffHost {
  constructor(private readonly deps: SessionHandoffHostDeps) {}

  async buildHandoff(sessionId: string): Promise<BuildHandoffResponse> {
    if (!sessionId || typeof sessionId !== 'string') {
      return { ok: false, reason: 'no-session', message: 'Invalid or missing sessionId' };
    }

    try {
      const session = await this.deps.getSessionRow(sessionId);
      if (!session) {
        return { ok: false, reason: 'no-session', message: `Session not found: ${sessionId}` };
      }

      const messages = await this.deps.listMessages(sessionId);
      if (!messages || messages.length === 0) {
        return { ok: false, reason: 'no-messages', message: `Session ${sessionId} has no messages` };
      }

      const result = assembleHandoffPrompt({
        sessionId,
        sessionTitle: session.title || undefined,
        workingDir: session.workingDir || undefined,
        model: session.model || undefined,
        expertSlug: session.expertSlug || undefined,
        messages,
      });

      return {
        ok: true,
        handoff: result,
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'internal-error',
        message: (err as Error).message,
      };
    }
  }

  async executeHandoff(sessionId: string): Promise<ExecuteHandoffResponse> {
    const buildRes = await this.buildHandoff(sessionId);
    if (!buildRes.ok) {
      return {
        ok: false,
        prompt: '',
        title: '',
        error: buildRes.message,
      };
    }

    const session = await this.deps.getSessionRow(sessionId);
    const title = session?.title ? `Continuation of ${session.title}` : 'Continued Session';

    return {
      ok: true,
      prompt: buildRes.handoff.prompt,
      title,
      workingDir: session?.workingDir || undefined,
      model: session?.model || undefined,
      expertSlug: session?.expertSlug || undefined,
    };
  }

  /**
   * ROADMAP 11.5: clean-slate handoff payload. Sources: the vault `Synthesis.md`
   * note for active decisions/constraints, the session workdir's uncommitted
   * diff and modified files, and the transcript's unresolved questions and next
   * steps. Assembly and redaction happen in `@cindy/maker-core/session-handoff`;
   * this method only gathers.
   */
  async buildCleanSlateHandoff(sessionId: string): Promise<CleanSlateHandoffResponse> {
    const failure = (error: string): CleanSlateHandoffResponse => ({
      ok: false,
      prompt: '',
      title: '',
      tokenCount: 0,
      error,
    });
    if (!sessionId || typeof sessionId !== 'string') return failure('Invalid or missing sessionId');

    try {
      const session = await this.deps.getSessionRow(sessionId);
      if (!session) return failure(`Session not found: ${sessionId}`);

      const rawMessages = (await this.deps.listMessages(sessionId)) ?? [];
      // DB content is JSON-parsed (objects for tool calls, strings for prose).
      // The extraction helpers expect string text; normalise here.
      const messages: HandoffMessage[] = rawMessages.map((m) => ({
        role: m.role,
        content: storedContentText(m.role, m.content),
        text: typeof m.text === 'string' ? m.text : undefined,
      }));
      const [synthesis, tree] = await Promise.all([
        this.deps.readSynthesisNote?.() ?? Promise.resolve(null),
        session.workingDir
          ? (this.deps.gatherGitState ?? gatherGitWorkingTree)(session.workingDir)
          : Promise.resolve({ gitDiff: '', modifiedFiles: [] } satisfies WorkingTreeState),
      ]);

      // ROADMAP 11.5 follow-up: a handoff of a handoff must not read its own payload as a
      // conversation turn (it re-listed steps the fresh session had already done). Payloads
      // are separated out, their carried steps are read back, and a carried step is dropped
      // only when a later assistant sentence reports it as done.
      const payloads = messages.filter((m) => isCleanSlateHandoffText(m.content ?? m.text));
      const conversation = messages.filter((m) => !isCleanSlateHandoffText(m.content ?? m.text));
      const lastPayload = payloads[payloads.length - 1];
      const afterPayload = lastPayload ? messages.slice(messages.indexOf(lastPayload) + 1) : [];
      const carried = lastPayload
        ? filterCompletedPendingSteps(
            parseCleanSlateHandoffPendingSteps(lastPayload.content ?? lastPayload.text ?? ''),
            afterPayload,
          )
        : [];
      const extracted = extractPendingNextActions(conversation);
      const pendingNextSteps = carried.length
        ? [...carried, ...extracted.filter((step) => !carried.includes(step))]
        : extracted;

      const payload = assembleSessionHandoff({
        synthesis,
        gitDiff: tree.gitDiff,
        modifiedFiles: tree.modifiedFiles,
        activeDecisions: extractSessionDecisions(conversation),
        constraints: extractSessionConstraints(conversation),
        pendingNextSteps,
        unresolvedQuestions: extractOpenQuestions(conversation),
        workingDir: session.workingDir || null,
        sessionTitle: session.title || null,
      });

      return {
        ok: true,
        prompt: payload.prompt,
        title: session.title ? `Clean slate from ${session.title}` : 'Clean Slate Session',
        workingDir: session.workingDir || undefined,
        model: session.model || undefined,
        tokenCount: payload.tokenCount,
        truncated: payload.truncated,
      };
    } catch (err) {
      return failure((err as Error).message);
    }
  }
}

let singletonHost: SessionHandoffHost | null = null;

export function getSessionHandoffHost(deps?: SessionHandoffHostDeps): SessionHandoffHost {
  if (!singletonHost || deps) {
    if (!deps) throw new Error('SessionHandoffHost requires dependencies on first call');
    singletonHost = new SessionHandoffHost(deps);
  }
  return singletonHost;
}

export function registerSessionHandoffHandlers(
  ipc: IpcMain,
  getHost: () => SessionHandoffHost,
  assertSenderTrusted?: (event: { senderFrame?: unknown }) => void,
): void {
  ipc.handle(MAKER_INVOKE.SESSION_HANDOFF_BUILD, async (event, params: { sessionId: string }) => {
    assertSenderTrusted?.(event);
    const host = getHost();
    return host.buildHandoff(params?.sessionId || '');
  });

  ipc.handle(MAKER_INVOKE.SESSION_HANDOFF_EXECUTE, async (event, params: { sessionId: string }) => {
    assertSenderTrusted?.(event);
    const host = getHost();
    return host.executeHandoff(params?.sessionId || '');
  });

  ipc.handle(
    MAKER_INVOKE.SESSION_HANDOFF_CLEAN_SLATE,
    async (event, params: { sessionId: string }) => {
      assertSenderTrusted?.(event);
      const host = getHost();
      return host.buildCleanSlateHandoff(params?.sessionId || '');
    },
  );
}
