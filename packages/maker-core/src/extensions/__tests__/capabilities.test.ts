import { describe, expect, it, vi } from 'vitest';

import {
  createCapabilityRegistry,
  getCapabilityRegistry,
  groupCapabilitiesByKind,
  providedCapabilityPlugins,
  registerCapabilitySource,
  visibleCapabilities,
  type CapabilityDescriptor,
  type CapabilitySource,
} from '../registry';

function descriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    kind: 'tool',
    id: 'a',
    title: 'A tool',
    source: '/tmp/tools/a.md',
    trust: 'local-file',
    declaredInterface: 'MCP stdio',
    enabled: true,
    ...overrides,
  };
}

function source(overrides: Partial<CapabilitySource> = {}): CapabilitySource {
  return {
    kind: 'tool',
    id: 'tools',
    declaredInterface: 'MCP stdio',
    read: () => [descriptor()],
    ...overrides,
  };
}

describe('capability registry', () => {
  it('collects rows from several sources in registration order', async () => {
    const registry = createCapabilityRegistry();
    registry.register(source({ id: 'first', read: () => [descriptor({ id: 'one' })] }));
    registry.register(source({ id: 'second', read: () => [descriptor({ id: 'two', kind: 'expert' })] }));

    const rows = await registry.collect();
    expect(rows.map((row) => row.id)).toEqual(['one', 'two']);
    expect(rows[1].kind).toBe('expert');
    expect(registry.list().map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  it('accepts a brand new kind with no central edit', async () => {
    const registry = createCapabilityRegistry();
    registry.register(
      source({
        kind: 'quantum-widget',
        id: 'widgets',
        read: () => [descriptor({ kind: 'quantum-widget' })],
      }),
    );

    const rows = await registry.collect();
    expect(rows).toHaveLength(1);
    expect(groupCapabilitiesByKind(rows)).toEqual([
      { kind: 'quantum-widget', items: [descriptor({ kind: 'quantum-widget' })] },
    ]);
  });

  it('hides a row whose optional plugin is missing and shows it when the plugin is installed', async () => {
    const registry = createCapabilityRegistry();
    const tool = descriptor({ id: 'tool-from-plugin', requires: 'hello-plugin' });
    const plugin = descriptor({
      kind: 'plugin',
      id: 'plugin:hello-plugin',
      title: 'hello-plugin',
      provides: 'hello-plugin',
    });
    registry.register(source({ id: 'tools', read: () => [tool] }));

    expect(await registry.collect()).toEqual([]);

    const offPlugins = registry.register(
      source({ id: 'plugins', kind: 'plugin', read: () => [plugin] }),
    );
    expect((await registry.collect()).map((row) => row.id)).toEqual([
      'tool-from-plugin',
      'plugin:hello-plugin',
    ]);

    offPlugins();
    expect(await registry.collect()).toEqual([]);
  });

  it('does not treat a disabled or hidden plugin as available', async () => {
    const registry = createCapabilityRegistry();
    registry.register(
      source({
        id: 'tools',
        read: () => [descriptor({ id: 'dependent', requires: 'hello-plugin' })],
      }),
    );
    registry.register(
      source({
        id: 'plugins',
        kind: 'plugin',
        read: () => [
          descriptor({
            kind: 'plugin',
            id: 'plugin:hello-plugin',
            provides: 'hello-plugin',
            enabled: false,
          }),
        ],
      }),
    );

    expect(await registry.collect()).toHaveLength(1);
    expect(providedCapabilityPlugins(await registry.collect())).toEqual([]);
  });

  it('a missing optional source hides its rows without breaking the other sources', async () => {
    const registry = createCapabilityRegistry();
    registry.register(
      source({ id: 'broken', read: () => Promise.reject(new Error('plugin not installed')) }),
    );
    registry.register(source({ id: 'healthy', read: () => [descriptor({ id: 'still-here' })] }));

    expect((await registry.collect()).map((row) => row.id)).toEqual(['still-here']);
  });

  it('ignores a source that throws synchronously and one that returns malformed rows', async () => {
    const registry = createCapabilityRegistry();
    registry.register(
      source({
        id: 'throws',
        read: () => {
          throw new Error('no IPC');
        },
      }),
    );
    registry.register(
      source({
        id: 'malformed',
        read: () => [null, 'nope', descriptor({ id: 'valid' })] as unknown as CapabilityDescriptor[],
      }),
    );

    expect((await registry.collect()).map((row) => row.id)).toEqual(['valid']);
  });

  it('visibleCapabilities hides explicit false and keeps disabled rows visible', () => {
    const rows = [
      descriptor({ id: 'on' }),
      descriptor({ id: 'off', enabled: false }),
      descriptor({ id: 'hidden', visible: false }),
      descriptor({ id: 'needs', requires: 'ghost' }),
    ];
    expect(visibleCapabilities(rows).map((row) => row.id)).toEqual(['on', 'off']);
    expect(visibleCapabilities(rows, ['ghost']).map((row) => row.id)).toEqual([
      'on',
      'off',
      'needs',
    ]);
  });

  it('groups by kind in first-seen order without a kind list', () => {
    const rows = [
      descriptor({ kind: 'expert', id: 'a' }),
      descriptor({ kind: 'skill', id: 'b' }),
      descriptor({ kind: 'expert', id: 'c' }),
    ];
    expect(groupCapabilitiesByKind(rows).map((group) => [group.kind, group.items.length])).toEqual([
      ['expert', 2],
      ['skill', 1],
    ]);
  });

  it('rejects duplicate source ids and bad slugs, and unregisters only its own entry', async () => {
    const registry = createCapabilityRegistry();
    const off = registry.register(source({ id: 'tools' }));
    expect(() => registry.register(source({ id: 'tools' }))).toThrow('already registered: tools');
    expect(() => registry.register(source({ id: 'Bad Id' }))).toThrow('invalid capability source id');
    expect(() => registry.register(source({ kind: 'UPPER' }))).toThrow('invalid capability kind');

    off();
    expect(await registry.collect()).toEqual([]);
  });

  it('notifies subscribers and isolates a throwing listener', () => {
    const registry = createCapabilityRegistry();
    const seen = vi.fn();
    registry.subscribe(() => {
      throw new Error('bad subscriber');
    });
    registry.subscribe(seen);
    const off = registry.register(source());
    off();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('copies descriptor objects so a source cannot mutate collected rows', async () => {
    const original = descriptor();
    const registry = createCapabilityRegistry();
    registry.register(source({ read: () => [original] }));
    const [row] = await registry.collect();
    expect(row).not.toBe(original);
    expect(row).toEqual(original);
  });

  it('exposes a shared registry through registerCapabilitySource', async () => {
    const off = registerCapabilitySource(source({ id: 'capabilities-test-source' }));
    expect(getCapabilityRegistry().list().some((entry) => entry.id === 'capabilities-test-source')).toBe(true);
    off();
    expect(getCapabilityRegistry().list().some((entry) => entry.id === 'capabilities-test-source')).toBe(false);
  });
});
