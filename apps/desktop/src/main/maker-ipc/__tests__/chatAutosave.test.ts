import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import {
  ChatAutosaveHost,
  registerChatAutosaveHandlers,
  type ChatAutosaveHostDeps,
} from '../chatAutosave';
import type { IpcHandlerRegistry } from '../ipcHandlerRegistry';

const SID = 'abcdef12-3456-7890-abcd-ef1234567890';

let dir: string;
let vault: string;
let configFile: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-autosave-host-')));
  vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  configFile = path.join(dir, 'harness', 'chat-autosave.json');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeHost(over: Partial<ChatAutosaveHostDeps> = {}) {
  const deps = {
    configFile,
    getVaultDir: vi.fn(() => vault),
    getSessionRow: vi.fn(async () => ({
      title: 'Plan the trip',
      agentKind: 'hermes',
      model: 'deepseek-flash',
    })),
    listMessages: vi.fn(async () => [
      { role: 'user', content: 'Where should we go?', createdAt: 1 },
      { role: 'assistant', content: 'Somewhere warm.', createdAt: 2 },
    ]),
    onFailure: vi.fn(),
    log: { warn: vi.fn(), debug: vi.fn() },
    now: () => new Date('2026-11-07T20:00:00Z'),
    ...over,
  };
  return { host: new ChatAutosaveHost(deps), deps };
}

function chats(): string[] {
  const d = path.join(vault, 'Cindy', 'Chats');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
}

describe('ChatAutosaveHost (ROADMAP 5.5)', () => {
  it('is off by default: a turn end reads nothing and writes nothing', async () => {
    vi.useFakeTimers();
    const { host, deps } = makeHost();
    host.onTurnEnded(SID);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.getSessionRow).not.toHaveBeenCalled();
    expect(chats()).toEqual([]);
    expect(host.getConfig()).toMatchObject({
      enabled: false,
      folder: 'Cindy/Chats',
      vaultDir: vault,
    });
  });

  it('debounces several turn ends of one session into one save', async () => {
    vi.useFakeTimers();
    const { host, deps } = makeHost();
    host.setConfig({ enabled: true });
    host.onTurnEnded(SID);
    await vi.advanceTimersByTimeAsync(1000);
    host.onTurnEnded(SID);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.getSessionRow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.getSessionRow).toHaveBeenCalledTimes(1);
    expect(chats()).toEqual(['2026-11-07-plan-the-trip-abcdef12.md']);
  });

  it('writes one file and rewrites it on later saves; the view shows the path', async () => {
    const { host, deps } = makeHost();
    host.setConfig({ enabled: true });
    await host.saveNow(SID);
    vi.mocked(deps.getSessionRow).mockResolvedValue({
      title: 'Renamed',
      agentKind: 'hermes',
      model: 'deepseek-flash',
    });
    vi.mocked(deps.listMessages).mockResolvedValue([
      { role: 'user', content: 'Where should we go?', createdAt: 1 },
      { role: 'assistant', content: 'Somewhere warm.', createdAt: 2 },
      { role: 'user', content: 'Lisbon then.', createdAt: 3 },
    ]);
    await host.saveNow(SID);
    expect(chats()).toEqual(['2026-11-07-plan-the-trip-abcdef12.md']);
    const file = path.join(vault, 'Cindy', 'Chats', chats()[0]);
    expect(fs.readFileSync(file, 'utf8')).toContain('Lisbon then.');
    expect(host.getConfig().lastSavedPath).toBe(file);
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('stays quiet with no vault configured or a missing vault folder', async () => {
    const { host, deps } = makeHost({ getVaultDir: vi.fn(() => '') });
    host.setConfig({ enabled: true });
    await host.saveNow(SID);
    expect(deps.getSessionRow).not.toHaveBeenCalled();
    vi.mocked(deps.getVaultDir).mockReturnValue(path.join(dir, 'gone'));
    await host.saveNow(SID);
    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(deps.log.warn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'gone'))).toBe(false);
  });

  it('skips a session with no messages', async () => {
    const { host, deps } = makeHost({ listMessages: vi.fn(async () => []) });
    host.setConfig({ enabled: true });
    await host.saveNow(SID);
    expect(chats()).toEqual([]);
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('logs every failure but pushes it once per streak; success or a settings change re-arms it', async () => {
    const { host, deps } = makeHost();
    host.setConfig({ enabled: true });
    fs.writeFileSync(path.join(vault, 'Cindy'), 'a file where the folder should be');
    await host.saveNow(SID);
    await host.saveNow(SID);
    expect(deps.log.warn).toHaveBeenCalledTimes(2);
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
    expect(host.getConfig().lastError).toBeTruthy();

    fs.rmSync(path.join(vault, 'Cindy'));
    await host.saveNow(SID);
    expect(host.getConfig().lastError).toBeUndefined();
    fs.rmSync(path.join(vault, 'Cindy'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Cindy'), 'blocked again');
    await host.saveNow(SID);
    expect(deps.onFailure).toHaveBeenCalledTimes(2);

    host.setConfig({ folder: 'Cindy/Chats' });
    await host.saveNow(SID);
    expect(deps.onFailure).toHaveBeenCalledTimes(3);
  });

  it('never throws into the caller when a dependency throws', async () => {
    const { host, deps } = makeHost({
      getSessionRow: vi.fn(async () => {
        throw new Error('db closed');
      }),
    });
    host.setConfig({ enabled: true });
    await expect(host.saveNow(SID)).resolves.toBeUndefined();
    expect(deps.onFailure).toHaveBeenCalledWith('db closed');
  });

  it('setConfig merges a partial patch and refuses a folder outside the vault', () => {
    const { host } = makeHost();
    expect(host.setConfig({ folder: 'Notes/AI' })).toMatchObject({
      enabled: false,
      folder: 'Notes/AI',
    });
    expect(host.setConfig({ enabled: true })).toMatchObject({ enabled: true, folder: 'Notes/AI' });
    expect(() => host.setConfig({ folder: '../escape' })).toThrow(/invalid auto-save folder/);
    expect(host.getConfig()).toMatchObject({ enabled: true, folder: 'Notes/AI' });
  });

  it('registers get/set handlers behind the trust check', async () => {
    const handlers = new Map<string, (event: unknown, req?: unknown) => unknown>();
    const registry = {
      handle: (ch: string, fn: (event: unknown, req?: unknown) => unknown) => handlers.set(ch, fn),
    };
    const assertTrusted = vi.fn();
    const { host } = makeHost();
    registerChatAutosaveHandlers(registry as unknown as IpcHandlerRegistry, {
      host,
      assertTrusted,
    });
    const set = handlers.get(MAKER_INVOKE.CHAT_AUTOSAVE_SET_CONFIG);
    const get = handlers.get(MAKER_INVOKE.CHAT_AUTOSAVE_GET_CONFIG);
    expect(await set?.({ sender: 1 }, { enabled: true })).toMatchObject({ enabled: true });
    expect(await get?.({ sender: 1 })).toMatchObject({ enabled: true, folder: 'Cindy/Chats' });
    expect(assertTrusted).toHaveBeenCalledTimes(2);
  });
});
