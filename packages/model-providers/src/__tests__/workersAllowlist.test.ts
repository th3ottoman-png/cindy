import { describe, expect, it } from 'vitest';

import {
  WORKERS_BLOCK_BEGIN,
  WORKERS_BLOCK_END,
  applyWorkersBlock,
  decideWorkerModel,
  parseWorkersBlock,
  renderWorkersBlock,
  type WorkersConfig,
} from '../routingFile.js';

const ROUTES = ['cheap-api', 'local-small', 'qwen-vl'];

describe('parseWorkersBlock (ROADMAP 13.8)', () => {
  it('no workers: block means no restriction (today\'s behaviour)', () => {
    expect(parseWorkersBlock({ routes: {} }, ROUTES)).toEqual({ config: null, issues: [] });
    expect(parseWorkersBlock(undefined, ROUTES)).toEqual({ config: null, issues: [] });
    expect(parseWorkersBlock(null, ROUTES)).toEqual({ config: null, issues: [] });
  });

  it('parses a valid managed block', () => {
    const parsed = parseWorkersBlock(
      { workers: { allow_model_choice: true, allowed_routes: ['cheap-api', 'local-small'] } },
      ROUTES,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.config).toEqual({ allowModelChoice: true, allowedRoutes: ['cheap-api', 'local-small'] });
  });

  it('honours allow_model_choice: false and an empty allowlist', () => {
    expect(parseWorkersBlock({ workers: { allow_model_choice: false, allowed_routes: [] } }, ROUTES)).toEqual({
      config: { allowModelChoice: false, allowedRoutes: [] },
      issues: [],
    });
  });

  it('defaults allow_model_choice to true and dedupes listed routes', () => {
    const parsed = parseWorkersBlock(
      { workers: { allowed_routes: ['cheap-api', 'cheap-api', 'qwen-vl'] } },
      ROUTES,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.config).toEqual({ allowModelChoice: true, allowedRoutes: ['cheap-api', 'qwen-vl'] });
  });

  it.each([
    ['unknown route', { allow_model_choice: true, allowed_routes: ['cheap-api', 'ghost'] }, 'unknown route "ghost"'],
    ['non-array allowlist', { allow_model_choice: true, allowed_routes: 'cheap-api' }, 'allowed_routes'],
    ['non-string entry', { allow_model_choice: true, allowed_routes: ['cheap-api', 7] }, 'route name'],
    ['non-boolean choice flag', { allow_model_choice: 'yes', allowed_routes: ['cheap-api'] }, 'true or false'],
    ['missing allowlist', { allow_model_choice: true }, 'allowed_routes'],
    ['non-mapping block', 'nope', 'must be a mapping'],
  ])('fails closed on %s: issue listed and choice disabled', (_label, workers, fragment) => {
    const parsed = parseWorkersBlock({ workers }, ROUTES);
    expect(parsed.issues.map((i) => i.message).join('\n')).toContain(fragment);
    expect(parsed.config).toEqual({ allowModelChoice: false, allowedRoutes: [] });
  });
});

