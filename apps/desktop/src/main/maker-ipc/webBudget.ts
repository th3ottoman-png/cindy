/**
 * ROADMAP 13.5: bridge for the session manifest strip's `web N/M` chip.
 *
 * The daemon owns the count (it answers the `pre_tool_call` hook); this handler only maps the
 * Cindy session id to the daemon session id (ROADMAP 1.14) and asks `session/webBudget`. A
 * missing daemon or an old daemon without the method reads as `available: false`, so the chip
 * hides itself instead of guessing. Local IPC only: no network, no model call.
 */

import { hermesDaemonSessionId } from '@cindy/maker-core/hermes-daemon-session-id';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface WebBudgetView {
  available: boolean;
  used: number;
  /** 0 = unlimited. */
  max: number;
  toolNames: string[];
  errors: string[];
  file: string;
  /** False where Hermes never runs the hook (Default / safe mode, chat-only, cap 0). */
  enforced: boolean;
}

export const UNAVAILABLE_WEB_BUDGET: WebBudgetView = {
  available: false,
  used: 0,
  max: 0,
  toolNames: [],
  errors: [],
  file: '',
  enforced: false,
};

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Narrows a daemon answer to the view; anything malformed reads as unavailable. */
export function toWebBudgetView(raw: unknown): WebBudgetView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return UNAVAILABLE_WEB_BUDGET;
  const r = raw as Record<string, unknown>;
  if (typeof r.used !== 'number' || typeof r.max !== 'number') return UNAVAILABLE_WEB_BUDGET;
  return {
    available: true,
    used: asNumber(r.used),
    max: asNumber(r.max),
    toolNames: asStrings(r.toolNames),
    errors: asStrings(r.errors),
    file: typeof r.file === 'string' ? r.file : '',
    enforced: r.enforced === true,
  };
}

export async function readWebBudget(
  sessionId: unknown,
  request: (daemonSessionId: string) => Promise<unknown>,
): Promise<WebBudgetView> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return UNAVAILABLE_WEB_BUDGET;
  try {
    return toWebBudgetView(await request(hermesDaemonSessionId(sessionId)));
  } catch {
    return UNAVAILABLE_WEB_BUDGET;
  }
}

export function registerWebBudgetHandlers(
  registry: IpcHandlerRegistry,
  deps: {
    request: (daemonSessionId: string) => Promise<unknown>;
    assertTrusted: (event: unknown) => void;
  },
): void {
  registry.handle(MAKER_INVOKE.WEB_BUDGET_GET, (event: unknown, sessionId: unknown) => {
    deps.assertTrusted(event);
    return readWebBudget(sessionId, deps.request);
  });
}
