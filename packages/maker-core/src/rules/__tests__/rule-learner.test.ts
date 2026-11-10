import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectCorrection,
  deriveRuleTitle,
  slugifyRule,
  formatVaultRuleMarkdown,
  saveRuleToVault,
  saveRuleToSoul,
} from '../rule-learner.js';

describe('rule-learner', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-learner-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('detectCorrection', () => {
    it('detects negative imperatives ("no, don\'t / never / stop ...")', () => {
      const res1 = detectCorrection("No, don't touch package-lock.json. We use pnpm lockfile.");
      expect(res1.isCorrection).toBe(true);
      expect(res1.matchedPattern).toBe('negative_imperative');
      expect(res1.suggestedTitle).toBeTruthy();
      expect(res1.slug).toBeTruthy();

      const res2 = detectCorrection('Never stage .serena or .kimi-code folders.');
      expect(res2.isCorrection).toBe(true);
      expect(res2.matchedPattern).toBe('negative_imperative');

      const res3 = detectCorrection('Stop modifying the upstream files.');
      expect(res3.isCorrection).toBe(true);
      expect(res3.matchedPattern).toBe('negative_imperative');
    });

    it('detects explicit wrong declarations ("that\'s wrong / incorrect ...")', () => {
      const res1 = detectCorrection("That's wrong! We run Node 22, not Node 24.");
      expect(res1.isCorrection).toBe(true);
      expect(res1.matchedPattern).toBe('explicit_wrong');

      const res2 = detectCorrection('Wrong, the vault path is ~/.cindy-harness/vault.json');
      expect(res2.isCorrection).toBe(true);
      expect(res2.matchedPattern).toBe('explicit_wrong');
    });

    it('detects preference statements ("use X instead / prefer X ...")', () => {
      const res = detectCorrection('Always use vitest instead of jest for all unit tests.');
      expect(res.isCorrection).toBe(true);
      expect(res.matchedPattern).toBe('preference_instead');
      expect(res.suggestedRuleText).toContain('Always use vitest');
    });

    it('detects explicit rule prompts ("from now on, always ... / remember: ...")', () => {
      const res1 = detectCorrection('From now on, always sign your commits with git commit -s.');
      expect(res1.isCorrection).toBe(true);
      expect(res1.matchedPattern).toBe('explicit_rule_prompt');

      const res2 = detectCorrection('Remember: never read or write ~/.hermes directly.');
      expect(res2.isCorrection).toBe(true);
      expect(res2.matchedPattern).toBe('explicit_rule_prompt');
    });

    it('detects boundary enforcement ("you must not / you should not ...")', () => {
      const res = detectCorrection('You must not delete any upstream documentation.');
      expect(res.isCorrection).toBe(true);
      expect(res.matchedPattern).toBe('boundary_enforcement');
    });

    it('ignores neutral chat text', () => {
      expect(detectCorrection('Can you explain how the vault index works?').isCorrection).toBe(false);
      expect(detectCorrection('Here is the latest status of the build.').isCorrection).toBe(false);
      expect(detectCorrection('').isCorrection).toBe(false);
      expect(detectCorrection('ok').isCorrection).toBe(false);
    });
  });

  describe('slugifyRule and deriveRuleTitle', () => {
    it('produces clean titles and slugs', () => {
      const title = deriveRuleTitle('always run pnpm typecheck before commit');
      expect(title).toBe('Always run pnpm typecheck before commit');
      const slug = slugifyRule(title);
      expect(slug).toBe('always-run-pnpm-typecheck-before-commit');
    });
  });

  describe('formatVaultRuleMarkdown', () => {
    it('formats valid markdown with YAML frontmatter', () => {
      const md = formatVaultRuleMarkdown({
        text: 'Never use yarn in this repo.',
        title: 'Never use yarn',
        learnedAt: '2026-11-10T12:00:00.000Z',
      });
      expect(md).toContain('title: "Never use yarn"');
      expect(md).toContain('type: learned-rule');
      expect(md).toContain('source: correction');
      expect(md).toContain('# Never use yarn');
      expect(md).toContain('Never use yarn in this repo.');
    });
  });

  describe('saveRuleToVault', () => {
    it('saves rule to <vault>/Cindy/Rules/<slug>.md atomically', async () => {
      const res = await saveRuleToVault(tmpDir, {
        text: 'Always use Node 22 for all tests and builds.',
        title: 'Always use Node 22',
        learnedAt: '2026-11-10T09:00:00.000Z',
      });

      expect(res.success).toBe(true);
      expect(res.target).toBe('vault');
      expect(fs.existsSync(res.filePath)).toBe(true);
      expect(res.filePath).toBe(path.join(tmpDir, 'Cindy', 'Rules', 'always-use-node-22.md'));

      const fileContent = fs.readFileSync(res.filePath, 'utf8');
      expect(fileContent).toContain('title: "Always use Node 22"');
      expect(fileContent).toContain('Always use Node 22 for all tests and builds.');
    });

    it('fails closed when vault directory does not exist', async () => {
      const res = await saveRuleToVault(path.join(tmpDir, 'nonexistent-vault'), {
        text: 'Some rule',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('does not exist');
    });
  });

  describe('saveRuleToSoul', () => {
    it('creates SOUL.md with ## Rules & Corrections if missing', async () => {
      const res = await saveRuleToSoul(tmpDir, {
        text: 'Never delete upstream files.',
        title: 'Never delete upstream files',
        learnedAt: '2026-11-10T09:00:00.000Z',
      });

      expect(res.success).toBe(true);
      expect(res.target).toBe('soul');
      const soulPath = path.join(tmpDir, 'SOUL.md');
      expect(fs.existsSync(soulPath)).toBe(true);
      const content = fs.readFileSync(soulPath, 'utf8');
      expect(content).toContain('## Rules & Corrections');
      expect(content).toContain('- **Never delete upstream files** (2026-11-10): Never delete upstream files.');
    });

    it('appends to existing ## Rules & Corrections section', async () => {
      const soulPath = path.join(tmpDir, 'SOUL.md');
      fs.writeFileSync(
        soulPath,
        '# SOUL\n\nDirectives here.\n\n## Rules & Corrections\n\n- Existing rule\n\n## Next Section\n\nEnd.',
        'utf8',
      );

      const res = await saveRuleToSoul(tmpDir, {
        text: 'Always quote paths with spaces.',
        title: 'Always quote paths',
        learnedAt: '2026-11-10T09:00:00.000Z',
      });

      expect(res.success).toBe(true);
      const content = fs.readFileSync(soulPath, 'utf8');
      expect(content).toContain('- Existing rule');
      expect(content).toContain('- **Always quote paths** (2026-11-10): Always quote paths with spaces.');
      expect(content).toContain('## Next Section');
    });

    it('fails closed when hermes home dir does not exist', async () => {
      const res = await saveRuleToSoul(path.join(tmpDir, 'nonexistent-hermes'), {
        text: 'Rule',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('does not exist');
    });
  });
});
