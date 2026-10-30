import { describe, expect, it } from 'vitest';

import { parseRoutingFile, resolveTaskRoute } from '../routingFile.js';

const PROVIDERS = ['ollama-local', 'deepseek'];
const DOC = {
  routes: {
    'local-small': { provider: 'ollama-local', model: 'qwen3:8b' },
    flash: { provider: 'deepseek', model: 'deepseek-flash' },
  },
  rules: { title: 'local-small', predict: 'local-small', 'chat.default': 'flash' },
};

describe('parseRoutingFile', () => {
  it('accepts a valid file', () => {
    const parsed = parseRoutingFile(DOC, PROVIDERS);
    expect(parsed.issues).toEqual([]);
    expect(Object.keys(parsed.routes)).toEqual(['local-small', 'flash']);
    expect(parsed.rules.title).toBe('local-small');
  });

  it('treats an empty document as empty routing', () => {
    expect(parseRoutingFile(undefined, PROVIDERS)).toEqual({ routes: {}, rules: {}, issues: [] });
  });

  it.each([
    ['a route on an unknown provider', { routes: { r: { provider: 'nope', model: 'm' } } }, 'unknown provider "nope"'],
    ['a route without a model', { routes: { r: { provider: 'deepseek' } } }, 'needs a "provider"'],
    ['a bad route name', { routes: { 'Bad Name': { provider: 'deepseek', model: 'm' } } }, 'route names are'],
    ['a rule naming an unknown route', { routes: DOC.routes, rules: { title: 'ghost' } }, 'unknown route "ghost"'],
    ['a non-string rule', { routes: DOC.routes, rules: { title: 5 } }, 'must be a route name'],
    ['a list at the top level', ['x'], 'top level must be a mapping'],
  ])('reports %s and keeps what is valid', (_label, doc, fragment) => {
    const parsed = parseRoutingFile(doc, PROVIDERS);
    expect(parsed.issues.map((i) => i.message).join('\n')).toContain(fragment);
  });

  it('drops an invalid route but keeps the valid ones and rules that point at them', () => {
    const parsed = parseRoutingFile(
      { routes: { ...DOC.routes, broken: { provider: 'nope', model: 'm' } }, rules: { title: 'local-small', predict: 'broken' } },
      PROVIDERS,
    );
    expect(Object.keys(parsed.routes)).toEqual(['local-small', 'flash']);
    expect(parsed.rules).toEqual({ title: 'local-small' });
    expect(parsed.issues).toHaveLength(2);
  });
});

describe('resolveTaskRoute', () => {
  const cfg = parseRoutingFile(DOC, PROVIDERS);

  it('resolves an exact rule to its provider and model', () => {
    expect(resolveTaskRoute(cfg, 'title')).toEqual({
      ok: true,
      taskClass: 'title',
      routeName: 'local-small',
      target: { provider: 'ollama-local', model: 'qwen3:8b' },
    });
  });

  it('falls back from "chat.code" to "chat.default", and only that', () => {
    expect(resolveTaskRoute(cfg, 'chat.code')).toMatchObject({ ok: true, routeName: 'flash' });
    expect(resolveTaskRoute(cfg, 'summary')).toMatchObject({ ok: false });
  });

  it('fails closed with a clear error when no rule exists, even though other routes exist', () => {
    const r = resolveTaskRoute(cfg, 'summary');
    expect(r).toEqual({ ok: false, taskClass: 'summary', error: expect.stringContaining('no routing rule for "summary"') });
  });

  it('an empty file resolves nothing (no implicit default model)', () => {
    expect(resolveTaskRoute({ routes: {}, rules: {} }, 'chat.default')).toMatchObject({ ok: false });
  });
});
