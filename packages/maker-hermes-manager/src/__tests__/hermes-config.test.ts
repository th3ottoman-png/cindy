import { describe, expect, it } from 'vitest';

import { parseHermesDefaultRoute } from '../hermes-config.js';

describe('parseHermesDefaultRoute', () => {
  it('reads the top-level model block', () => {
    expect(
      parseHermesDefaultRoute('model:\n  default: deepseek/deepseek-v4.1-flash-1017\n  provider: nous\n_config_version: 51\n'),
    ).toEqual({ model: 'deepseek/deepseek-v4.1-flash-1017', provider: 'nous' });
  });

  it('unquotes values and tolerates CRLF plus comments', () => {
    const yaml = 'model:\r\n  # route\r\n  default: "openai/gpt-5.6"\r\n  provider: \'openai\'\r\n';
    expect(parseHermesDefaultRoute(yaml)).toEqual({ model: 'openai/gpt-5.6', provider: 'openai' });
  });

  it('returns an empty route when the block is missing or has no default', () => {
    expect(parseHermesDefaultRoute('agent:\n  model: something\n')).toEqual({});
    expect(parseHermesDefaultRoute('model:\n  provider: nous\n')).toEqual({ provider: 'nous' });
  });

  it('stops at a dedented line so later sections cannot leak in', () => {
    const yaml = 'model:\n  default: a/b\nagent:\n  provider: not-this-one\n  model: other\n';
    expect(parseHermesDefaultRoute(yaml)).toEqual({ model: 'a/b' });
  });
});
