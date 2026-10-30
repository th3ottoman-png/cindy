import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { loadExperts, type ExpertEntry, type watchExperts } from '@cindy/maker-core/experts';

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

  // The watcher is faked: real fs.watch inside a vitest worker thread is a native handle that
  // risks the threads-pool teardown SIGSEGV (ROADMAP Debt). Real watching is covered by
  // maker-core's expert-loader tests, which run in the forks pool.
  function fakeWatch() {
    const calls: Array<{ root: string; onChange: (entries: ExpertEntry[]) => void; closed: boolean }> = [];
    const watch = ((root: string, onChange: (entries: ExpertEntry[]) => void) => {
      const call = { root, onChange, closed: false };
      calls.push(call);
      return { close: () => { call.closed = true; } };
    }) as unknown as typeof watchExperts;
    return { calls, watch };
  }

  it('starts one watcher on the first list call and pushes what it reports', async () => {
    writeExpert('one', '---\nname: One\n---\nPrompt.\n');
    const broadcast = vi.fn();
    const { calls, watch } = fakeWatch();
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted: vi.fn(), broadcast, watch });
    expect(calls).toHaveLength(0);

    await harness.invoke(MAKER_INVOKE.EXPERTS_LIST);
    await harness.invoke(MAKER_INVOKE.EXPERTS_LIST);
    expect(calls).toHaveLength(1);
    expect(calls[0].root).toBe(root);

    const fresh = loadExperts(root);
    calls[0].onChange(fresh);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_CHANGED, fresh);
  });

  it('closes the watcher on dispose', async () => {
    const { calls, watch } = fakeWatch();
    const harness = new IpcHarness();
    const h = registerExpertsHandlers(harness, { rootDir: root, assertTrusted: vi.fn(), broadcast: vi.fn(), watch });
    await harness.invoke(MAKER_INVOKE.EXPERTS_LIST);
    h.dispose();
    expect(calls[0].closed).toBe(true);
  });
});
