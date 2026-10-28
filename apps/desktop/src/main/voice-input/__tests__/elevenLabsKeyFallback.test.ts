import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  customKeys: new Map<string, string>(),
  secretStoreKeys: new Map<string, string>(),
}));

vi.mock('../../secrets/providerSecretStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets/providerSecretStore.js')>();
  return {
    ...actual,
    getProviderSecretStore: () => ({
      get: (id: string) => mocks.secretStoreKeys.get(id) ?? null,
      has: (id: string) => mocks.secretStoreKeys.has(id),
    }),
    readCustomProviderKey: (providerId: string, agent: string) => {
      return mocks.customKeys.get(`${providerId}:${agent}`) ?? null;
    },
  };
});

import { readElevenLabsApiKey, readElevenLabsBaseUrl } from '../index.js';

describe('ElevenLabs key fallback (Phase 2.4)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.XDT_ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.XDT_ELEVENLABS_BASE_URL;
    delete process.env.ELEVENLABS_BASE_URL;
    mocks.customKeys.clear();
    mocks.secretStoreKeys.clear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('prefers explicit environment variables when present', () => {
    process.env.ELEVENLABS_API_KEY = 'env-api-key';
    mocks.customKeys.set('elevenlabs-api:codex', 'provider-api-key');

    expect(readElevenLabsApiKey()).toBe('env-api-key');
  });

  it('falls back to elevenlabs-api preset key when env is unset', () => {
    mocks.customKeys.set('elevenlabs-api:codex', 'preset-elevenlabs-key');

    expect(readElevenLabsApiKey()).toBe('preset-elevenlabs-key');
  });

  it('falls back to elevenlabs provider key when env is unset', () => {
    mocks.customKeys.set('elevenlabs:claude-code', 'custom-elevenlabs-key');

    expect(readElevenLabsApiKey()).toBe('custom-elevenlabs-key');
  });

  it('falls back to voice-asr key in secret store', () => {
    mocks.secretStoreKeys.set('voice-asr', 'voice-asr-secret-key');

    expect(readElevenLabsApiKey()).toBe('voice-asr-secret-key');
  });

  it('returns null when no key is configured anywhere', () => {
    expect(readElevenLabsApiKey()).toBeNull();
  });

  it('resolves base URL from environment', () => {
    expect(readElevenLabsBaseUrl()).toBeUndefined();

    process.env.ELEVENLABS_BASE_URL = 'https://override.elevenlabs.io';
    expect(readElevenLabsBaseUrl()).toBe('https://override.elevenlabs.io');
  });
});
