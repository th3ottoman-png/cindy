/**
 * One-shot bridge for reproducing pinned notes into a new task.
 *
 * "New task from manifest" runs on a session view, before the fresh task has
 * an id. The notes wait here and are pinned by the first *different* Hermes
 * session view that mounts. Nothing is persisted by this module.
 */

interface PendingPins {
  sourceSessionId: string;
  notes: string[];
}

let pending: PendingPins | null = null;

export function setPendingManifestPins(sourceSessionId: string, notes: string[]): void {
  pending = notes.length ? { sourceSessionId, notes: [...notes] } : null;
}

/** Returns the pending notes only for a session that is not the source. */
export function takePendingManifestPins(sessionId: string): string[] | null {
  if (!pending || pending.sourceSessionId === sessionId) return null;
  const notes = pending.notes;
  pending = null;
  return notes;
}

export function peekPendingManifestPins(): string[] | null {
  return pending ? [...pending.notes] : null;
}

export function clearPendingManifestPins(): void {
  pending = null;
}
