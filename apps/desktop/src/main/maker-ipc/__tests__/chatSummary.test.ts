import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import {
  ChatSummaryHost,
  registerChatSummaryHandlers,
  type ChatSummaryHostDeps,
} from '../chatSummary';
import type { IpcHandlerRegistry } from '../ipcHandlerRegistry';

const SID = 'abcdef12-3456-7890-abcd-ef1234567890';

let dir: string;
let vault: string;
let harnessDir: string;
let configFile: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-summary-host-')));
  vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  harnessDir = path.join(dir, 'harness');
  fs.mkdirSync(harnessDir);
  configFile = path.join(harnessDir, 'chat-summary.json');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeHarnessFiles(options: { routeSummary?: boolean; keyEnv?: string } = {}) {
  const { routeSummary = true } = options;
  const providersYaml = `
providers:
  - id: deepseek
    kind: openai-compatible
    baseUrl: https://api.deepseek.com
    keyEnv: DEEPSEEK_API_KEY
    models:
      - id: deepseek-flash
`;
  fs.writeFileSync(path.join(harnessDir, 'providers.yaml'), providersYaml);

  const routingYaml = routeSummary
    ? `
routes:
  summary-route:
    provider: deepseek
    model: deepseek-flash
rules:
  summary: summary-route
`
    : `
routes:
  other:
    provider: deepseek
    model: deepseek-flash
rules:
  predict: other
`;
  fs.writeFileSync(path.join(harnessDir, 'routing.yaml'), routingYaml);
}

function makeHost(over: Partial<ChatSummaryHostDeps> = {}) {
  const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), { status: 200 });
    }
    if (urlStr.endsWith('/chat/completions')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '## Overview\nResolved problem.\n\n## Decisions & Rationale\n- Key decision.\n\n## Facts Learned\n- Fact 1.\n\n## Open Questions\n- None.\n\n## Next Steps\n- Deploy.',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('Not found', { status: 404 });
  });

  const deps: ChatSummaryHostDeps = {
    configFile,
    harnessDir,
    getVaultDir: vi.fn(() => vault),
    getAutosaveFolder: vi.fn(() => 'Cindy/Chats'),
    getSessionRow: vi.fn(async () => ({
      title: 'Fix issue',
      agentKind: 'hermes',
      model: 'deepseek-flash',
    })),
    listMessages: vi.fn(async () => [
      { role: 'user', content: 'What happened?', createdAt: 1 },
      { role: 'assistant', content: 'Fixed it.', createdAt: 2 },
    ]),
    onWritten: vi.fn(),
    onFailure: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    now: () => new Date('2026-11-07T21:00:00Z'),
    env: { DEEPSEEK_API_KEY: 'mock-key' },
    fetchImpl: mockFetch as unknown as typeof fetch,
    ...over,
  };
  return { host: new ChatSummaryHost(deps), deps, mockFetch };
}

function memoryFiles(): string[] {
  const d = path.join(vault, 'Cindy', 'Memory');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
}

