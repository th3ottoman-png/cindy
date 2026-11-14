import { useRetitleAfterTurn } from '@/hooks/useRetitleAfterTurn';

/**
 * ROADMAP 13.9: reports the turn-end edge to main, which owns the whole re-title decision.
 * Renders nothing — a re-title must never add UI to the chat loop or block it.
 */
export function RetitleTrigger({ sessionId, running }: { sessionId: string; running: boolean }) {
  useRetitleAfterTurn(sessionId, running);
  return null;
}
