import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sendMessage: vi.fn(),
  cleanSlate: vi.fn(),
  closeSession: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@/lib/sessionService', () => ({ create: mocks.create }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { sendMessage: mocks.sendMessage },
}));

import type { Session } from '@/lib/ccAgent.types';
import { startCleanSlateHandoff } from '../startCleanSlateHandoff';

const source = {
  id: 'old-session',
  title: 'Bloated',
  workingDir: '/tmp/work',
  workspaceKind: 'local',
  agentKind: 'hermes',
  model: 'hermes-default',
  permissionMode: 'default',
} as unknown as Session;

describe('startCleanSlateHandoff (ROADMAP 11.5)', () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.cleanSlate.mockImplementation(async () => {
      mocks.calls.push('cleanSlate');
      return { ok: true, prompt: 'HANDOFF', title: 'Bloated (clean slate)' };
    });
    mocks.create.mockImplementation(async () => {
      mocks.calls.push('create');
      return { id: 'new-session', model: 'hermes-default', workingDir: '/tmp/work' };
    });
    mocks.sendMessage.mockImplementation(async () => {
      mocks.calls.push('send');
    });
    mocks.closeSession.mockImplementation(async (id: string) => {
      mocks.calls.push(`close:${id}`);
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          sessionHandoff: { cleanSlate: mocks.cleanSlate },
          closeSession: mocks.closeSession,
        },
      },
      location: { hash: '' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('terminates the bloated source session only after the fresh one is seeded', async () => {
    const navigate = vi.fn();
    const outcome = await startCleanSlateHandoff(source, { navigate });

    expect(outcome).toMatchObject({ ok: true, sessionId: 'new-session', sourceClosed: true });
    expect(mocks.calls).toEqual(['cleanSlate', 'create', 'send', 'close:old-session']);
    // Soft close: the fresh session works in the same directory/worktree, so the
    // source close must not recycle the workspace.
    expect(mocks.closeSession).toHaveBeenCalledWith('old-session', { preserveWorkspace: true });
    expect(navigate).toHaveBeenCalledWith('/cc-agent/new-session');
  });

  it('leaves the source session alive when the payload cannot be built', async () => {
    mocks.cleanSlate.mockResolvedValueOnce({ ok: false, error: 'no payload' });
    const outcome = await startCleanSlateHandoff(source);

    expect(outcome).toEqual({ ok: false, error: 'no payload' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.closeSession).not.toHaveBeenCalled();
  });

  it('leaves the source session alive when seeding the fresh session fails', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error('send failed'));
    await expect(startCleanSlateHandoff(source)).rejects.toThrow('send failed');
    expect(mocks.closeSession).not.toHaveBeenCalled();
  });

  it('still reports the handoff as done when closing the source fails', async () => {
    mocks.closeSession.mockRejectedValueOnce(new Error('close failed'));
    const navigate = vi.fn();
    const outcome = await startCleanSlateHandoff(source, { navigate });

    expect(outcome).toMatchObject({ ok: true, sessionId: 'new-session', sourceClosed: false });
    expect(navigate).toHaveBeenCalledWith('/cc-agent/new-session');
  });
});
