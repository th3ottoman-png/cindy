import { describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAgent } from '../claude-code/index.js';
import { CodexAgent } from '../codex/index.js';
import { PiAgent } from '../pi/index.js';
import { HermesAgent } from '../hermes/agent.js';
import { createExtensionRegistry, getExtensionRegistry } from '../../extensions/registry.js';
import type { Logger } from '../../interfaces/logger.js';
import {
  ADAPTER_EXTENSION_KIND,
  createAdapterAgent,
  createRegisteredAdapterAgent,
  registerBuiltinAdapters,
} from '../adapter-extensions.js';

const logger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => logger,
};

describe('adapter extensions (ROADMAP 4.1b)', () => {
  it('registers the four built-in adapters into an injected registry', () => {
    const reg = createExtensionRegistry();
    registerBuiltinAdapters(reg);

    expect(reg.list(ADAPTER_EXTENSION_KIND).map((e) => e.id)).toEqual([
      'claude-code',
      'codex',
      'pi',
      'hermes',
    ]);
    for (const entry of reg.list(ADAPTER_EXTENSION_KIND)) {
      expect(entry.source).toBe('builtin');
      expect(typeof entry.value).toBe('function');
    }
    // adapters are visible under one open-slug kind, not a switch over class names
    expect(ADAPTER_EXTENSION_KIND).toBe('adapter');
  });

  it('self-registers the built-ins into the shared registry on import', () => {
    const shared = getExtensionRegistry();
    for (const id of ['claude-code', 'codex', 'pi', 'hermes']) {
      expect(shared.get(ADAPTER_EXTENSION_KIND, id)).toBeDefined();
    }
  });

  it('is idempotent and never overwrites an existing registration', () => {
    const reg = createExtensionRegistry();
    const customFactory = vi.fn(() => 'custom-claude');
    reg.register({ kind: ADAPTER_EXTENSION_KIND, id: 'claude-code', value: customFactory });

    registerBuiltinAdapters(reg);
    expect(() => registerBuiltinAdapters(reg)).not.toThrow();

    // first registration wins; the built-in must not clobber it
    expect(reg.get(ADAPTER_EXTENSION_KIND, 'claude-code')?.value).toBe(customFactory);
    expect(reg.list(ADAPTER_EXTENSION_KIND)).toHaveLength(4);
  });

  it('createAdapterAgent returns exactly what the factory returns and forwards deps by identity', () => {
    const reg = createExtensionRegistry();
    const product = { marker: 'constructed' };
    const factory = vi.fn((_deps: unknown) => product);
    reg.register({ kind: ADAPTER_EXTENSION_KIND, id: 'codex', value: factory });
    const deps = { marker: 'deps' };

    const result = createAdapterAgent('codex', deps as never, reg);

    expect(result).toBe(product);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toBe(deps);
  });

  it('fails closed with a clear error for an unregistered adapter', () => {
    const reg = createExtensionRegistry();
    expect(() => createAdapterAgent('claude-code', {} as never, reg)).toThrow(
      'adapter not registered: claude-code',
    );
  });

  it('resolves an adapter a plugin registered, with no edit to this module', () => {
    const reg = createExtensionRegistry();
    registerBuiltinAdapters(reg);
    const product = { marker: 'plugin-adapter' };
    reg.register({
      kind: ADAPTER_EXTENSION_KIND,
      id: 'my-adapter',
      source: 'plugin:demo',
      value: () => product,
    });

    expect(createRegisteredAdapterAgent('my-adapter', {}, reg)).toBe(product);
  });

  it('built-in factories construct the real agent classes', () => {
    const reg = createExtensionRegistry();
    registerBuiltinAdapters(reg);
    const minimalDeps = { logger, binaryPath: process.execPath, runtimeConfig: {}, auth: {} };

    expect(
      createAdapterAgent(
        'claude-code',
        minimalDeps as ConstructorParameters<typeof ClaudeCodeAgent>[0],
        reg,
      ),
    ).toBeInstanceOf(ClaudeCodeAgent);
    expect(
      createAdapterAgent('codex', minimalDeps as ConstructorParameters<typeof CodexAgent>[0], reg),
    ).toBeInstanceOf(CodexAgent);
    expect(
      createAdapterAgent('pi', minimalDeps as ConstructorParameters<typeof PiAgent>[0], reg),
    ).toBeInstanceOf(PiAgent);
    expect(
      createAdapterAgent('hermes', minimalDeps as ConstructorParameters<typeof HermesAgent>[0], reg),
    ).toBeInstanceOf(HermesAgent);
  });

  describe('Maker dynamic adapter consumption (ROADMAP 4.1)', () => {
    it('lists dynamic adapters and resolves them when requested', async () => {
      const shared = getExtensionRegistry();
      const mockAgent = {
        getAuthState: vi.fn(async () => ({ authenticated: true, identity: 'test-user' })),
        getBinaryPath: vi.fn(() => '/bin/test-agent'),
        capabilities: {},
      };
      const unregister = shared.register({
        kind: ADAPTER_EXTENSION_KIND,
        id: 'plugin-custom-agent',
        source: 'plugin:test',
        value: vi.fn(() => mockAgent),
      });

      try {
        const storage = {
          create: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
          update: vi.fn(),
          compareAndClearSdkSessionId: vi.fn(),
          delete: vi.fn(),
        };
        const { Maker } = await import('../../maker.js');
        const maker = new Maker({ agents: {}, storage: storage as never, logger });
        expect(maker.listAvailableAgents()).toContain('plugin-custom-agent');

        const status = await maker.getAgentStatus('plugin-custom-agent' as never);
        expect(status).toEqual({
          binaryReady: true,
          binaryPath: '/bin/test-agent',
          authReady: true,
          identity: 'test-user',
        });
      } finally {
        unregister();
      }

      const storage2 = {
        create: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        update: vi.fn(),
        compareAndClearSdkSessionId: vi.fn(),
        delete: vi.fn(),
      };
      const { Maker } = await import('../../maker.js');
      const maker2 = new Maker({ agents: {}, storage: storage2 as never, logger });
      expect(maker2.listAvailableAgents()).not.toContain('plugin-custom-agent');
      const statusAfter = await maker2.getAgentStatus('plugin-custom-agent' as never);
      expect(statusAfter).toEqual({
        binaryReady: false,
        binaryPath: null,
        authReady: false,
      });
    });
  });
});
