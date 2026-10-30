import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import { registerProvidersHandlers } from '../providersHandlers';
import { IpcHarness } from './helpers/ipcHarness';

let dir: string;
let file: string;
let server: http.Server | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-ipc-'));
  file = path.join(dir, 'providers.yaml');
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function serveModels(): Promise<number> {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'qwen-small' }] }) : '{}');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('providers IPC', () => {
  it('lists the configured endpoints and the file issues after a trust check', async () => {
    fs.writeFileSync(
      file,
      'providers:\n  - id: local\n    kind: openai-compatible\n    baseUrl: http://127.0.0.1:1\n  - id: Bad Id\n    kind: ollama\n    baseUrl: http://127.0.0.1:2\n',
    );
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    registerProvidersHandlers(harness, { file, assertTrusted });

    const result = (await harness.invoke(MAKER_INVOKE.PROVIDERS_LIST)) as {
      providers: Array<{ id: string }>;
      issues: unknown[];
    };
    expect(assertTrusted).toHaveBeenCalledOnce();
    expect(result.providers.map((p) => p.id)).toEqual(['local']);
    expect(result.issues).toHaveLength(1);
  });

  it('probes every configured endpoint: one online with its models, one dead and offline', async () => {
    const port = await serveModels();
    fs.writeFileSync(
      file,
      `providers:\n  - id: up\n    kind: openai-compatible\n    baseUrl: http://127.0.0.1:${port}/v1\n  - id: down\n    kind: openai-compatible\n    baseUrl: http://127.0.0.1:1\n`,
    );
    const harness = new IpcHarness();
    registerProvidersHandlers(harness, { file, assertTrusted: vi.fn(), discoveryOptions: { timeoutMs: 1500 } });

    const probes = (await harness.invoke(MAKER_INVOKE.PROVIDERS_DISCOVER)) as Array<{
      id: string;
      status: string;
      models: string[];
    }>;
    expect(probes.find((p) => p.id === 'up')).toMatchObject({ status: 'online', models: ['qwen-small'] });
    expect(probes.find((p) => p.id === 'down')?.status).toBe('offline');
  });

  it('returns an empty list when providers.yaml does not exist', async () => {
    const harness = new IpcHarness();
    registerProvidersHandlers(harness, { file, assertTrusted: vi.fn() });
    expect(await harness.invoke(MAKER_INVOKE.PROVIDERS_DISCOVER)).toEqual([]);
  });

  it('refuses an untrusted caller on both channels without reading the file', async () => {
    fs.writeFileSync(file, 'providers: []\n');
    const harness = new IpcHarness();
    registerProvidersHandlers(harness, {
      file,
      assertTrusted: () => {
        throw new Error('untrusted sender');
      },
    });
    await expect(harness.invoke(MAKER_INVOKE.PROVIDERS_LIST)).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.PROVIDERS_DISCOVER)).rejects.toThrow('untrusted sender');
  });
});
