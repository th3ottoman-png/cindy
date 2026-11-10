import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactsHost, registerArtifactsHandlers } from '../artifacts';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import type { IpcHandlerRegistry } from '../ipcHandlerRegistry';

describe('ArtifactsHost and IPC', () => {
  let tempVault: string;
  let broadcast: ReturnType<typeof vi.fn>;
  let assertTrusted: ReturnType<typeof vi.fn>;
  let host: ArtifactsHost;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-artifacts-host-test-'));
    broadcast = vi.fn();
    assertTrusted = vi.fn();
    host = new ArtifactsHost({
      getVaultDir: () => tempVault,
      assertTrusted,
      broadcast,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempVault, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('fails cleanly when no vault is configured', () => {
    const noVaultHost = new ArtifactsHost({
      getVaultDir: () => '',
      assertTrusted,
      broadcast,
    });

    const res = noVaultHost.list();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No notes vault configured');
  });

  it('saves and lists artifacts, broadcasting VAULT_CHANGED', () => {
    const res = host.save({
      title: 'API Spec',
      content: '# API Endpoints\n\nGET /users',
      type: 'spec',
      tags: ['api'],
    });

    expect(res.ok).toBe(true);
    expect(res.artifact).toBeDefined();
    expect(res.artifact?.title).toBe('API Spec');
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.VAULT_CHANGED, expect.any(Object));

    const listRes = host.list();
    expect(listRes.ok).toBe(true);
    expect(listRes.artifacts).toHaveLength(1);
    expect(listRes.artifacts[0].title).toBe('API Spec');
    expect(listRes.artifacts[0].type).toBe('spec');
  });

  it('reads and deletes artifacts', () => {
    const saveRes = host.save({
      id: 'custom-schema',
      title: 'Custom Schema',
      content: 'type Query { hello: String }',
      type: 'graphql',
    });
    expect(saveRes.ok).toBe(true);

    const readRes = host.read('custom-schema');
    expect(readRes.ok).toBe(true);
    expect(readRes.artifact?.content).toContain('type Query');

    const deleteRes = host.delete('custom-schema');
    expect(deleteRes.ok).toBe(true);
    expect(deleteRes.deleted).toBe(true);

    const afterList = host.list();
    expect(afterList.artifacts).toHaveLength(0);
  });

  it('registers IPC handlers properly', async () => {
    const handlers = new Map<string, Function>();
    const fakeRegistry: IpcHandlerRegistry = {
      handle: vi.fn((channel, handler) => {
        handlers.set(channel, handler);
      }),
    };

    registerArtifactsHandlers(fakeRegistry, {
      getVaultDir: () => tempVault,
      assertTrusted,
      broadcast,
    });

    expect(handlers.has(MAKER_INVOKE.ARTIFACTS_LIST)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.ARTIFACTS_SAVE)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.ARTIFACTS_READ)).toBe(true);
    expect(handlers.has(MAKER_INVOKE.ARTIFACTS_DELETE)).toBe(true);

    const saveHandler = handlers.get(MAKER_INVOKE.ARTIFACTS_SAVE)!;
    const saveResult = await saveHandler({}, {
      payload: { title: 'IPC Artifact', content: 'hello' },
    });
    expect(assertTrusted).toHaveBeenCalled();
    expect(saveResult.ok).toBe(true);
    expect(saveResult.artifact.title).toBe('IPC Artifact');
  });
});
