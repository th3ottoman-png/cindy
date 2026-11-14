/**
 * Runtimes IPC (ROADMAP 12.5). The resolution/probe seams are injected, so no real binary is
 * spawned. collectRuntimeStatuses is the pure orchestration over those seams.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeId } from '@cindy/maker-core/runtime-status';

import { MAKER_INVOKE } from '../channels';
import { collectRuntimeStatuses, registerRuntimesHandlers, resolveOnPath, type RuntimesDeps } from '../runtimes';
import { IpcHarness } from './helpers/ipcHarness';

function fakeDeps(overrides: Partial<RuntimesDeps> = {}): RuntimesDeps {
  return {
    resolvePath: (id) => (id === 'pi' ? undefined : '/usr/bin/' + id),
    probeVersion: async (id) => ({ version: id === 'hermes' ? '0.23.0' : '1.2.3' }),
    pinnedVersion: (id) => (id === 'hermes' ? '0.22.7' : undefined),
    ...overrides,
  };
}

describe('collectRuntimeStatuses', () => {
  it('folds ok / missing / pin-mismatch across the four runtimes', async () => {
    const statuses = await collectRuntimeStatuses(fakeDeps());
    expect(statuses.map((s) => s.id)).toEqual(['hermes', 'claude-code', 'codex', 'pi']);
    const hermes = statuses.find((s) => s.id === 'hermes')!;
    expect(hermes.health).toBe('ok');
    expect(hermes.version).toBe('0.23.0');
    expect(hermes.matchesPin).toBe(false);
    const cc = statuses.find((s) => s.id === 'claude-code')!;
    expect(cc.health).toBe('ok');
    expect(cc.matchesPin).toBeNull();
    const pi = statuses.find((s) => s.id === 'pi')!;
    expect(pi.health).toBe('missing');
    expect(pi.matchesPin).toBeNull();
  });

  it('reports a probe error as error health', async () => {
    const statuses = await collectRuntimeStatuses(fakeDeps({
      probeVersion: async (id) => (id === 'codex' ? { version: null, error: 'spawn ENOENT' } : { version: '1.2.3' }),
    }));
    const codex = statuses.find((s) => s.id === 'codex')!;
    expect(codex.health).toBe('error');
    expect(codex.detail).toBe('spawn ENOENT');
  });

  it('reports an unparseable version as error health', async () => {
    const statuses = await collectRuntimeStatuses(fakeDeps({ probeVersion: async () => ({ version: null }) }));
    expect(statuses.find((s) => s.id === 'claude-code')!.health).toBe('error');
  });

  it('matches the pin when the version equals it', async () => {
    const statuses = await collectRuntimeStatuses(fakeDeps({ probeVersion: async () => ({ version: '0.22.7' }) }));
    expect(statuses.find((s) => s.id === 'hermes')!.matchesPin).toBe(true);
  });
});

describe('resolveOnPath', () => {
  let dir: string;
  let originalPath: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtimes-path-'));
    originalPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds an executable on PATH and ignores a non-executable file', () => {
    const bin = path.join(dir, 'fake-runtime');
    fs.writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n');
    fs.chmodSync(bin, 0o755);
    const plain = path.join(dir, 'not-executable');
    fs.writeFileSync(plain, 'x');
    process.env.PATH = dir + path.delimiter + (originalPath ?? '');
    expect(resolveOnPath('fake-runtime')).toBe(bin);
    expect(resolveOnPath('not-executable')).toBeUndefined();
    expect(resolveOnPath('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });
});

describe('runtimes IPC', () => {
  it('lists after a trust check and refuses an untrusted caller', async () => {
    const harness = new IpcHarness();
    const assertTrusted = vi.fn();
    registerRuntimesHandlers(harness, { assertTrusted, runtimes: fakeDeps() });
    const view = (await harness.invoke(MAKER_INVOKE.RUNTIMES_LIST)) as { runtimes: Array<{ id: RuntimeId }> };
    expect(assertTrusted).toHaveBeenCalledOnce();
    expect(view.runtimes).toHaveLength(4);

    const strict = new IpcHarness();
    registerRuntimesHandlers(strict, {
      assertTrusted: () => { throw new Error('untrusted sender'); },
      runtimes: fakeDeps(),
    });
    await expect(strict.invoke(MAKER_INVOKE.RUNTIMES_LIST)).rejects.toThrow('untrusted sender');
  });
});
