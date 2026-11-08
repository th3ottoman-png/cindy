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

/* ------------------------------------------------------------------------- */
/* Capability descriptors (ROADMAP 8.1)                                      */
/* ------------------------------------------------------------------------- */

/**
 * One installable thing shown in the Capabilities hub. `kind` is an open slug,
 * never a union checked by a switch. A new kind arrives as a new
 * `CapabilitySource` and needs no edit here (AGENTS section 6.2).
 *
 * The registry records facts only. It never reads files, calls IPC, starts a
 * tool, or invokes a provider. Provenance is data, so every row can answer
 * "where did this come from?" without a second lookup.
 */
export type CapabilityTrust = 'builtin' | 'local-file' | 'community' | 'remote' | 'unknown';

export interface CapabilityDescriptor {
  /** Open slug, for example expert, skill, plugin, connector, mcp-server. */
  kind: string;
  /** Stable within its kind. */
  id: string;
  title: string;
  /** File, directory or config path this row came from. Shown as provenance. */
  source: string;
  /** Line in that file, when known. */
  sourceLine?: number;
  trust: CapabilityTrust;
  /** Declared interface: expert.md frontmatter, MCP stdio, SKILL.md, routing.yaml, ... */
  declaredInterface: string;
  enabled: boolean;
  /** False hides the row without deleting the descriptor. Defaults to true. */
  visible?: boolean;
  /** Plugin name this row provides, when the row is itself a plugin. */
  provides?: string;
  /** Plugin name this row depends on. Hidden when that plugin is unavailable. */
  requires?: string;
  subtitle?: string;
  detail?: string;
  tags?: string[];
  /** Optional renderer deep link, supplied by the source, never derived from a switch. */
  openPath?: string;
}

export interface CapabilitySource {
  /** Default kind for the descriptors this source emits. */
  kind: string;
  /** Unique within the registry. */
  id: string;
  declaredInterface: string;
  /** May reject. A missing optional source yields no rows and nothing else breaks. */
  read: () => readonly CapabilityDescriptor[] | Promise<readonly CapabilityDescriptor[]>;
}

export interface CapabilityRegistry {
  register(source: CapabilitySource): () => void;
  /** In registration order. */
  list(): readonly CapabilitySource[];
  /** Reads every source, isolates failures, then hides rows with missing dependencies. */
  collect(): Promise<CapabilityDescriptor[]>;
  subscribe(listener: () => void): () => void;
}

function isCapabilityDescriptor(value: unknown): value is CapabilityDescriptor {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<CapabilityDescriptor>;
  return (
    typeof d.kind === 'string' &&
    typeof d.id === 'string' &&
    typeof d.title === 'string' &&
    typeof d.source === 'string' &&
    typeof d.declaredInterface === 'string' &&
    typeof d.enabled === 'boolean'
  );
}

/** Plugin names provided by visible, enabled rows. Data driven, no kind switch. */
export function providedCapabilityPlugins(
  descriptors: readonly CapabilityDescriptor[],
): string[] {
  return descriptors.flatMap((d) =>
    d.provides && d.enabled && d.visible !== false ? [d.provides] : [],
  );
}

/** Fail open on convenience: a row whose optional plugin is missing disappears. */
export function visibleCapabilities(
  descriptors: readonly CapabilityDescriptor[],
  availablePlugins: readonly string[] = [],
): CapabilityDescriptor[] {
  const available = new Set(availablePlugins);
  return descriptors.filter(
    (d) => d.visible !== false && (d.requires === undefined || available.has(d.requires)),
  );
}

/** Kinds are derived from the rows, in first-seen order. Adding a kind needs no edit. */
export function groupCapabilitiesByKind(
  descriptors: readonly CapabilityDescriptor[],
): { kind: string; items: CapabilityDescriptor[] }[] {
  const groups = new Map<string, CapabilityDescriptor[]>();
  for (const descriptor of descriptors) {
    const items = groups.get(descriptor.kind);
    if (items) items.push(descriptor);
    else groups.set(descriptor.kind, [descriptor]);
  }
  return [...groups].map(([kind, items]) => ({ kind, items }));
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const sources = new Map<string, CapabilitySource>();
  const listeners = new Set<() => void>();
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
    register(source) {
      if (typeof source.id !== 'string' || !SLUG.test(source.id)) {
        throw new Error(`invalid capability source id "${String(source.id)}"`);
      }
      if (typeof source.kind !== 'string' || !SLUG.test(source.kind)) {
        throw new Error(`invalid capability kind "${String(source.kind)}"`);
      }
      if (sources.has(source.id)) {
        throw new Error(`capability source already registered: ${source.id}`);
      }
      sources.set(source.id, source);
      notify();
      return () => {
        if (sources.get(source.id) === source) {
          sources.delete(source.id);
          notify();
        }
      };
    },
    list() {
      return [...sources.values()];
    },
    async collect() {
      const settled = await Promise.allSettled(
        [...sources.values()].map((source) => Promise.resolve().then(() => source.read())),
      );
      const rows: CapabilityDescriptor[] = [];
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        for (const value of result.value ?? []) {
          if (isCapabilityDescriptor(value)) rows.push({ ...value });
        }
      }
      return visibleCapabilities(rows, providedCapabilityPlugins(rows));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const sharedCapabilities = createCapabilityRegistry();

export function getCapabilityRegistry(): CapabilityRegistry {
  return sharedCapabilities;
}

/** Register one source on the process-wide capability registry. */
export function registerCapabilitySource(source: CapabilitySource): () => void {
  return sharedCapabilities.register(source);
}
