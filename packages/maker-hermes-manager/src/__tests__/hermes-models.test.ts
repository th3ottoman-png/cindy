import { describe, expect, it } from 'vitest';

import { parseProviderModelsResponse } from '../hermes-models.js';

describe('parseProviderModelsResponse', () => {
  it('parses an OpenAI-compatible /models body and sorts ids', () => {
    expect(
      parseProviderModelsResponse({
        object: 'list',
        data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-v4-flash' }],
      }),
    ).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash']);
  });

  it('accepts plain string entries and dedupes', () => {
    expect(parseProviderModelsResponse({ data: ['b', 'a', 'b', ''] })).toEqual(['a', 'b']);
  });

  it('returns empty for malformed bodies instead of throwing', () => {
    expect(parseProviderModelsResponse(null)).toEqual([]);
    expect(parseProviderModelsResponse({})).toEqual([]);
    expect(parseProviderModelsResponse({ data: 'nope' })).toEqual([]);
    expect(parseProviderModelsResponse({ data: [{ nope: 1 }, null] })).toEqual([]);
  });
});

describe('hermes home .env keys', () => {
  it('derives the provider env name and reads the key from .env body', async () => {
    const { hermesHomeApiKey, parseHermesDotEnv } = await import('../hermes-models.js');
    const dotenv = parseHermesDotEnv(
      '# comment\nDEEPSEEK_API_KEY="sk-secret"\nOTHER=plain\n\nBROKEN\n',
    );
    expect(dotenv.OTHER).toBe('plain');
    expect(hermesHomeApiKey(dotenv, 'deepseek')).toBe('sk-secret');
    expect(hermesHomeApiKey(dotenv, 'z.ai')).toBe('');
  });
});
