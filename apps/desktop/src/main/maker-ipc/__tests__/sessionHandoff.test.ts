import { describe, it, expect, vi } from 'vitest';
import { SessionHandoffHost, registerSessionHandoffHandlers } from '../sessionHandoff';
import { MAKER_INVOKE } from '../channels';

describe('SessionHandoffHost', () => {
  it('fails closed when sessionId is invalid or session not found', async () => {
    const host = new SessionHandoffHost({
      getSessionRow: vi.fn().mockResolvedValue(null),
      listMessages: vi.fn().mockResolvedValue([]),
    });

    const res1 = await host.buildHandoff('');
    expect(res1.ok).toBe(false);
    expect(res1.reason).toBe('no-session');

    const res2 = await host.buildHandoff('non-existent');
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe('no-session');
  });

  it('fails when session has no messages', async () => {
    const host = new SessionHandoffHost({
      getSessionRow: vi.fn().mockResolvedValue({ id: 'sess-1', title: 'Empty Session' }),
      listMessages: vi.fn().mockResolvedValue([]),
    });

    const res = await host.buildHandoff('sess-1');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-messages');
  });

  it('builds handoff prompt with decisions, files, and actions', async () => {
    const mockSession = {
      id: 'sess-active',
      title: 'Refactor Session Pipeline',
      workingDir: '/workspace/cindy',
      model: 'claude-3-7-sonnet',
    };
    const mockMessages = [
      { role: 'user', content: 'We need to refactor src/pipeline.ts to handle handoffs.' },
      { role: 'assistant', content: 'We decided to implement atomic handoffs.\n\nNext step: update tests.' },
    ];

    const host = new SessionHandoffHost({
      getSessionRow: vi.fn().mockResolvedValue(mockSession),
      listMessages: vi.fn().mockResolvedValue(mockMessages),
    });

    const res = await host.buildHandoff('sess-active');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.handoff.sessionId).toBe('sess-active');
      expect(res.handoff.prompt).toContain('# Session Continuation & Handoff');
      expect(res.handoff.prompt).toContain('Refactor Session Pipeline');
      expect(res.handoff.prompt).toContain('/workspace/cindy');
      expect(res.handoff.prompt).toContain('src/pipeline.ts');
    }

    const execRes = await host.executeHandoff('sess-active');
    expect(execRes.ok).toBe(true);
    expect(execRes.title).toBe('Continuation of Refactor Session Pipeline');
    expect(execRes.workingDir).toBe('/workspace/cindy');
    expect(execRes.prompt).toContain('# Session Continuation & Handoff');
  });

  it('registers IPC handlers and responds to calls', async () => {
    const mockSession = { id: 'sess-ipc', title: 'IPC Test Session' };
    const mockMessages = [{ role: 'user', content: 'Hello test' }];
    const host = new SessionHandoffHost({
      getSessionRow: vi.fn().mockResolvedValue(mockSession),
      listMessages: vi.fn().mockResolvedValue(mockMessages),
    });

    const handlers: Record<string, Function> = {};
    const mockIpc = {
      handle: (channel: string, fn: Function) => {
        handlers[channel] = fn;
      },
    } as any;

    const assertSenderTrusted = vi.fn();
    registerSessionHandoffHandlers(mockIpc, () => host, assertSenderTrusted);

    expect(handlers[MAKER_INVOKE.SESSION_HANDOFF_BUILD]).toBeTypeOf('function');
    expect(handlers[MAKER_INVOKE.SESSION_HANDOFF_EXECUTE]).toBeTypeOf('function');

    const buildRes = await handlers[MAKER_INVOKE.SESSION_HANDOFF_BUILD](
      { senderFrame: {} },
      { sessionId: 'sess-ipc' },
    );
    expect(assertSenderTrusted).toHaveBeenCalled();
    expect(buildRes.ok).toBe(true);

    const execRes = await handlers[MAKER_INVOKE.SESSION_HANDOFF_EXECUTE](
      { senderFrame: {} },
      { sessionId: 'sess-ipc' },
    );
    expect(execRes.ok).toBe(true);
    expect(execRes.title).toContain('Continuation of IPC Test Session');
  });
});
