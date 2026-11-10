import { describe, expect, it } from 'vitest';

import { hermesModelDisplayFallback, isForeignHermesModelId } from '../components/new-chat/ModelSelector';

describe('hermesModelDisplayFallback', () => {
  it('shows the session model id when no descriptor carries it', () => {
    // A Hermes session on the home route: the picker lists that model as the
    // "Hermes home default" sentinel, so no row has this id.
    expect(hermesModelDisplayFallback('hermes', 'deepseek-flash')).toBe('deepseek-flash');
    expect(hermesModelDisplayFallback('hermes', '  deepseek-v4.1-flash-1017 ')).toBe(
      'deepseek-v4.1-flash-1017',
    );
  });

  it('never replaces the sentinel or an empty selection', () => {
    expect(hermesModelDisplayFallback('hermes', 'hermes-default')).toBeUndefined();
    expect(hermesModelDisplayFallback('hermes', '')).toBeUndefined();
    expect(hermesModelDisplayFallback('hermes', '   ')).toBeUndefined();
    expect(hermesModelDisplayFallback('hermes', null)).toBeUndefined();
    expect(hermesModelDisplayFallback('hermes', undefined)).toBeUndefined();
  });

  it('does not touch other engines', () => {
    expect(hermesModelDisplayFallback('codex', 'gpt-5.6-codex')).toBeUndefined();
    expect(hermesModelDisplayFallback('claude-code', 'claude-sonnet-5')).toBeUndefined();
    expect(hermesModelDisplayFallback('pi', 'some-model')).toBeUndefined();
    expect(hermesModelDisplayFallback(null, 'deepseek-flash')).toBeUndefined();
  });

  it('leaves the foreign-engine guard alone', () => {
    expect(isForeignHermesModelId('gpt-5.6-codex')).toBe(true);
    expect(isForeignHermesModelId('deepseek-flash')).toBe(false);
  });
});
