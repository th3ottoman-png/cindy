/**
 * ROADMAP 1.14: the daemon session id names the per-session Hermes home, so it has to be
 * stable for one Cindy conversation across app restarts. A per-start UUID gave every restart
 * a fresh home with an empty `state.db`, and `hermes chat --resume` could not resolve the
 * conversation there — the agent forgot everything while Cindy's own transcript survived.
 *
 * The `cindy-` namespace keeps a derived id from ever colliding with a legacy UUID record.
 */
import { randomUUID } from 'node:crypto';

export function hermesDaemonSessionId(cindySessionId?: string | null): string {
  const id = cindySessionId?.trim();
  // No Cindy conversation to key on (a throwaway worker run): stay unique per start.
  if (!id) return randomUUID();
  return `cindy-${id.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}
