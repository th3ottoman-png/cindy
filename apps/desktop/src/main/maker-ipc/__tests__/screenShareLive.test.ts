import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScreenShareHost } from '../screenShare';

describe('screenShare live proof (ROADMAP 7.7)', () => {
  const realHarnessDir = path.join(os.homedir(), '.cindy-harness');
  const realConfigPath = path.join(realHarnessDir, 'screen-share.json');
  let backupContent: string | null = null;

  beforeAll(() => {
    if (fs.existsSync(realConfigPath)) {
      backupContent = fs.readFileSync(realConfigPath, 'utf8');
    }
  });

  afterAll(() => {
    if (backupContent !== null) {
      try {
        fs.writeFileSync(realConfigPath, backupContent, 'utf8');
      } catch {}
    } else if (fs.existsSync(realConfigPath)) {
      try {
        fs.unlinkSync(realConfigPath);
      } catch {}
    }
  });

  it('live persists screen-share privacy configuration to ~/.cindy-harness/screen-share.json', () => {
    const host = new ScreenShareHost({ getHarnessDir: () => realHarnessDir });

    const updated = host.setConfig({ enabled: true, maskStyle: 'bullets' });
    expect(updated.enabled).toBe(true);
    expect(updated.maskStyle).toBe('bullets');

    expect(fs.existsSync(realConfigPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(realConfigPath, 'utf8'));
    expect(content.enabled).toBe(true);
    expect(content.maskStyle).toBe('bullets');

    // Toggle back off
    const toggledOff = host.setConfig({ enabled: false });
    expect(toggledOff.enabled).toBe(false);
    const offContent = JSON.parse(fs.readFileSync(realConfigPath, 'utf8'));
    expect(offContent.enabled).toBe(false);
  });

  it('redacts live credentials and system paths across chat text', () => {
    const host = new ScreenShareHost({ getHarnessDir: () => realHarnessDir });

    const chatTurn = `
      Connected with API token: Bearer eyJhbGciOiJIUzI1NiJ9.test and key: sk-live1234567890abcdef.
      User email: maintainer@cindy.local. Balance: $2,500.00.
      Workspace root: /Users/turko/Documents/cindy or /home/antigravity/cindy.
    `;

    const redacted = host.redact(chatTurn, { maskStyle: 'badge' });

    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted).not.toContain('sk-live1234567890abcdef');
    expect(redacted).not.toContain('maintainer@cindy.local');
    expect(redacted).not.toContain('$2,500.00');
    expect(redacted).not.toContain('/Users/turko/');
    expect(redacted).not.toContain('/home/antigravity/');

    expect(redacted).toContain('Bearer [REDACTED:TOKEN]');
    expect(redacted).toContain('[REDACTED:API_KEY]');
    expect(redacted).toContain('[REDACTED:EMAIL]');
    expect(redacted).toContain('[REDACTED:AMOUNT]');
    expect(redacted).toContain('/Users/[REDACTED:USER]/');
    expect(redacted).toContain('/home/[REDACTED:USER]/');
  });
});
