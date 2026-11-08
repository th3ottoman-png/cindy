import { useSyncExternalStore } from 'react';

/**
 * Open state for the Capabilities hub (ROADMAP 8.1). The sidebar row and the
 * dialog live in different subtrees of MainLayout, so they share this tiny
 * external store instead of threading a prop through the shell. Renderer only,
 * no persistence, no IPC, no window event.
 */

let isOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function setCapabilitiesHubOpen(next: boolean): void {
  if (isOpen === next) return;
  isOpen = next;
  emit();
}

export function openCapabilitiesHub(): void {
  setCapabilitiesHubOpen(true);
}

export function closeCapabilitiesHub(): void {
  setCapabilitiesHubOpen(false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCapabilitiesHubOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false,
  );
}
