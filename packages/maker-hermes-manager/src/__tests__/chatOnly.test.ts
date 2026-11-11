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
