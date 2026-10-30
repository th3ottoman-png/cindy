import { describe, expect, it } from 'vitest';

import { assessRoute, type ProbeLike } from '../routeHealth';
import type { ProviderFileEntry } from '../providersFile';
import { parseRoutingFile, resolveTaskRoute } from '../routingFile';

const entry = (id: string, local: boolean): ProviderFileEntry => ({
  id,
  kind: 'openai-compatible',
  baseUrl: local ? 'http://127.0.0.1:11434' : 'https://api.example.com',
  capabilities: { tools: true, vision: false },
  local,
});
const providers = [entry('ollama-local', true), entry('lmstudio', true), entry('deepseek', false)];
const config = parseRoutingFile(
  {
    routes: {
      'local-small': { provider: 'ollama-local', model: 'qwen3:8b' },
      'local-alt': { provider: 'lmstudio', model: 'phi' },
      flash: { provider: 'deepseek', model: 'deepseek-flash' },
    },
    rules: { title: 'local-small', 'chat.default': 'flash' },
  },
  providers.map((p) => p.id),
);
const online = (id: string, models: string[]): ProbeLike => ({ id, status: 'online', models });
const assess = (task: string, probes: ProbeLike[]) => assessRoute(resolveTaskRoute(config, task), config, providers, probes);

describe('route health', () => {
  it('is ok when the provider is online and lists the model', () => {
    const health = assess('title', [online('ollama-local', ['qwen3:8b']), online('deepseek', ['deepseek-flash'])]);
    expect(health).toEqual({ ok: true, routeName: 'local-small', provider: 'ollama-local', model: 'qwen3:8b' });
  });

  it('blocks an offline local route and NEVER picks the paid route itself; it only lists it, flagged paid', () => {
    const health = assess('title', [
      { id: 'ollama-local', status: 'offline', models: [], error: 'connection refused' },
      online('lmstudio', ['phi']),
      online('deepseek', ['deepseek-flash']),
    ]);
    expect(health).toMatchObject({ ok: false, reason: 'provider-offline' });
    if (health.ok) throw new Error('unreachable');
    expect(health.message).toContain('connection refused');
    // local alternative first, the paid one last and marked as paid; none is chosen
    expect(health.alternatives).toEqual([
      { routeName: 'local-alt', provider: 'lmstudio', model: 'phi', paid: false },
      { routeName: 'flash', provider: 'deepseek', model: 'deepseek-flash', paid: true },
    ]);
    expect(health).not.toHaveProperty('routeName');
  });

  it('does not offer an alternative that is itself unhealthy', () => {
    const health = assess('title', [
      { id: 'ollama-local', status: 'offline', models: [] },
      { id: 'lmstudio', status: 'error', models: [] },
      online('deepseek', ['something-else']),
    ]);
    if (health.ok) throw new Error('unreachable');
    expect(health.alternatives).toEqual([]);
  });

  it('distinguishes a missing model, a provider error and a provider nobody has probed', () => {
    expect(assess('title', [online('ollama-local', ['llama3'])])).toMatchObject({ ok: false, reason: 'model-missing' });
    expect(assess('title', [{ id: 'ollama-local', status: 'error', models: [], error: 'HTTP 500' }])).toMatchObject({ reason: 'provider-error' });
    expect(assess('title', [])).toMatchObject({ reason: 'not-probed' });
  });

  it('treats "llama3" as present when the endpoint lists "llama3:latest"', () => {
    const cfg = parseRoutingFile({ routes: { r: { provider: 'ollama-local', model: 'llama3' } }, rules: { title: 'r' } }, ['ollama-local']);
    const health = assessRoute(resolveTaskRoute(cfg, 'title'), cfg, providers, [online('ollama-local', ['llama3:latest'])]);
    expect(health.ok).toBe(true);
  });

  it('a task with no routing rule is blocked (not defaulted) and still only suggests', () => {
    const health = assess('summary', [online('ollama-local', ['qwen3:8b'])]);
    expect(health).toMatchObject({ ok: false, reason: 'no-route' });
    if (health.ok) throw new Error('unreachable');
    expect(health.message).toContain('nothing is chosen for you');
    expect(health.alternatives.map((a) => a.routeName)).toEqual(['local-small']);
  });
});
