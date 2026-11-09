import { useSyncExternalStore } from 'react';

/**
 * Open state for the Library workspace (ROADMAP 8.5). The sidebar row and the
 * panel live in different subtrees of MainLayout, so they share this tiny
 * external store. Renderer only: no persistence, no IPC, no window event.
 */

let isOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function setLibraryOpen(next: boolean): void {
  if (isOpen === next) return;
  isOpen = next;
  emit();
}

export function openLibrary(): void {
  setLibraryOpen(true);
}

export function closeLibrary(): void {
  setLibraryOpen(false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLibraryOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false,
  );
}
