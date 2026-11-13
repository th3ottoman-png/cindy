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

  describe('editor (ROADMAP 3.3)', () => {
    const HAND = '---\nname: Reviewer\ndescription: Reviews diffs.\ntools: [draft_expert]\n---\nYou review code.\n';
    const fields = { name: 'Reviewer', description: 'Reviews diffs.', tags: [], memory: false, prompt: 'You review code.' };

    function setup() {
      const broadcast = vi.fn();
      const assertTrusted = vi.fn();
      const harness = new IpcHarness();
      handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted, broadcast, watch: fakeWatch().watch });
      return { harness, broadcast, assertTrusted };
    }

    it('reads an expert source after a trust check', async () => {
      writeExpert('reviewer', HAND);
      const { harness, assertTrusted } = setup();
      const res = await harness.invoke(MAKER_INVOKE.EXPERTS_READ, 'reviewer');
      expect(assertTrusted).toHaveBeenCalledOnce();
      expect(res).toMatchObject({ ok: true, slug: 'reviewer', markdown: HAND, extras: { tools: ['draft_expert'] } });
    });

    it('creates through the draft write path (no tools) and pushes the fresh list', async () => {
      const { harness, broadcast } = setup();
      const res = await harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, {
        op: 'create',
        slug: 'writer',
        fields: { ...fields, name: 'Writer', description: 'Writes.' },
      });
      expect(res).toMatchObject({ ok: true, slug: 'writer' });
      const list = loadExperts(root);
      expect(list.map((e) => e.expert?.name)).toEqual(['Writer']);
      expect(list[0].expert?.tools).toEqual([]);
      expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_CHANGED, list);
    });

    it('duplicates and edits through the same RPC', async () => {
      writeExpert('reviewer', HAND);
      const { harness } = setup();
      expect(await harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, { op: 'duplicate', from: 'reviewer', slug: 'reviewer-2', name: 'Reviewer 2' })).toMatchObject({ ok: true, slug: 'reviewer-2' });

      const read = (await harness.invoke(MAKER_INVOKE.EXPERTS_READ, 'reviewer-2')) as { ok: true; hash: string };
      const saved = await harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, {
        op: 'edit',
        slug: 'reviewer-2',
        baseHash: read.hash,
        fields: { ...fields, name: 'Reviewer 2', prompt: 'Be strict.' },
      });
      expect(saved).toMatchObject({ ok: true, slug: 'reviewer-2' });
      const copy = loadExperts(root).find((e) => e.slug === 'reviewer-2');
      expect(copy?.expert).toMatchObject({ prompt: 'Be strict.', tools: ['draft_expert'] });
    });

    it('returns a conflict instead of overwriting a hand edit', async () => {
      writeExpert('reviewer', HAND);
      const { harness, broadcast } = setup();
      const read = (await harness.invoke(MAKER_INVOKE.EXPERTS_READ, 'reviewer')) as { ok: true; hash: string };
      writeExpert('reviewer', HAND.replace('You review code.', 'Hand edit.'));
      const res = await harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, { op: 'edit', slug: 'reviewer', baseHash: read.hash, fields });
      expect(res).toMatchObject({ ok: false, reason: 'conflict' });
      expect(fs.readFileSync(path.join(root, 'reviewer', 'expert.md'), 'utf8')).toContain('Hand edit.');
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('deletes an expert folder and broadcasts the fresh list', async () => {
      writeExpert('reviewer', HAND);
      const { harness, broadcast } = setup();
      expect(loadExperts(root).map((e) => e.slug)).toEqual(['reviewer']);
      const res = await harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, { op: 'delete', slug: 'reviewer' });
      expect(res).toMatchObject({ ok: true, slug: 'reviewer' });
      expect(fs.existsSync(path.join(root, 'reviewer'))).toBe(false);
      expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_CHANGED, []);
    });

    it('refuses an untrusted caller and junk requests without writing', async () => {
      const harness = new IpcHarness();
      handle = registerExpertsHandlers(harness, {
        rootDir: root,
        assertTrusted: () => {
          throw new Error('untrusted sender');
        },
        broadcast: vi.fn(),
        watch: fakeWatch().watch,
      });
      await expect(harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, { op: 'create', slug: 'x-y', fields })).rejects.toThrow('untrusted sender');
      handle.dispose();
      const { harness: ok } = setup();
      expect(await ok.invoke(MAKER_INVOKE.EXPERTS_SAVE, { op: 'delete', slug: '../bad' })).toMatchObject({ ok: false, reason: 'invalid' });
      expect(await ok.invoke(MAKER_INVOKE.EXPERTS_SAVE, { op: 'delete', slug: 'non-existent' })).toMatchObject({ ok: false, reason: 'missing' });
      expect(await ok.invoke(MAKER_INVOKE.EXPERTS_SAVE, null)).toMatchObject({ ok: false, reason: 'invalid' });
      expect(fs.readdirSync(root)).toEqual([]);
    });
  });

  describe('create-from-form (ROADMAP 12.2)', () => {
    it('writes an owner-authored expert with program and cap, and pushes the fresh list', async () => {
      const broadcast = vi.fn();
      const harness = new IpcHarness();
      handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted: vi.fn(), broadcast, watch: fakeWatch().watch });
      const res = await harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, {
        op: 'create-from-form',
        slug: 'form-agent',
        fields: { name: 'Form Agent', description: 'Does form things.', agent: 'claude-code', maxConcurrent: 2, prompt: 'You are a form agent.' },
      }) as { ok: boolean; slug?: string };
      expect(res).toMatchObject({ ok: true, slug: 'form-agent' });
      const loaded = loadExperts(root).find((e) => e.slug === 'form-agent');
      expect(loaded?.expert?.agent).toBe('claude-code');
      expect(loaded?.expert?.maxConcurrent).toBe(2);
      expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_CHANGED, expect.any(Array));
    });

    it('refuses invalid form input without writing', async () => {
      const harness = new IpcHarness();
      handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted: vi.fn(), broadcast: vi.fn(), watch: fakeWatch().watch });
      const res = await harness.invoke(MAKER_INVOKE.EXPERTS_SAVE, {
        op: 'create-from-form',
        slug: 'form-agent',
        fields: { name: 'Form Agent', description: 'D.', agent: 'qwen', prompt: 'Body.' },
      });
      expect(res).toMatchObject({ ok: false, reason: 'invalid' });
      expect(fs.readdirSync(root)).toEqual([]);
    });
  });
});
