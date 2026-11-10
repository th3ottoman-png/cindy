import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuleLearnerHost, registerRuleLearnerHandlers } from '../ruleLearner';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels';

describe('RuleLearnerHost', () => {
  let tmpVault = '';
  let tmpHermes = '';

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-vault-test-'));
    tmpHermes = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-hermes-test-'));
  });

  afterEach(() => {
    if (tmpVault && fs.existsSync(tmpVault)) {
      fs.rmSync(tmpVault, { recursive: true, force: true });
    }
    if (tmpHermes && fs.existsSync(tmpHermes)) {
      fs.rmSync(tmpHermes, { recursive: true, force: true });
    }
  });

  it('detects corrections via detectCorrection', () => {
    const host = new RuleLearnerHost();
    const res = host.detectCorrection("No, don't use yarn. We use pnpm exclusively.");
    expect(res.isCorrection).toBe(true);
    expect(res.suggestedTitle).toBeTruthy();
  });

  it('saves rule to vault and fires pushEvent', async () => {
    const pushed: Array<{ channel: string; payload: unknown }> = [];
    const host = new RuleLearnerHost({
      getVaultDir: () => tmpVault,
      getHermesHome: () => tmpHermes,
      pushEvent: (channel, payload) => pushed.push({ channel, payload }),
    });

    const res = await host.saveRule({
      target: 'vault',
      text: 'Always use pnpm under Node 22.',
      title: 'Always use pnpm',
    });

    expect(res.success).toBe(true);
    expect(res.target).toBe('vault');
    expect(fs.existsSync(res.filePath)).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].channel).toBe(MAKER_PUSH.VAULT_CHANGED);
  });

  it('fails closed when vault is not configured', async () => {
    const host = new RuleLearnerHost({
      getVaultDir: () => null,
      getHermesHome: () => tmpHermes,
    });

    const res = await host.saveRule({
      target: 'vault',
      text: 'Rule without vault',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('No Notes Vault configured');
  });

  it('saves rule to Hermes SOUL.md', async () => {
    const host = new RuleLearnerHost({
      getVaultDir: () => tmpVault,
      getHermesHome: () => tmpHermes,
    });

    const res = await host.saveRule({
      target: 'soul',
      text: 'Never delete upstream files.',
      title: 'Never delete upstream files',
    });

    expect(res.success).toBe(true);
    expect(res.target).toBe('soul');
    const soulPath = path.join(tmpHermes, 'SOUL.md');
    expect(fs.existsSync(soulPath)).toBe(true);
    const text = fs.readFileSync(soulPath, 'utf8');
    expect(text).toContain('## Rules & Corrections');
    expect(text).toContain('Never delete upstream files');
  });

  it('registers IPC handlers and responds to calls', async () => {
    const host = new RuleLearnerHost({
      getVaultDir: () => tmpVault,
      getHermesHome: () => tmpHermes,
    });

    const handlers: Record<string, Function> = {};
    const mockIpc = {
      handle: (channel: string, fn: Function) => {
        handlers[channel] = fn;
      },
    } as any;

    const pushEvent = vi.fn();
    const assertSenderTrusted = vi.fn();

    registerRuleLearnerHandlers(mockIpc, () => host, pushEvent, assertSenderTrusted);

    expect(handlers[MAKER_INVOKE.RULE_LEARNER_DETECT]).toBeTypeOf('function');
    expect(handlers[MAKER_INVOKE.RULE_LEARNER_SAVE]).toBeTypeOf('function');

    const detectResult = await handlers[MAKER_INVOKE.RULE_LEARNER_DETECT](
      { senderFrame: {} },
      { text: "Wrong, that's not how we do it." },
    );
    expect(assertSenderTrusted).toHaveBeenCalled();
    expect(detectResult.isCorrection).toBe(true);

    const saveResult = await handlers[MAKER_INVOKE.RULE_LEARNER_SAVE](
      { senderFrame: {} },
      { target: 'vault', text: 'Always quote paths.', title: 'Always quote paths' },
    );
    expect(saveResult.success).toBe(true);
  });
});
