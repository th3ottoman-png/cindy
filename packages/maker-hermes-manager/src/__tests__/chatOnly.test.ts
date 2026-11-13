import { describe, expect, it } from 'vitest';

import { buildHermesArgs, type HermesSpawnSpec } from '../hermes-run.js';

const BASE: HermesSpawnSpec = {
  hermesBin: 'hermes',
  hermesHome: '/tmp/home',
  cwd: '/tmp/work',
  text: 'hello',
};

describe('chat-only argv (ROADMAP 10.3)', () => {
  it('runs `--safe-mode` with the explicit route and no toolsets', () => {
    const args = buildHermesArgs({
      ...BASE,
      chatOnly: true,
      model: 'deepseek-flash',
      provider: 'deepseek',
      toolsets: ['terminal', 'web'],
      permissionMode: 'bypassPermissions',
    });
    expect(args).toContain('--safe-mode');
    // `--safe-mode` alone still exposes the shell; the empty toolset list is what removes it.
    expect(args[args.indexOf('-t') + 1]).toBe('');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('deepseek-flash');
    expect(args).toContain('--provider');
    // Permission flags are ignored under safe-mode; sending them would imply they matter.
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--accept-hooks');
  });

  it('refuses to start without a model, because Hermes would', () => {
    expect(() => buildHermesArgs({ ...BASE, chatOnly: true })).toThrow(/explicit model/);
  });

  it('is off by default: the same spec keeps its toolsets and permission flags', () => {
    const args = buildHermesArgs({
      ...BASE,
      model: 'deepseek-flash',
      toolsets: ['terminal'],
      permissionMode: 'bypassPermissions',
    });
    expect(args).not.toContain('--safe-mode');
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('terminal');
    expect(args).toContain('--yolo');
  });
});

describe('safe-mode provider rewrite (ROADMAP §Debt: custom provider under --safe-mode)', () => {
  const customProviderBaseUrls = { 'lmstudio-local': 'http://127.0.0.1:1234/v1' };
  const LOCAL = {
    ...BASE,
    model: 'google/gemma-4-26b-a4b-qat',
    provider: 'lmstudio-local',
    customProviderBaseUrls,
  };

  it('resolves a custom_providers name without the user config safe-mode ignores', () => {
    const args = buildHermesArgs({ ...LOCAL, permissionMode: 'default' });
    expect(args).toContain('--safe-mode');
    expect(args[args.indexOf('--provider') + 1]).toBe('custom');
    expect(args[args.indexOf('--base-url') + 1]).toBe('http://127.0.0.1:1234/v1');
    // The raw name is what makes Hermes exit with `Unknown provider '<name>'`.
    expect(args).not.toContain('lmstudio-local');
  });

  it('rewrites chat-only turns too, since they always run under --safe-mode', () => {
    const args = buildHermesArgs({ ...LOCAL, chatOnly: true, permissionMode: 'bypassPermissions' });
    expect(args).toContain('--safe-mode');
    expect(args[args.indexOf('--provider') + 1]).toBe('custom');
  });

  it('never rewrites a --yolo launch, where the config (and so the name) is read', () => {
    const args = buildHermesArgs({ ...LOCAL, permissionMode: 'auto' });
    expect(args[args.indexOf('--provider') + 1]).toBe('lmstudio-local');
    expect(args).not.toContain('--base-url');
  });

  it('leaves a built-in provider untouched under safe-mode', () => {
    const args = buildHermesArgs({
      ...BASE,
      model: 'deepseek-flash',
      provider: 'deepseek',
      permissionMode: 'default',
      customProviderBaseUrls,
    });
    expect(args[args.indexOf('--provider') + 1]).toBe('deepseek');
    expect(args).not.toContain('--base-url');
  });
});