describe('ChatSummaryHost (ROADMAP 5.6)', () => {
  it('is off by default: a turn end arms nothing and writes nothing', async () => {
    vi.useFakeTimers();
    writeHarnessFiles();
    const { host, deps } = makeHost();

    host.onTurnEnded(SID);
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();

    expect(deps.getSessionRow).not.toHaveBeenCalled();
    expect(memoryFiles()).toEqual([]);
  });

  it('arms idle timer on turn end and generates summary when timer fires', async () => {
    vi.useFakeTimers();
    writeHarnessFiles();
    const { host, deps } = makeHost();

    host.setConfig({ enabled: true, idleMinutes: 10 });
    host.onTurnEnded(SID);

    // 10 minutes timer
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(deps.getSessionRow).toHaveBeenCalledWith(SID);
    expect(deps.onWritten).toHaveBeenCalledTimes(1);
    expect(deps.onWritten).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SID,
        routeName: 'summary-route',
        model: 'deepseek-flash',
      }),
    );

    const files = memoryFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toContain('-summary.md');
    const content = fs.readFileSync(path.join(vault, 'Cindy', 'Memory', files[0]!), 'utf8');
    expect(content).toContain('summary_route: "summary-route"');
    expect(content).toContain('turns_summarized: 2');
    expect(content).toContain('Resolved problem.');
  });

  it('resets idle timer when a new turn ends before idle expires', async () => {
    vi.useFakeTimers();
    writeHarnessFiles();
    const { host, deps } = makeHost();

    host.setConfig({ enabled: true, idleMinutes: 5 });
    host.onTurnEnded(SID);

    // 3 minutes pass
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(deps.getSessionRow).not.toHaveBeenCalled();

    // New turn arrives -> resets timer to 5 minutes
    host.onTurnEnded(SID);

    // 3 minutes pass -> 6 total, but only 3 since reset
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(deps.getSessionRow).not.toHaveBeenCalled();

    // 2 more minutes -> 5 minutes since reset -> fires!
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(deps.getSessionRow).toHaveBeenCalledTimes(1);
  });

  it('clears idle timer and triggers immediate summary on session closed', async () => {
    vi.useFakeTimers();
    writeHarnessFiles();
    const { host, deps } = makeHost();

    host.setConfig({ enabled: true, idleMinutes: 10 });
    host.onTurnEnded(SID);
    expect(vi.getTimerCount()).toBe(1);

    // Session closes before idle timer expires
    host.onSessionClosed(SID);
    expect(vi.getTimerCount()).toBe(0);

    await vi.runAllTimersAsync();

    expect(deps.getSessionRow).toHaveBeenCalledTimes(1);
    expect(deps.onWritten).toHaveBeenCalledTimes(1);
  });

  it('skips regeneration if turns count has not increased (up to date)', async () => {
    writeHarnessFiles();
    const { host, deps } = makeHost();

    host.setConfig({ enabled: true });

    // First summary
    await host.summarizeNow(SID);
    expect(deps.onWritten).toHaveBeenCalledTimes(1);

    // Second summary with same 2 messages
    await host.summarizeNow(SID);
    expect(deps.onWritten).toHaveBeenCalledTimes(1); // not called again
  });

  it('regenerates when new messages are added to the session', async () => {
    writeHarnessFiles();
    const messages = [
      { role: 'user', content: 'Turn 1', createdAt: 1 },
      { role: 'assistant', content: 'Reply 1', createdAt: 2 },
    ];
    const { host, deps } = makeHost({
      listMessages: vi.fn(async () => [...messages]),
    });

    host.setConfig({ enabled: true });

    await host.summarizeNow(SID);
    expect(deps.onWritten).toHaveBeenCalledTimes(1);

    // Add turn 2
    messages.push(
      { role: 'user', content: 'Turn 2', createdAt: 3 },
      { role: 'assistant', content: 'Reply 2', createdAt: 4 },
    );

    await host.summarizeNow(SID);
    expect(deps.onWritten).toHaveBeenCalledTimes(2);
  });

  it('stays quietly off without silent fallback when task is not routed', async () => {
    writeHarnessFiles({ routeSummary: false });
    const { host, deps, mockFetch } = makeHost();

    host.setConfig({ enabled: true });
    await host.summarizeNow(SID);

    expect(deps.onWritten).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(memoryFiles()).toEqual([]);
  });

  it('handles write failure and pushes failure toast event once', async () => {
    writeHarnessFiles();
    const { host, deps } = makeHost({
      getVaultDir: () => '/nonexistent/vault/path',
    });

    host.setConfig({ enabled: true });
    await host.summarizeNow(SID);

    expect(deps.onWritten).not.toHaveBeenCalled();
    // Nonexistent vault is quiet (no-vault reason)
    expect(deps.onFailure).not.toHaveBeenCalled();
  });
});

describe('registerChatSummaryHandlers (ROADMAP 5.6)', () => {
  it('exposes get-config, set-config, and trigger-now handlers with assertTrusted check', async () => {
    writeHarnessFiles();
    const { host } = makeHost();
    const registry: IpcHandlerRegistry = {
      handle: vi.fn(),
    };
    const assertTrusted = vi.fn();

    registerChatSummaryHandlers(registry, { host, assertTrusted });

    expect(registry.handle).toHaveBeenCalledWith(MAKER_INVOKE.CHAT_SUMMARY_GET_CONFIG, expect.any(Function));
    expect(registry.handle).toHaveBeenCalledWith(MAKER_INVOKE.CHAT_SUMMARY_SET_CONFIG, expect.any(Function));
    expect(registry.handle).toHaveBeenCalledWith(MAKER_INVOKE.CHAT_SUMMARY_TRIGGER_NOW, expect.any(Function));

    const getHandler = (registry.handle as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === MAKER_INVOKE.CHAT_SUMMARY_GET_CONFIG,
    )?.[1];
    const event = { sender: {} };
    const res = await getHandler(event);
    expect(assertTrusted).toHaveBeenCalledWith(event);
    expect(res).toMatchObject({
      enabled: false,
      folder: 'Cindy/Memory',
      idleMinutes: 10,
    });
  });
});
