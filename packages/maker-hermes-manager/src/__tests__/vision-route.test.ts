import { describe, expect, it } from 'vitest';

import { injectVisionRoute, visionBaseUrl, type VisionAuxRoute } from '../vision-route.js';

const LOCAL: VisionAuxRoute = { provider: 'lmstudio-local', model: 'google/gemma-4', baseUrl: 'http://127.0.0.1:1234' };
const API: VisionAuxRoute = { provider: 'api-vision', model: 'vl-max', baseUrl: 'https://api.example.com/v1', keyEnv: 'VISION_API_KEY' };

describe('visionBaseUrl', () => {
  it('appends /v1 when absent and keeps it when present', () => {
    expect(visionBaseUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
    expect(visionBaseUrl('http://127.0.0.1:1234/')).toBe('http://127.0.0.1:1234/v1');
    expect(visionBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });
});

describe('injectVisionRoute', () => {
  it('adds custom_providers and auxiliary.vision to an empty config', () => {
    const out = injectVisionRoute('', LOCAL);
    expect(out).toContain('custom_providers:');
    expect(out).toContain('- name: "lmstudio-local"');
    expect(out).toContain('auxiliary:');
    expect(out).toContain('  vision:');
    expect(out).toContain('    base_url: "http://127.0.0.1:1234/v1"');
    expect(out).not.toContain('key_env');
  });

  it('does not duplicate a provider already registered', () => {
    const base = 'model:\n  default: m\ncustom_providers:\n  - name: lmstudio-local\n    base_url: http://127.0.0.1:1234/v1\n';
    const out = injectVisionRoute(base, LOCAL);
    expect(out.match(/- name: "?lmstudio-local"?/g)).toHaveLength(1);
    expect(out).toContain('auxiliary:');
    expect(out.startsWith('model:\n  default: m\n')).toBe(true);
  });

  it('registers a provider that is not yet in custom_providers', () => {
    const base = 'custom_providers:\n  - name: other\n    base_url: http://x/v1\n';
    const out = injectVisionRoute(base, LOCAL);
    expect(out).toContain('- name: other');
    expect(out).toContain('- name: "lmstudio-local"');
  });

  it('writes key_env for an API route (name only, never a key value)', () => {
    const out = injectVisionRoute('', API);
    expect(out).toContain('    key_env: "VISION_API_KEY"');
    expect(out).toContain('    base_url: "https://api.example.com/v1"');
  });

  it('replaces an existing auxiliary.vision block', () => {
    const base = 'auxiliary:\n  vision:\n    provider: old\n    model: old-model\n    base_url: http://old/v1\nagent:\n  max_turns: 20\n';
    const out = injectVisionRoute(base, LOCAL);
    expect(out).toContain('    model: "google/gemma-4"');
    expect(out).not.toContain('old-model');
    expect(out).toContain('agent:\n  max_turns: 20');
  });

  it('adds vision under an existing auxiliary block that lacks it', () => {
    const base = 'auxiliary:\n  title:\n    provider: p\n';
    const out = injectVisionRoute(base, LOCAL);
    expect(out).toContain('  title:');
    expect(out).toContain('  vision:');
  });

  it('keeps every other byte of the owner config', () => {
    const base = '# a comment\nmodel:\n  default: deepseek-flash\n  provider: deepseek\nagent:\n  max_turns: 20\n';
    const out = injectVisionRoute(base, LOCAL);
    expect(out).toContain('# a comment');
    expect(out).toContain('model:\n  default: deepseek-flash\n  provider: deepseek');
    expect(out).toContain('agent:\n  max_turns: 20');
  });

  it('throws on an inline auxiliary value (fail closed)', () => {
    expect(() => injectVisionRoute('auxiliary: {}\n', LOCAL)).toThrow(/inline auxiliary/);
  });

  it('is idempotent for the same route', () => {
    const once = injectVisionRoute('model:\n  default: m\n', LOCAL);
    const twice = injectVisionRoute(once, LOCAL);
    expect(twice).toBe(once);
  });
});
