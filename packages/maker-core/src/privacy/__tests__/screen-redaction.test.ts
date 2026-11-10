import { describe, it, expect } from 'vitest';
import {
  findRedactionSpans,
  redactSensitiveText,
  getScreenShareRedactionCss,
} from '../screen-redaction';

describe('screen-redaction (ROADMAP 7.7)', () => {
  it('detects and redacts API keys and tokens', () => {
    const text = 'Here is the key: sk-abcdef1234567890abcdef and token: Bearer eyJhbGciOiJIUzI1NiJ9';
    const spans = findRedactionSpans(text);

    expect(spans.length).toBe(2);
    expect(spans[0].category).toBe('api-key');
    expect(spans[1].category).toBe('token');

    const redacted = redactSensitiveText(text);
    expect(redacted).toContain('[REDACTED:API_KEY]');
    expect(redacted).toContain('Bearer [REDACTED:TOKEN]');
    expect(redacted).not.toContain('sk-abcdef');
  });

  it('detects and redacts passwords and secrets', () => {
    const text = 'Database config: password="super-secret-password-123", secret_key = "abc123456789"';
    const redacted = redactSensitiveText(text);

    expect(redacted).toContain('password: [REDACTED:PASSWORD]');
    expect(redacted).toContain('secret_key: [REDACTED:KEY]');
    expect(redacted).not.toContain('super-secret-password-123');
  });

  it('detects and redacts email addresses', () => {
    const text = 'Contact lead engineer at alice.developer@example.com for project access.';
    const redacted = redactSensitiveText(text);

    expect(redacted).toContain('[REDACTED:EMAIL]');
    expect(redacted).not.toContain('alice.developer@example.com');
  });

  it('detects and redacts financial amounts', () => {
    const text = 'Current task balance: $1,450.50 (estimated cost 35.00 USD).';
    const redacted = redactSensitiveText(text);

    expect(redacted).toContain('[REDACTED:AMOUNT]');
    expect(redacted).not.toContain('$1,450.50');
    expect(redacted).not.toContain('35.00 USD');
  });

  it('masks system user directory paths', () => {
    const text = 'Checking log file at /Users/john_doe/Library/Logs/cindy.log or /home/antigravity/cindy.log';
    const redacted = redactSensitiveText(text);

    expect(redacted).toContain('/Users/[REDACTED:USER]/Library/Logs/cindy.log');
    expect(redacted).toContain('/home/[REDACTED:USER]/cindy.log');
    expect(redacted).not.toContain('john_doe');
    expect(redacted).not.toContain('antigravity');
  });

  it('supports bullet masking mode', () => {
    const text = 'Key sk-abcdef1234567890';
    const redacted = redactSensitiveText(text, { maskStyle: 'bullets' });

    expect(redacted).toContain('Key ••••••••');
    expect(redacted).not.toContain('sk-abcdef');
  });

  it('generates valid CSS rules for screen-share privacy active mode', () => {
    const css = getScreenShareRedactionCss();
    expect(css).toContain('body.screen-share-privacy-active');
    expect(css).toContain('filter: blur(5px)');
    expect(css).toContain('user-select: none');
  });
});
