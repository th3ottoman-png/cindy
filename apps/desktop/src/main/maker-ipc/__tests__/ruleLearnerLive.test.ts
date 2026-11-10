import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuleLearnerHost } from '../ruleLearner';

describe('ruleLearner live proof (ROADMAP 7.5)', () => {
  const realVaultDir = '/home/antigravity/Bishi-memory';
  const realHermesHome = path.join(os.homedir(), '.hermes-cindy');
  let testVaultRulePath = '';
  let soulBackupContent: string | null = null;
  const soulPath = path.join(realHermesHome, 'SOUL.md');

  beforeAll(() => {
    // Ensure hermes home directory exists for test
    if (!fs.existsSync(realHermesHome)) {
      fs.mkdirSync(realHermesHome, { recursive: true });
    }
    if (fs.existsSync(soulPath)) {
      soulBackupContent = fs.readFileSync(soulPath, 'utf8');
    }
  });

  afterAll(() => {
    // Cleanup generated vault test rule
    if (testVaultRulePath && fs.existsSync(testVaultRulePath)) {
      try { fs.unlinkSync(testVaultRulePath); } catch {}
    }
    // Restore SOUL.md to original state
    if (soulBackupContent !== null) {
      try { fs.writeFileSync(soulPath, soulBackupContent, 'utf8'); } catch {}
    } else if (fs.existsSync(soulPath)) {
      try { fs.unlinkSync(soulPath); } catch {}
    }
  });

  it('detects live user corrections and saves to real notes vault', async () => {
    expect(fs.existsSync(realVaultDir)).toBe(true);

    const host = new RuleLearnerHost({
      getVaultDir: () => realVaultDir,
      getHermesHome: () => realHermesHome,
    });

    const userCorrection = 'No, don’t run tests under Node 24. Always use Node 22 exclusively.';
    const detection = host.detectCorrection(userCorrection);

    expect(detection.isCorrection).toBe(true);
    expect(detection.suggestedTitle).toBeTruthy();

    const saveRes = await host.saveRule({
      target: 'vault',
      text: detection.suggestedRuleText,
      title: detection.suggestedTitle,
    });

    expect(saveRes.success).toBe(true);
    expect(saveRes.target).toBe('vault');
    expect(fs.existsSync(saveRes.filePath)).toBe(true);
    testVaultRulePath = saveRes.filePath;

    const onDiskContent = fs.readFileSync(saveRes.filePath, 'utf8');
    expect(onDiskContent).toContain('type: learned-rule');
    expect(onDiskContent).toContain('source: correction');
    expect(onDiskContent).toContain(detection.suggestedRuleText);
  });

  it('saves live learned rule to real ~/.hermes-cindy/SOUL.md', async () => {
    const host = new RuleLearnerHost({
      getVaultDir: () => realVaultDir,
      getHermesHome: () => realHermesHome,
    });

    const saveRes = await host.saveRule({
      target: 'soul',
      text: 'Always quote every repository path with spaces.',
      title: 'Always quote paths',
    });

    expect(saveRes.success).toBe(true);
    expect(saveRes.target).toBe('soul');
    expect(fs.existsSync(soulPath)).toBe(true);

    const soulContent = fs.readFileSync(soulPath, 'utf8');
    expect(soulContent).toContain('## Rules & Corrections');
    expect(soulContent).toContain('Always quote paths');
    expect(soulContent).toContain('Always quote every repository path with spaces.');
  });
});
