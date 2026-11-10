import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScreenShareHost, registerScreenShareHandlers } from '../screenShare';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels';

describe('ScreenShareHost', () => {
  let tmpHarness = '';

  beforeEach(() => {
    tmpHarness = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshare-test-'));
  });

  afterEach(() => {
    if (tmpHarness && fs.existsSync(tmpHarness)) {
      fs.rmSync(tmpHarness, { recursive: true, force: true });
    }
  });

  it('defaults to enabled=false and maskStyle=badge', () => {
    const host = new ScreenShareHost({ getHarnessDir: () => tmpHarness });
    const config = host.getConfig();

    expect(config.enabled).toBe(false);
    expect(config.maskStyle).toBe('badge');
  });

  it('updates configuration and persists to screen-share.json atomically', () => {
    const pushed: Array<{ channel: string; payload: unknown }> = [];
    const host = new ScreenShareHost({
      getHarnessDir: () => tmpHarness,
      pushEvent: (channel, payload) => pushed.push({ channel, payload }),
    });

    const updated = host.setConfig({ enabled: true, maskStyle: 'bullets' });
    expect(updated.enabled).toBe(true);
    expect(updated.maskStyle).toBe('bullets');

    // Verify on disk
    const onDiskPath = path.join(tmpHarness, 'screen-share.json');
    expect(fs.existsSync(onDiskPath)).toBe(true);
    const diskContent = JSON.parse(fs.readFileSync(onDiskPath, 'utf8'));
    expect(diskContent.enabled).toBe(true);
    expect(diskContent.maskStyle).toBe('bullets');

    // Verify push event fired
    expect(pushed).toHaveLength(1);
    expect(pushed[0].channel).toBe(MAKER_PUSH.SCREEN_SHARE_CHANGED);
    expect((pushed[0].payload as any).enabled).toBe(true);
  });

  it('redacts sensitive credentials and formats with bullets', () => {
    const host = new ScreenShareHost({ getHarnessDir: () => tmpHarness });
    const raw = 'api_key: sk-123456789012345678, user=john@example.com';
    const redacted = host.redact(raw, { maskStyle: 'bullets' });

    expect(redacted).not.toContain('sk-123456789012345678');
    expect(redacted).not.toContain('john@example.com');
  });

  it('registers IPC handlers and handles invoke events', async () => {
    const host = new ScreenShareHost({ getHarnessDir: () => tmpHarness });
    const handlers: Record<string, Function> = {};
    const mockIpc = {
      handle: (channel: string, fn: Function) => {
        handlers[channel] = fn;
      },
    } as any;

    const pushEvent = vi.fn();
    const assertSenderTrusted = vi.fn();

    registerScreenShareHandlers(mockIpc, () => host, pushEvent, assertSenderTrusted);

    expect(handlers[MAKER_INVOKE.SCREEN_SHARE_GET_CONFIG]).toBeTypeOf('function');
    expect(handlers[MAKER_INVOKE.SCREEN_SHARE_SET_CONFIG]).toBeTypeOf('function');

    const getRes = await handlers[MAKER_INVOKE.SCREEN_SHARE_GET_CONFIG]({ senderFrame: {} });
    expect(assertSenderTrusted).toHaveBeenCalled();
    expect(getRes.enabled).toBe(false);

    const setRes = await handlers[MAKER_INVOKE.SCREEN_SHARE_SET_CONFIG](
      { senderFrame: {} },
      { enabled: true },
    );
    expect(setRes.enabled).toBe(true);
    expect(pushEvent).toHaveBeenCalledWith(MAKER_PUSH.SCREEN_SHARE_CHANGED, setRes);
  });
});
