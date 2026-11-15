/**
 * Redaction unit tests — one test per pattern required by blueprint §9 & §11 (14.1).
 */

import { describe, expect, it } from 'vitest';

import { redactConfig, redactText } from '../redact.js';

describe('redactText (ROADMAP 14.1)', () => {
  it('redacts Bearer tokens', () => {
    const out = redactText('Authorization: Bearer super_secret_bearer_token_12345');
    expect(out).not.toContain('super_secret_bearer_token_12345');
    expect(out).toContain('Bearer «redacted»');
  });

  it('redacts sk-... API keys', () => {
    const out = redactText('failed with key sk-proj-AbCdEf1234567890GhIjKl');
    expect(out).not.toContain('sk-proj-AbCdEf1234567890GhIjKl');
    expect(out).toContain('«redacted»');
  });

  it('redacts ghp_... GitHub tokens', () => {
    const out = redactText('git token ghp_1234567890abcdefghijKLMN');
    expect(out).not.toContain('ghp_1234567890abcdefghijKLMN');
    expect(out).toContain('«redacted»');
  });

  it('redacts JWT-shaped strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactText(`session header ${jwt} expired`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('«redacted»');
  });

  it('redacts email addresses', () => {
    const out = redactText('signed in as owner.name+tag@example.com on host');
    expect(out).not.toContain('owner.name+tag@example.com');
    expect(out).toContain('«redacted»');
  });

  it('strips URL userinfo while keeping scheme, host and path', () => {
    const out = redactText('proxy=https://alice:hunter2@proxy.internal:8443/v1/models');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('https://proxy.internal:8443/v1/models');
  });

  it('strips URL query strings while keeping the endpoint path', () => {
    const out = redactText('GET https://api.example.com/v1/models?api_key=secret99&limit=10');
    expect(out).not.toContain('secret99');
    expect(out).not.toContain('api_key=');
    expect(out).toContain('https://api.example.com/v1/models');
  });

  it('replaces the home directory path with ~', () => {
    const out = redactText(
      'reading /Users/turko/.hermes-cindy/config.yaml and /Users/turko/.cindy-harness/routing.yaml',
      { homeDir: '/Users/turko' },
    );
    expect(out).not.toContain('/Users/turko');
    expect(out).toBe('reading ~/.hermes-cindy/config.yaml and ~/.cindy-harness/routing.yaml');
  });

  it('preserves benign diagnostic text untouched', () => {
    const benign = 'Hermes 0.23.0 installed, pin is 0.22.7 at http://127.0.0.1:1234/v1';
    expect(redactText(benign, { homeDir: '/Users/turko' })).toBe(benign);
  });
});

describe('redactConfig (ROADMAP 14.1)', () => {
  it('redacts object values for every key matching /key|token|secret|password|auth|bearer|cookie/i', () => {
    const input = {
      apiKey: 'val-1',
      accessToken: 'val-2',
      clientSecret: 'val-3',
      password: 'val-4',
      authHeader: 'val-5',
      bearer: 'val-6',
      sessionCookie: 'val-7',
      model: 'qwen3-8b',
      baseUrl: 'https://user:pass@api.example.com/v1?secret=yes',
      configPath: '/Users/turko/.cindy-harness/providers.yaml',
    };

    const redacted = redactConfig(input, { homeDir: '/Users/turko' });

    expect(redacted).toEqual({
      apiKey: '«redacted»',
      accessToken: '«redacted»',
      clientSecret: '«redacted»',
      password: '«redacted»',
      authHeader: '«redacted»',
      bearer: '«redacted»',
      sessionCookie: '«redacted»',
      model: 'qwen3-8b',
      baseUrl: 'https://api.example.com/v1',
      configPath: '~/.cindy-harness/providers.yaml',
    });
  });

  it('redacts YAML/text config strings while keeping structure and comments', () => {
    const yaml = [
      '# Providers config',
      'providers:',
      '  - id: lmstudio-local',
      '    base_url: https://admin:pw123@localhost:1234/v1?token=abc',
      '    api_key: sk-live-secretvalue123456',
      '    path: /Users/turko/.hermes-cindy/config.yaml',
    ].join('\n');

    const redacted = redactConfig(yaml, { homeDir: '/Users/turko' });

    expect(redacted).toContain('# Providers config');
    expect(redacted).not.toContain('pw123');
    expect(redacted).not.toContain('token=abc');
    expect(redacted).not.toContain('sk-live-secretvalue123456');
    expect(redacted).not.toContain('/Users/turko');
    expect(redacted).toContain('base_url: https://localhost:1234/v1');
    expect(redacted).toContain('api_key: «redacted»');
    expect(redacted).toContain('path: ~/.hermes-cindy/config.yaml');
  });

  it('redacts nested YAML secret blocks, quoted keys, and dotenv lines', () => {
    const nested = [
      'oauth_tokens:',
      '  access: super-secret-nested-access',
      '  refresh: super-secret-nested-refresh',
      '  nested:',
      '    id: nested-child-value',
      '"api_key": "quoted-key-secret-value"',
      'CUSTOM_TOKEN=raw-dotenv-token-value',
      'safe_setting: keep-this-value',
    ].join('\n');

    const redacted = redactConfig(nested);

    expect(redacted).not.toContain('super-secret-nested-access');
    expect(redacted).not.toContain('super-secret-nested-refresh');
    expect(redacted).not.toContain('nested-child-value');
    expect(redacted).not.toContain('quoted-key-secret-value');
    expect(redacted).not.toContain('raw-dotenv-token-value');
    expect(redacted).toContain('safe_setting: keep-this-value');
    expect(redacted).toContain('CUSTOM_TOKEN=«redacted»');
  });
});