describe('renderWorkersBlock / applyWorkersBlock (managed block, hand edits survive)', () => {
  const config: WorkersConfig = { allowModelChoice: false, allowedRoutes: ['cheap-api', 'local-small'] };
  const BASE = [
    '# owner header',
    'routes:',
    '  cheap-api: { provider: tokenhub, model: deepseek-flash }',
    'rules:',
    '  title: cheap-api',
    '',
  ].join('\n');

  it('renders the block with BEGIN/END markers', () => {
    const rendered = renderWorkersBlock(config);
    expect(rendered.startsWith(WORKERS_BLOCK_BEGIN)).toBe(true);
    expect(rendered.endsWith(WORKERS_BLOCK_END)).toBe(true);
    expect(rendered).toContain('allow_model_choice: false');
    expect(rendered).toContain('allowed_routes: [cheap-api, local-small]');
    expect(rendered).toContain('workers:');
  });

  it('appends to a file with no block and changes nothing else', () => {
    const next = applyWorkersBlock(BASE, config);
    expect(next.startsWith(BASE.trimEnd())).toBe(true);
    expect(next.match(/BEGIN cindy-workers/g)).toHaveLength(1);
    expect(next).toContain('  title: cheap-api');
  });

  it('replaces an existing block in place, keeping surrounding hand-written content', () => {
    const first = applyWorkersBlock(BASE, config);
    const tail = '\n# hand-written note under the block\n';
    const withTail = first + tail;
    const second = applyWorkersBlock(withTail, { allowModelChoice: true, allowedRoutes: ['qwen-vl'] });
    expect(second.match(/BEGIN cindy-workers/g)).toHaveLength(1);
    expect(second).toContain('allow_model_choice: true');
    expect(second).toContain('allowed_routes: [qwen-vl]');
    expect(second).not.toContain('allowed_routes: [cheap-api, local-small]');
    expect(second).toContain('# owner header');
    expect(second.trimEnd().endsWith('# hand-written note under the block')).toBe(true);
    expect(applyWorkersBlock(second, { allowModelChoice: true, allowedRoutes: ['qwen-vl'] })).toBe(second);
  });

  it('removing an appended block restores a file ending in one newline byte for byte', () => {
    const original = [
      '# owner header',
      'routes:',
      '  cheap-api: { provider: tokenhub, model: m }',
      '',
      '# BEGIN cindy-council (managed by Cindy; this block is rewritten)',
      'council:',
      '  reviewers: []',
      '# END cindy-council',
      '',
    ].join('\n');
    const withBlock = applyWorkersBlock(original, config);
    expect(applyWorkersBlock(withBlock, null)).toBe(original);
  });

  it('removing the block restores today\'s behaviour without deleting hand edits', () => {
    const withBlock = applyWorkersBlock(BASE, config) + '\n# trailing note\n';
    const removed = applyWorkersBlock(withBlock, null);
    expect(removed).not.toContain('BEGIN cindy-workers');
    expect(removed).not.toContain('workers:');
    expect(removed).toContain('# owner header');
    expect(removed).toContain('# trailing note');
    expect(removed.trimEnd()).toBe(`${BASE.trimEnd()}\n# trailing note`.trimEnd());
  });
});

describe('decideWorkerModel (ROADMAP 13.8 decision table)', () => {
  const on: WorkersConfig = { allowModelChoice: true, allowedRoutes: ['cheap-api', 'local-small'] };

  it('no managed block allows any lead-chosen model (today\'s behaviour)', () => {
    expect(decideWorkerModel({ model: 'pricey-api', source: 'lead', config: null })).toEqual({ allowed: true });
  });

  it('a listed lead model is allowed', () => {
    expect(decideWorkerModel({ model: 'cheap-api', source: 'lead', config: on })).toEqual({ allowed: true });
  });

  it('an unlisted lead model is refused and the message names every allowed route', () => {
    const decision = decideWorkerModel({ model: 'pricey-api', source: 'lead', config: on });
    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain('pricey-api');
    expect(decision.message).toContain('cheap-api, local-small');
    expect(decision.message).toContain('No Worker was started');
  });

  it('choice off refuses even a listed route', () => {
    const off: WorkersConfig = { allowModelChoice: false, allowedRoutes: ['cheap-api'] };
    const decision = decideWorkerModel({ model: 'cheap-api', source: 'lead', config: off });
    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain('cheap-api');
  });

  it('expert model and the default are always allowed, whatever the config', () => {
    const off: WorkersConfig = { allowModelChoice: false, allowedRoutes: [] };
    expect(decideWorkerModel({ model: 'expert-route', source: 'expert', config: off })).toEqual({ allowed: true });
    expect(decideWorkerModel({ model: 'hermes-default', source: 'default', config: off })).toEqual({ allowed: true });
  });

  it('an owner-written value stays allowed even when the lead names it explicitly', () => {
    const off: WorkersConfig = { allowModelChoice: false, allowedRoutes: [] };
    expect(decideWorkerModel({ model: 'hermes-default', source: 'lead', config: off, defaultModel: 'hermes-default' })).toEqual({ allowed: true });
    expect(decideWorkerModel({ model: 'expert-route', source: 'lead', config: off, expertModel: 'expert-route' })).toEqual({ allowed: true });
  });

  it('a fail-closed parse blocks the lead and names the empty allowlist', () => {
    const decision = decideWorkerModel({
      model: 'pricey-api',
      source: 'lead',
      config: { allowModelChoice: false, allowedRoutes: [] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain('(none)');
  });
});
