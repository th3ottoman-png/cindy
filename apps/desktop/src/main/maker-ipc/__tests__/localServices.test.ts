import { describe, expect, it, vi } from 'vitest';
import { registerLocalServicesHandlers } from '../localServices.js';
import { MAKER_INVOKE } from '../channels.js';

function makeRegistry() {
  const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (event: unknown, request?: unknown) => unknown) => {
      handlers.set(channel, handler);
    }),
    handlers,
  };
}

describe('registerLocalServicesHandlers (ROADMAP 11.6)', () => {
  it('registers all six channels', () => {
    const registry = makeRegistry();
    registerLocalServicesHandlers(registry as any, {
      supervisor: {} as any,
      assertTrusted: () => {},
    });
    for (const channel of [
      MAKER_INVOKE.LOCAL_SERVICES_LIST,
      MAKER_INVOKE.LOCAL_SERVICES_START,
      MAKER_INVOKE.LOCAL_SERVICES_STOP,
      MAKER_INVOKE.LOCAL_SERVICES_RESTART,
      MAKER_INVOKE.LOCAL_SERVICES_LOGS,
      MAKER_INVOKE.LOCAL_SERVICES_TERMINATE,
    ]) {
      expect(registry.handlers.has(channel)).toBe(true);
    }
  });

  it('delegates list to the supervisor', async () => {
    const registry = makeRegistry();
    const list = vi.fn(async () => ({ services: [] }));
    registerLocalServicesHandlers(registry as any, {
      supervisor: { list } as any,
      assertTrusted: () => {},
    });
    const res = await registry.handlers.get(MAKER_INVOKE.LOCAL_SERVICES_LIST)?.({}, undefined);
    expect(res).toEqual({ services: [] });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-directory cwd without spawning', async () => {
    const registry = makeRegistry();
    const start = vi.fn();
    registerLocalServicesHandlers(registry as any, {
      supervisor: { start } as any,
      assertTrusted: () => {},
    });
    const res = (await registry.handlers.get(MAKER_INVOKE.LOCAL_SERVICES_START)?.(
      {},
      { name: 'web', command: 'node server.js', cwd: '/no/such/dir/xyz' },
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/existing directory/);
    expect(start).not.toHaveBeenCalled();
  });

  it('strips the svc: prefix before stopping', async () => {
    const registry = makeRegistry();
    const stop = vi.fn(async () => ({ ok: true }));
    registerLocalServicesHandlers(registry as any, {
      supervisor: { stop } as any,
      assertTrusted: () => {},
      broadcast: () => {},
    });
    await registry.handlers.get(MAKER_INVOKE.LOCAL_SERVICES_STOP)?.({}, { id: 'svc:svc-1' });
    expect(stop).toHaveBeenCalledWith('svc-1');
  });

  it('requires a matching command to terminate a discovered server', async () => {
    const registry = makeRegistry();
    const terminateDiscovered = vi.fn();
    registerLocalServicesHandlers(registry as any, {
      supervisor: { terminateDiscovered } as any,
      assertTrusted: () => {},
    });
    const res = (await registry.handlers.get(MAKER_INVOKE.LOCAL_SERVICES_TERMINATE)?.(
      {},
      { pid: 7777, command: '' },
    )) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(terminateDiscovered).not.toHaveBeenCalled();
  });

  it('clamps the log limit into range', async () => {
    const registry = makeRegistry();
    const getLogs = vi.fn(async () => ({ ok: true, lines: [] }));
    registerLocalServicesHandlers(registry as any, {
      supervisor: { getLogs } as any,
      assertTrusted: () => {},
    });
    await registry.handlers.get(MAKER_INVOKE.LOCAL_SERVICES_LOGS)?.({}, { id: 'svc-1', limit: 9999 });
    expect(getLogs).toHaveBeenCalledWith('svc-1', 200);
  });
});
