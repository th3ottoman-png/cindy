import { describe, expect, it } from 'vitest';

import { assessContext, guardContext } from '../contextGuard';
import type { ProviderFileEntry } from '../providersFile';
import type { ProbeLike } from '../routeHealth';
import { parseRoutingFile } from '../routingFile';

describe('assessContext', () => {
  it('is ok below the warn threshold and reports remaining tokens', () => {
    expect(assessContext(7_999, 10_000)).toMatchObject({ level: 'ok', remainingTokens: 2_001 });
  });

  it('warns at 80% exactly and is critical at 95% exactly', () => {
    expect(assessContext(8_000, 10_000).level).toBe('warn');
    expect(assessContext(9_499, 10_000).level).toBe('warn');
    expect(assessContext(9_500, 10_000).level).toBe('critical');
  });

  it('over the limit is critical with 0 left, not negative', () => {
    expect(assessContext(12_000, 10_000)).toMatchObject({ level: 'critical', remainingTokens: 0 });
  });

  it('says so, instead of guessing, when the context length or usage is unknown', () => {
    expect(assessContext(5_000, undefined)).toMatchObject({ level: 'unknown' });
    expect(assessContext(5_000, 0).level).toBe('unknown');
    expect(assessContext(Number.NaN, 10_000).level).toBe('unknown');
    expect(assessContext(-1, 10_000).level).toBe('unknown');
    expect(assessContext(5_000, undefined).message).toContain('contextLength');
  });

  it('honours custom thresholds and rejects nonsense ones', () => {
    expect(assessContext(5_000, 10_000, { warnAt: 0.5, criticalAt: 0.9 }).level).toBe('warn');
    expect(() => assessContext(1, 10, { warnAt: 0.9, criticalAt: 0.5 })).toThrow(RangeError);
    expect(() => assessContext(1, 10, { warnAt: 0, criticalAt: 0.5 })).toThrow(RangeError);
    expect(() => assessContext(1, 10, { criticalAt: 1.5 })).toThrow(RangeError);
  });
});

describe('guardContext', () => {
  const entry = (id: string, local: boolean): ProviderFileEntry => ({
    id,
    kind: 'openai-compatible',
    baseUrl: local ? 'http://127.0.0.1:11434' : 'https://api.example.com',
    capabilities: { tools: true, vision: false },
    local,
  });
  const providers = [entry('ollama-local', true), entry('deepseek', false)];
  const routing = parseRoutingFile(
    {
      routes: { 'local-small': { provider: 'ollama-local', model: 'qwen3:8b' }, flash: { provider: 'deepseek', model: 'deepseek-flash' } },
      rules: { summary: 'local-small' },
    },
    providers.map((p) => p.id),
  );
  const online = (id: string, models: string[]): ProbeLike => ({ id, status: 'online', models });
  const base = { contextLength: 10_000, routing, providers };

  it('offers nothing while the context is comfortable', () => {
    const r = guardContext({ ...base, usedTokens: 1_000, probes: [online('ollama-local', ['qwen3:8b'])] });
    expect(r.context.level).toBe('ok');
    expect(r.summarise).toBeUndefined();
  });

  it('at warn, offers summarise-and-continue on the routed local summariser', () => {
    const r = guardContext({ ...base, usedTokens: 8_500, probes: [online('ollama-local', ['qwen3:8b'])] });
    expect(r.summarise).toEqual({ ok: true, routeName: 'local-small', provider: 'ollama-local', model: 'qwen3:8b' });
  });

  it('when the summariser is offline it is blocked, lists the paid route as an alternative, and does not use it', () => {
    const r = guardContext({
      ...base,
      usedTokens: 9_700,
      probes: [{ id: 'ollama-local', status: 'offline', models: [], error: 'connection refused' }, online('deepseek', ['deepseek-flash'])],
    });
    expect(r.context.level).toBe('critical');
    expect(r.summarise).toMatchObject({ ok: false, reason: 'provider-offline' });
    if (!r.summarise || r.summarise.ok) throw new Error('unreachable');
    expect(r.summarise.alternatives).toEqual([{ routeName: 'flash', provider: 'deepseek', model: 'deepseek-flash', paid: true }]);
  });

  it('with no summary rule it says so rather than choosing a model', () => {
    const r = guardContext({
      ...base,
      routing: parseRoutingFile({}, []),
      usedTokens: 9_000,
      probes: [online('ollama-local', ['qwen3:8b'])],
    });
    expect(r.summarise).toMatchObject({ ok: false, reason: 'no-route' });
  });
});
