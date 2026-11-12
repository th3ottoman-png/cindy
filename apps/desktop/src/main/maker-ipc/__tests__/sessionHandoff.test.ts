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
    expect(res1).toMatchObject({ ok: false, reason: 'no-session' });

    const res2 = await host.buildHandoff('non-existent');
    expect(res2).toMatchObject({ ok: false, reason: 'no-session' });
  });

  it('fails when session has no messages', async () => {
    const host = new SessionHandoffHost({
      getSessionRow: vi.fn().mockResolvedValue({ id: 'sess-1', title: 'Empty Session' }),
      listMessages: vi.fn().mockResolvedValue([]),
    });

    const res = await host.buildHandoff('sess-1');
    expect(res).toMatchObject({ ok: false, reason: 'no-messages' });
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
    expect(handlers[MAKER_INVOKE.SESSION_HANDOFF_CLEAN_SLATE]).toBeTypeOf('function');

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

    const cleanRes = await handlers[MAKER_INVOKE.SESSION_HANDOFF_CLEAN_SLATE](
      { senderFrame: {} },
      { sessionId: 'sess-ipc' },
    );
    expect(cleanRes.ok).toBe(true);
    expect(cleanRes.prompt).toContain('# Session handoff — clean slate');
    expect(cleanRes.tokenCount).toBeGreaterThan(0);
  });
});

describe('SessionHandoffHost.buildCleanSlateHandoff (ROADMAP 11.5)', () => {
  const baseMessages = [
    { role: 'user', content: 'Should the footer use mint or lemon?' },
    {
      role: 'assistant',
      content:
        'Decision: use mint. We decided the registry owns all adapters.\n\nNext step: update the routing test.',
    },
    { role: 'user', content: 'Go on.' },
    { role: 'assistant', content: 'Working. What colour should the banner be?' },
  ];

  const makeHost = (overrides?: {
    gatherGitState?: () => Promise<{ gitDiff: string; modifiedFiles: string[] }>;
    workingDir?: string | null;
  }) =>
    new SessionHandoffHost({
      getSessionRow: vi.fn().mockResolvedValue({
        id: 'sess-clean',
        title: 'Clean Slate Session',
        workingDir: overrides?.workingDir ?? '/workspace/cindy',
        model: 'hermes-default',
      }),
      listMessages: vi.fn().mockResolvedValue(baseMessages),
      readSynthesisNote: vi
        .fn()
        .mockResolvedValue(
          '## Key Decisions & Architecture\n\n- The daemon owns config.yaml writes.\n',
        ),
      gatherGitState:
        overrides?.gatherGitState ??
        (async () => ({
          gitDiff: 'diff --git a/src/app.ts b/src/app.ts\n+secretToken = "sk-abcdefghijklmnopqrstuv"\n+export const x = 1;',
          modifiedFiles: ['src/app.ts'],
        })),
    });

  it('assembles every payload section from the gathered sources', async () => {
    const res = await makeHost().buildCleanSlateHandoff('sess-clean');
    expect(res.ok).toBe(true);
    expect(res.title).toBe('Clean slate from Clean Slate Session');
    expect(res.workingDir).toBe('/workspace/cindy');
    expect(res.prompt).toContain('The daemon owns config.yaml writes.');
    expect(res.prompt).toContain('- src/app.ts');
    expect(res.prompt).toContain('export const x = 1;');
    expect(res.prompt).toContain('Next step: update the routing test.');
    expect(res.prompt).toContain('What colour should the banner be?');
    expect(res.tokenCount).toBeGreaterThan(0);
    expect(res.truncated).toMatchObject({ payload: false });
  });

  it('redacts secrets from the gathered diff', async () => {
    const res = await makeHost().buildCleanSlateHandoff('sess-clean');
    expect(res.ok).toBe(true);
    expect(res.prompt).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('fails closed on a missing session or bad id', async () => {
    const host = new SessionHandoffHost({
      getSessionRow: vi.fn().mockResolvedValue(null),
      listMessages: vi.fn().mockResolvedValue([]),
    });
    expect(await host.buildCleanSlateHandoff('')).toMatchObject({ ok: false });
    expect(await host.buildCleanSlateHandoff('missing')).toMatchObject({ ok: false });
  });

  it('tolerates a git failure and an empty message list', async () => {
    const host = makeHost({
      gatherGitState: async () => ({ gitDiff: '', modifiedFiles: [] }),
      workingDir: '/not/a/repo',
    });
    const res = await host.buildCleanSlateHandoff('sess-clean');
    expect(res.ok).toBe(true);
    expect(res.prompt).toContain('No uncommitted changes.');
    expect(res.prompt).toContain('The daemon owns config.yaml writes.');
  });
  it('decodes stored {text, images, files} user content to its text (live 2026-11-12)', async () => {
    const userText =
      'Step 2, do NOT do it now, it is pending for later: append the line beta to notes.txt.';
    for (const content of [
      { text: userText, images: [], files: [] },
      JSON.stringify({ text: userText, images: [], files: [] }),
    ]) {
      const host = new SessionHandoffHost({
        getSessionRow: vi.fn().mockResolvedValue({
          id: 'sess-obj',
          title: 'Object content',
          workingDir: '/workspace/cindy',
          model: 'hermes-default',
        }),
        listMessages: vi.fn().mockResolvedValue([
          { role: 'user', content },
          { role: 'tool_use', content: { name: 'read_file', input: { path: 'notes.txt' } } },
          { role: 'assistant', content: 'step 1 done, next step: append beta to notes.txt' },
        ]),
        gatherGitState: async () => ({ gitDiff: '', modifiedFiles: [] }),
      });
      const res = await host.buildCleanSlateHandoff('sess-obj');
      expect(res.ok).toBe(true);
      expect(res.prompt).toContain('append the line beta to notes.txt.');
      expect(res.prompt).not.toContain('"images"');
      expect(res.prompt).not.toContain('"files"');
    }
  });
});
