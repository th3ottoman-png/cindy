import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { providerDeclaresVision, resolveVisionRoute } from '../vision-route.js';

const dirs: string[] = [];
async function setup(providers: string, routing: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vision-route-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'providers.yaml'), providers);
  await writeFile(path.join(dir, 'routing.yaml'), routing);
  return dir;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const VISION_PROVIDER = [
  'providers:',
  '  - id: lmstudio-local',
  '    kind: lmstudio',
  '    baseUrl: http://127.0.0.1:1234',
  '    capabilities:',
  '      tools: false',
  '      vision: true',
  '',
].join('\n');

const TEXT_ONLY_PROVIDER = [
  'providers:',
  '  - id: deepseek',
  '    kind: openai-compatible',
  '    baseUrl: https://api.deepseek.com/v1',
  '    keyEnv: DEEPSEEK_API_KEY',
  '    capabilities:',
  '      tools: true',
  '      vision: false',
  '',
].join('\n');

describe('resolveVisionRoute', () => {
  it('returns not-routed when there is no vision rule', async () => {
    const dir = await setup(VISION_PROVIDER, 'routes:\n  v: { provider: lmstudio-local, model: gemma }\nrules:\n  title: v\n');
    expect(resolveVisionRoute({ harnessDir: dir })).toEqual({ kind: 'not-routed' });
  });

  it('returns not-routed when routing.yaml is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vision-route-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'providers.yaml'), VISION_PROVIDER);
    expect(resolveVisionRoute({ harnessDir: dir })).toEqual({ kind: 'not-routed' });
  });

  it('resolves a vision-capable local route', async () => {
    const dir = await setup(VISION_PROVIDER, 'routes:\n  gemma-local: { provider: lmstudio-local, model: google/gemma-4 }\nrules:\n  vision: gemma-local\n');
    expect(resolveVisionRoute({ harnessDir: dir })).toEqual({
      kind: 'routed',
      route: { provider: 'lmstudio-local', model: 'google/gemma-4', baseUrl: 'http://127.0.0.1:1234' },
    });
  });

  it('carries keyEnv for an API vision route but never the key', async () => {
    const providers = VISION_PROVIDER + '  - id: api-vision\n    kind: openai-compatible\n    baseUrl: https://api.example.com/v1\n    keyEnv: VISION_API_KEY\n    capabilities:\n      vision: true\n';
    const dir = await setup(providers, 'routes:\n  v: { provider: api-vision, model: vl-max }\nrules:\n  vision: v\n');
    expect(resolveVisionRoute({ harnessDir: dir })).toEqual({
      kind: 'routed',
      route: { provider: 'api-vision', model: 'vl-max', baseUrl: 'https://api.example.com/v1', keyEnv: 'VISION_API_KEY' },
    });
  });

  it('blocks a route whose provider lacks capabilities.vision', async () => {
    const dir = await setup(TEXT_ONLY_PROVIDER, 'routes:\n  v: { provider: deepseek, model: deepseek-flash }\nrules:\n  vision: v\n');
    const result = resolveVisionRoute({ harnessDir: dir });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.message).toContain('v');
      expect(result.message).toContain('capabilities.vision');
    }
  });

  it('blocks a vision rule that names an unknown route', async () => {
    const dir = await setup(VISION_PROVIDER, 'routes:\n  v: { provider: lmstudio-local, model: gemma }\nrules:\n  vision: nope\n');
    const result = resolveVisionRoute({ harnessDir: dir });
    expect(result.kind).toBe('blocked');
  });
});

describe('providerDeclaresVision (13.1b bypass)', () => {
  it('is true for a provider that declares vision', async () => {
    const dir = await setup(VISION_PROVIDER, '');
    expect(providerDeclaresVision('lmstudio-local', { harnessDir: dir })).toBe(true);
  });

  it('is false for a text-only provider', async () => {
    const dir = await setup(TEXT_ONLY_PROVIDER, '');
    expect(providerDeclaresVision('deepseek', { harnessDir: dir })).toBe(false);
  });

  it('is false for an unknown or absent provider (fail safe: bridge stays on)', async () => {
    const dir = await setup(VISION_PROVIDER, '');
    expect(providerDeclaresVision('not-in-file', { harnessDir: dir })).toBe(false);
    expect(providerDeclaresVision(undefined, { harnessDir: dir })).toBe(false);
  });
});
