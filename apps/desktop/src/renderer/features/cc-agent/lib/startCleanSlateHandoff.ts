/**
 * ROADMAP 11.5: 1-click clean-slate session handoff.
 *
 * Assembles the clean-slate payload in the host (constraints, uncommitted diff,
 * unresolved questions), then spawns a fresh session seeded with it and sends the
 * first turn immediately: the payload is mounted directly into the fresh session
 * and auto-spawns, so the owner never has to re-explain the task.
 *
 * Once the fresh session is seeded, the bloated source session's agent process is
 * closed (row: "terminating the bloated session"). It is a soft close
 * (`preserveWorkspace`): the fresh session works in the same directory/worktree, so
 * the source is neither archived nor allowed to recycle that workspace. Its transcript
 * stays readable and it restarts on the next message if the owner goes back.
 */
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';

export interface CleanSlateHandoffOutcome {
  ok: boolean;
  sessionId?: string;
  /** Whether the source session's agent process was closed after the handoff. */
  sourceClosed?: boolean;
  error?: string;
}

export async function startCleanSlateHandoff(
  session: Session,
  options?: { navigate?: (to: string) => void },
): Promise<CleanSlateHandoffOutcome> {
  const cleanSlate = window.electronAPI?.maker?.sessionHandoff?.cleanSlate;
  if (!cleanSlate) return { ok: false, error: 'sessionHandoff API unavailable' };

  const res = await cleanSlate({ sessionId: session.id });
  if (!res.ok || !res.prompt) {
    return { ok: false, error: res.error || 'Clean-slate handoff payload could not be built.' };
  }

  const nextSession = await sessionService.create({
    title: res.title || `${session.title || 'Session'} (clean slate)`,
    workingDir: session.workingDir ?? undefined,
    workspaceKind: session.workspaceKind,
    agentKind: session.agentKind,
    model: session.model,
    providerId: session.providerId,
    permissionMode: session.permissionMode,
  });
  await makerChatStore.sendMessage(
    nextSession.id,
    res.prompt,
    nextSession.model || session.model || 'hermes-default',
    nextSession.effort || session.effort || 'medium',
    nextSession.permissionMode || session.permissionMode || 'default',
    nextSession.workingDir || session.workingDir || '/',
  );
  let sourceClosed = false;
  const closeSession = window.electronAPI?.maker?.closeSession;
  if (closeSession) {
    try {
      await closeSession(session.id, { preserveWorkspace: true });
      sourceClosed = true;
    } catch {
      // The fresh session already carries the task; a stuck source close must not undo that.
    }
  }
  const route = `/cc-agent/${nextSession.id}`;
  if (options?.navigate) options.navigate(route);
  else if (typeof window !== 'undefined') window.location.hash = `#${route}`;
  return { ok: true, sessionId: nextSession.id, sourceClosed };
}
