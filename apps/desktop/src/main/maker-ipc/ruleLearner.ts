import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcMain } from 'electron';
import {
  detectCorrection,
  saveRuleToVault,
  saveRuleToSoul,
  type CorrectionDetection,
  type SaveRuleResult,
  type RuleDraft,
} from '@cindy/maker-core/rule-learner';
import { MAKER_INVOKE, MAKER_PUSH } from './channels';

export interface RuleLearnerHostDeps {
  getVaultDir?: () => string | null;
  getHermesHome?: () => string;
  pushEvent?: (channel: string, payload: unknown) => void;
}

export class RuleLearnerHost {
  private getVaultDirFn: () => string | null;
  private getHermesHomeFn: () => string;
  private pushEventFn?: (channel: string, payload: unknown) => void;

  constructor(deps: RuleLearnerHostDeps = {}) {
    this.getVaultDirFn = deps.getVaultDir || (() => {
      try {
        const vaultCfgPath = path.join(os.homedir(), '.cindy-harness', 'vault.json');
        if (fs.existsSync(vaultCfgPath)) {
          const raw = JSON.parse(fs.readFileSync(vaultCfgPath, 'utf8'));
          return typeof raw?.vaultDir === 'string' && raw.vaultDir ? raw.vaultDir : null;
        }
      } catch {}
      return null;
    });

    this.getHermesHomeFn = deps.getHermesHome || (() => {
      return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes-cindy');
    });

    this.pushEventFn = deps.pushEvent;
  }

  detectCorrection(text: string): CorrectionDetection {
    return detectCorrection(text);
  }

  async saveRule(params: {
    target: 'vault' | 'soul';
    text: string;
    title?: string;
  }): Promise<SaveRuleResult> {
    const { target, text, title } = params;
    const rule: RuleDraft = { text, title };

    if (target === 'vault') {
      const vaultDir = this.getVaultDirFn();
      if (!vaultDir) {
        return {
          success: false,
          filePath: '',
          content: '',
          target: 'vault',
          error: 'No Notes Vault configured. Set vault folder in Settings → Notes Vault.',
        };
      }
      const res = await saveRuleToVault(vaultDir, rule);
      if (res.success && this.pushEventFn) {
        this.pushEventFn(MAKER_PUSH.VAULT_CHANGED, { reason: 'rule-learned' });
      }
      return res;
    } else {
      const hermesHome = this.getHermesHomeFn();
      return await saveRuleToSoul(hermesHome, rule);
    }
  }
}

let singletonHost: RuleLearnerHost | null = null;

export function getRuleLearnerHost(deps?: RuleLearnerHostDeps): RuleLearnerHost {
  if (!singletonHost || deps) {
    singletonHost = new RuleLearnerHost(deps);
  }
  return singletonHost;
}

export function registerRuleLearnerHandlers(
  ipc: IpcMain,
  getHost: () => RuleLearnerHost,
  pushEvent: (channel: string, payload: unknown) => void,
  assertSenderTrusted?: (event: { senderFrame?: unknown }) => void,
): void {
  ipc.handle(
    MAKER_INVOKE.RULE_LEARNER_DETECT,
    async (event, params: { text: string }) => {
      assertSenderTrusted?.(event);
      const host = getHost();
      return host.detectCorrection(params?.text || '');
    },
  );

  ipc.handle(
    MAKER_INVOKE.RULE_LEARNER_SAVE,
    async (event, params: { target: 'vault' | 'soul'; text: string; title?: string }) => {
      assertSenderTrusted?.(event);
      const host = getHost();
      return host.saveRule(params);
    },
  );
}
