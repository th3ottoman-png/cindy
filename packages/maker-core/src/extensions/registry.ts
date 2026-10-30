/**
 * Unified extension registry (ROADMAP 4.1a). One `registerExtension({kind, id, ...})` entry
 * point for adapters, tools, experts, model routes and UI panels. `kind` is an open slug, not
 * a union checked by a switch, so a new kind needs no edit here (AGENTS §6.2). The registry
 * only records and looks things up; it never calls an extension's `value`, so a broken
 * extension cannot break registration of the others. Nothing is migrated onto it yet (4.1b).
 */

export const KNOWN_EXTENSION_KINDS = ['adapter', 'tool', 'expert', 'route', 'panel'] as const;

export interface ExtensionDescriptor<T = unknown> {
  /** Open slug. The well-known kinds are in `KNOWN_EXTENSION_KINDS`. */
  kind: string;
  /** Unique within its kind. */
  id: string;
  /** Human label for lists; defaults to the id. */
  title?: string;
  /** Where it came from (file path, plugin name, "builtin"), for diagnostics. */
  source?: string;
  /** The thing itself: an adapter factory, tool definition, route, ... Opaque to the registry. */
  value: T;
}

export interface ExtensionRegistry {
  /** Throws on a bad slug or a duplicate (kind, id); returns a function that unregisters it. */
  register<T>(descriptor: ExtensionDescriptor<T>): () => void;
  get<T = unknown>(kind: string, id: string): ExtensionDescriptor<T> | undefined;
  /** In registration order. */
  list(kind?: string): ExtensionDescriptor[];
  /** A listener that throws is isolated from the others. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function createExtensionRegistry(): ExtensionRegistry {
  const entries = new Map<string, ExtensionDescriptor>();
  const listeners = new Set<() => void>();
  const key = (kind: string, id: string): string => `${kind}\u0000${id}`;
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // one bad subscriber must not stop the others
      }
    }
  };

  return {
    register(descriptor) {
      const { kind, id } = descriptor;
      if (typeof kind !== 'string' || !SLUG.test(kind)) throw new Error(`invalid extension kind "${String(kind)}"`);
      if (typeof id !== 'string' || !SLUG.test(id)) throw new Error(`invalid extension id "${String(id)}" for kind "${kind}"`);
      const k = key(kind, id);
      if (entries.has(k)) throw new Error(`extension already registered: ${kind}/${id}`);
      const stored = { ...descriptor } as ExtensionDescriptor;
      entries.set(k, stored);
      notify();
      return () => {
        if (entries.get(k) === stored) {
          entries.delete(k);
          notify();
        }
      };
    },
    get<T = unknown>(kind: string, id: string) {
      return entries.get(key(kind, id)) as ExtensionDescriptor<T> | undefined;
    },
    list(kind) {
      const all = [...entries.values()];
      return kind === undefined ? all : all.filter((e) => e.kind === kind);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const shared = createExtensionRegistry();

/** The process-wide registry. Tests should build their own with `createExtensionRegistry()`. */
export function getExtensionRegistry(): ExtensionRegistry {
  return shared;
}

/** `registerExtension({kind, id, value})` on the process-wide registry. */
export function registerExtension<T>(descriptor: ExtensionDescriptor<T>): () => void {
  return shared.register(descriptor);
}
