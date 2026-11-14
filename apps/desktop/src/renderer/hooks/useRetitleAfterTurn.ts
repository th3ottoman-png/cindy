import { useEffect, useRef } from 'react';

export interface RetitleEdgeState {
  id: string | undefined;
  running: boolean;
}

/**
 * ROADMAP 13.9: ask main once per running-to-idle edge, and only within the same session.
 * Switching sessions is not a turn end, so it never asks.
 */
export function shouldAskRetitle(prev: RetitleEdgeState, next: RetitleEdgeState): boolean {
  if (!next.id || next.running) return false;
  return prev.id === next.id && prev.running;
}

/**
 * Titles that follow the conversation (ROADMAP 13.9). Main owns the whole decision —
 * routing, ownership, the six-turn floor and the model call. This only reports the edge,
 * fire-and-forget, so a re-title can never block or break the chat loop.
 */
export function useRetitleAfterTurn(sessionId: string | undefined, running: boolean): void {
  const last = useRef<RetitleEdgeState>({ id: undefined, running: false });
  useEffect(() => {
    const prev = last.current;
    const next = { id: sessionId, running };
    last.current = next;
    if (!shouldAskRetitle(prev, next)) return;
    void window.electronAPI.maker.retitle
      .maybe({ sessionId: next.id as string, running: false })
      .catch(() => undefined);
  }, [sessionId, running]);
}
