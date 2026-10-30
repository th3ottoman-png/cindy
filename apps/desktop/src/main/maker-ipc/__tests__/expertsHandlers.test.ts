import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { registerExpertsHandlers, type ExpertsHandlerHandle } from '../expertsHandlers';
import { IpcHarness } from './helpers/ipcHarness';

let root: string;
let handle: ExpertsHandlerHandle | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'experts-ipc-'));
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeExpert(slug: string, md: string): void {
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  fs.writeFileSync(path.join(root, slug, 'expert.md'), md);
}

describe('experts IPC', () => {
  it('lists valid and invalid experts after a trust check', async () => {
    writeExpert('good', '---\nname: Good\n---\nPrompt.\n');
    writeExpert('bad', '---\nagent: hermes\n---\nPrompt.\n');
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted, broadcast: vi.fn() });

    const list = (await harness.invoke(MAKER_INVOKE.EXPERTS_LIST)) as Array<{ slug: string; error?: string }>;
    expect(assertTrusted).toHaveBeenCalledOnce();
    expect(list.map((e) => e.slug)).toEqual(['bad', 'good']);
    expect(list[0].error).toContain('"name" is required');
  });

  it('refuses an untrusted caller without reading the directory', async () => {
    writeExpert('good', '---\nname: Good\n---\nPrompt.\n');
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, {
      rootDir: root,
      assertTrusted: () => {
        throw new Error('untrusted sender');
      },
      broadcast: vi.fn(),
    });
    await expect(harness.invoke(MAKER_INVOKE.EXPERTS_LIST)).rejects.toThrow('untrusted sender');
  });

  it('pushes the fresh list when an expert file changes after the first list call', async () => {
    writeExpert('one', '---\nname: One\n---\nPrompt.\n');
    const broadcast = vi.fn();
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted: vi.fn(), broadcast });
    await harness.invoke(MAKER_INVOKE.EXPERTS_LIST);

    writeExpert('one', '---\nname: Renamed\n---\nPrompt.\n');
    await vi.waitFor(
      () => {
        const last = broadcast.mock.calls.at(-1);
        expect(last?.[0]).toBe(MAKER_PUSH.EXPERTS_CHANGED);
        expect(last?.[1][0].expert.name).toBe('Renamed');
      },
      { timeout: 15_000 },
    );
  }, 60_000);

  it('does not watch until the first list call', async () => {
    writeExpert('one', '---\nname: One\n---\nPrompt.\n');
    const broadcast = vi.fn();
    handle = registerExpertsHandlers(new IpcHarness(), { rootDir: root, assertTrusted: vi.fn(), broadcast });
    writeExpert('one', '---\nname: Changed\n---\nPrompt.\n');
    // real-wait: asserting that no watcher event fires needs a bounded quiet period
    await new Promise((r) => setTimeout(r, 500));
    expect(broadcast).not.toHaveBeenCalled();
  });
});
