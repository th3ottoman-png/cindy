/**
 * Built-in adapters as extensions (ROADMAP 4.1b). The four agent classes are registered
 * into the 4.1a extension registry under the open slug `adapter`, and production
 * construction sites build them through `createAdapterAgent` instead of naming the
 * classes directly. Behaviour is unchanged on purpose: each factory is exactly
 * `new <Agent>(deps)` and every call site keeps building its own deps object.
 *
 * Adding an adapter never edits this module: a plugin registers
 * `{ kind: 'adapter', id: <slug>, value: (deps) => … }` through the 4.2 loader and the
 * untyped lens `createRegisteredAdapterAgent` resolves it (AGENTS §6.2 — no central
 * switch statement).
 */

import { getExtensionRegistry, type ExtensionRegistry } from '../extensions/registry.js';
import { ClaudeCodeAgent } from './claude-code/index.js';
import { CodexAgent } from './codex/index.js';
import { PiAgent } from './pi/index.js';
import { HermesAgent } from './hermes/agent.js';

/** The extension kind every agent adapter registers under. */
export const ADAPTER_EXTENSION_KIND = 'adapter';

/** Typed factories for the built-in adapters, keyed by `AgentKind`. */
export interface BuiltinAdapterFactories {
  'claude-code': (deps: ConstructorParameters<typeof ClaudeCodeAgent>[0]) => ClaudeCodeAgent;
  codex: (deps: ConstructorParameters<typeof CodexAgent>[0]) => CodexAgent;
  pi: (deps: ConstructorParameters<typeof PiAgent>[0]) => PiAgent;
  hermes: (deps: ConstructorParameters<typeof HermesAgent>[0]) => HermesAgent;
}

export type BuiltinAdapterKind = keyof BuiltinAdapterFactories;

const BUILTIN_ADAPTERS: {
  readonly [K in BuiltinAdapterKind]: { title: string; factory: BuiltinAdapterFactories[K] };
} = {
  'claude-code': { title: 'Claude Code', factory: (deps) => new ClaudeCodeAgent(deps) },
  codex: { title: 'Codex', factory: (deps) => new CodexAgent(deps) },
  pi: { title: 'Pi', factory: (deps) => new PiAgent(deps) },
  hermes: { title: 'Hermes', factory: (deps) => new HermesAgent(deps) },
};

/**
 * Registers the four built-in adapters. Idempotent: an id that is already registered
 * (a custom registration, or an earlier call) is kept, never overwritten.
 */
export function registerBuiltinAdapters(registry: ExtensionRegistry = getExtensionRegistry()): void {
  for (const id of Object.keys(BUILTIN_ADAPTERS) as BuiltinAdapterKind[]) {
    if (registry.get(ADAPTER_EXTENSION_KIND, id)) continue;
    const { title, factory } = BUILTIN_ADAPTERS[id];
    registry.register({ kind: ADAPTER_EXTENSION_KIND, id, title, source: 'builtin', value: factory });
  }
}

/**
 * Builds a built-in agent through the registry. Typed end to end per built-in kind;
 * fails closed with a clear error when the id is not registered.
 *
 * The four built-in overloads are spelled out explicitly on purpose: the same signature
 * written as one generic overload over `BuiltinAdapterFactories` fails argument
 * inference at consumer call sites (probed in cindy-headless, 2026-11-03).
 *
 * There is deliberately NO untyped `(id: string, deps: unknown)` overload on this
 * function: under TS 5.9 such a catch-all captures inline-object-literal calls even
 * when a matching literal-id overload exists, in either declaration order (the same
 * literals check clean once the catch-all is removed, and pre-typed deps resolve
 * correctly with it present; probed in cindy-headless, 2026-11-03). Built-in sites
 * silently got `unknown` and lost contextual typing. The untyped path is therefore a
 * separate entry point, not an overload.
 */
export function createAdapterAgent(
  id: 'claude-code',
  deps: ConstructorParameters<typeof ClaudeCodeAgent>[0],
  registry?: ExtensionRegistry,
): ClaudeCodeAgent;
export function createAdapterAgent(
  id: 'codex',
  deps: ConstructorParameters<typeof CodexAgent>[0],
  registry?: ExtensionRegistry,
): CodexAgent;
export function createAdapterAgent(
  id: 'pi',
  deps: ConstructorParameters<typeof PiAgent>[0],
  registry?: ExtensionRegistry,
): PiAgent;
export function createAdapterAgent(
  id: 'hermes',
  deps: ConstructorParameters<typeof HermesAgent>[0],
  registry?: ExtensionRegistry,
): HermesAgent;
export function createAdapterAgent(
  id: string,
  deps: unknown,
  registry: ExtensionRegistry = getExtensionRegistry(),
): unknown {
  return resolveAdapterAgent(id, deps, registry);
}

/**
 * Untyped lens over the same registry, for adapters registered outside this module
 * (the 4.2 plugin loader). Built-in call sites use the typed `createAdapterAgent`.
 * Fails closed with a clear error when the id is not registered.
 */
export function createRegisteredAdapterAgent(
  id: string,
  deps: unknown,
  registry: ExtensionRegistry = getExtensionRegistry(),
): unknown {
  return resolveAdapterAgent(id, deps, registry);
}

function resolveAdapterAgent(id: string, deps: unknown, registry: ExtensionRegistry): unknown {
  const descriptor = registry.get<(deps: unknown) => unknown>(ADAPTER_EXTENSION_KIND, id);
  if (!descriptor) throw new Error(`adapter not registered: ${id}`);
  return descriptor.value(deps);
}

// Importing this module makes the built-ins available process-wide, so a construction
// site can never race registration. ESM module caching keeps this a one-time effect.
registerBuiltinAdapters();
