import type { IpcMain } from 'electron';
import {
  assembleHandoffPrompt,
  type HandoffMessage,
  type SessionHandoffResult,
} from '@cindy/maker-core/session-compaction-handoff';
import { MAKER_INVOKE } from './channels';

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
}
