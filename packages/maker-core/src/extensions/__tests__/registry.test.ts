import { describe, expect, it, vi } from 'vitest';

import { createExtensionRegistry, getExtensionRegistry, registerExtension } from '../registry';

describe('extension registry', () => {
  it('registers and looks up by kind and id, listing in registration order', () => {
    const reg = createExtensionRegistry();
    reg.register({ kind: 'tool', id: 'b', value: 1 });
    reg.register({ kind: 'adapter', id: 'a', value: 2 });
    reg.register({ kind: 'tool', id: 'a', value: 3 });

    expect(reg.get<number>('tool', 'a')?.value).toBe(3);
    expect(reg.get('tool', 'zzz')).toBeUndefined();
    expect(reg.list().map((e) => `${e.kind}/${e.id}`)).toEqual(['tool/b', 'adapter/a', 'tool/a']);
    expect(reg.list('tool').map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('accepts a kind nobody has declared, with no code change', () => {
    const reg = createExtensionRegistry();
    reg.register({ kind: 'my-new-kind', id: 'x', value: null });
    expect(reg.list('my-new-kind')).toHaveLength(1);
  });

  it('refuses a duplicate (kind, id) and keeps the first', () => {
    const reg = createExtensionRegistry();
    reg.register({ kind: 'tool', id: 'a', value: 'first' });
    expect(() => reg.register({ kind: 'tool', id: 'a', value: 'second' })).toThrow('already registered: tool/a');
    expect(reg.get('tool', 'a')?.value).toBe('first');
    // the same id under another kind is a different extension
    expect(() => reg.register({ kind: 'expert', id: 'a', value: 'ok' })).not.toThrow();
  });

  it('rejects a malformed kind or id', () => {
    const reg = createExtensionRegistry();
    for (const bad of ['', 'Has Space', 'UPPER', '../x', 'a/b']) {
      expect(() => reg.register({ kind: 'tool', id: bad, value: 0 })).toThrow('invalid extension id');
      expect(() => reg.register({ kind: bad, id: 'ok', value: 0 })).toThrow('invalid extension kind');
    }
    expect(reg.list()).toEqual([]);
  });

  it('unregisters through the returned function, once, and only its own entry', () => {
    const reg = createExtensionRegistry();
    const off = reg.register({ kind: 'tool', id: 'a', value: 1 });
    off();
    expect(reg.get('tool', 'a')).toBeUndefined();
    reg.register({ kind: 'tool', id: 'a', value: 2 });
    off(); // stale handle must not remove the newer registration
    expect(reg.get('tool', 'a')?.value).toBe(2);
  });

  it('never invokes a registered value, and a throwing subscriber does not stop the others', () => {
    const reg = createExtensionRegistry();
    const value = vi.fn();
    const seen = vi.fn();
    reg.subscribe(() => {
      throw new Error('bad subscriber');
    });
    reg.subscribe(seen);

    reg.register({ kind: 'tool', id: 'a', value });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(value).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const reg = createExtensionRegistry();
    const seen = vi.fn();
    const off = reg.subscribe(seen);
    off();
    reg.register({ kind: 'tool', id: 'a', value: 0 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('exposes a shared registry through registerExtension', () => {
    const off = registerExtension({ kind: 'panel', id: 'registry-test-panel', value: 'p' });
    expect(getExtensionRegistry().get('panel', 'registry-test-panel')?.value).toBe('p');
    off();
    expect(getExtensionRegistry().get('panel', 'registry-test-panel')).toBeUndefined();
  });
});
