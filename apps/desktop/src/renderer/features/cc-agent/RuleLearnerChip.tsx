import { useEffect, useState, useCallback, useRef } from 'react';
import type { CorrectionDetection, SaveRuleResult } from '@cindy/maker-core/rule-learner';
import { makerChatStore } from '@/lib/makerChatStore';

export interface RuleLearnerSnapshot {
  messages: readonly {
    clientId?: string;
    role: string;
    content?: string;
  }[];
}

export interface RuleLearnerChipProps {
  sessionId: string;
  readSnapshot?: (sessionId: string) => RuleLearnerSnapshot;
  detectCorrectionApi?: (text: string) => Promise<CorrectionDetection>;
  saveRuleApi?: (params: { target: 'vault' | 'soul'; text: string; title?: string }) => Promise<SaveRuleResult>;
  pollMs?: number;
}

export function RuleLearnerChipView({
  detection,
  savingTarget,
  statusMessage,
  onSave,
  onDismiss,
}: {
  detection: CorrectionDetection;
  savingTarget: 'vault' | 'soul' | null;
  statusMessage: string | null;
  onSave: (target: 'vault' | 'soul') => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="rule-learner-chip"
      role="status"
      aria-label={`Rule learner suggestion: ${detection.suggestedTitle}`}
      className="mt-1 flex w-full flex-wrap items-center gap-1.5 px-1 text-12 text-[var(--text-secondary)]"
    >
      <span aria-hidden="true" className="shrink-0 text-amber-500 font-bold">
        💡
      </span>
      <span className="truncate font-medium text-[var(--text-primary)]">
        Save rule: "{detection.suggestedTitle}"?
      </span>

      {statusMessage ? (
        <span
          data-testid="rule-learner-status"
          className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-11 font-medium text-emerald-600 dark:text-emerald-400"
        >
          ✓ {statusMessage}
        </span>
      ) : (
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="rule-learner-save-vault"
            disabled={savingTarget !== null}
            onClick={() => onSave('vault')}
            className="rounded border border-[var(--border-default)] bg-[var(--surface-hover)] px-2 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {savingTarget === 'vault' ? 'Saving…' : 'Vault'}
          </button>
          <button
            type="button"
            data-testid="rule-learner-save-soul"
            disabled={savingTarget !== null}
            onClick={() => onSave('soul')}
            className="rounded border border-[var(--border-default)] bg-[var(--surface-hover)] px-2 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {savingTarget === 'soul' ? 'Saving…' : 'SOUL.md'}
          </button>
        </div>
      )}

      <button
        type="button"
        data-testid="rule-learner-dismiss"
        title="Dismiss suggestion"
        onClick={onDismiss}
        className="ml-auto rounded px-1.5 py-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      >
        ✕
      </button>
    </div>
  );
}

export function RuleLearnerChip({
  sessionId,
  readSnapshot = (id) => makerChatStore.getSnapshot(id),
  detectCorrectionApi,
  saveRuleApi,
  pollMs = 1000,
}: RuleLearnerChipProps) {
  const [detection, setDetection] = useState<CorrectionDetection | null>(null);
  const [savingTarget, setSavingTarget] = useState<'vault' | 'soul' | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const lastExaminedRef = useRef<string>('');
  const dismissedRef = useRef<string>('');

  const detectFn = useCallback(
    async (text: string): Promise<CorrectionDetection> => {
      if (detectCorrectionApi) {
        return detectCorrectionApi(text);
      }
      if (window.electronAPI?.maker?.ruleLearner?.detect) {
        return window.electronAPI.maker.ruleLearner.detect({ text });
      }
      return {
        isCorrection: false,
        suggestedRuleText: '',
        suggestedTitle: '',
        slug: '',
      };
    },
    [detectCorrectionApi],
  );

  const saveFn = useCallback(
    async (params: { target: 'vault' | 'soul'; text: string; title?: string }): Promise<SaveRuleResult> => {
      if (saveRuleApi) {
        return saveRuleApi(params);
      }
      if (window.electronAPI?.maker?.ruleLearner?.save) {
        return window.electronAPI.maker.ruleLearner.save(params);
      }
      return {
        success: false,
        filePath: '',
        content: '',
        target: params.target,
        error: 'electronAPI.maker.ruleLearner is unavailable',
      };
    },
    [saveRuleApi],
  );

  useEffect(() => {
    let unmounted = false;

    const check = async () => {
      const snap = readSnapshot(sessionId);
      if (!snap || !snap.messages) return;

      // Find the last user message
      let latestUserMsg = '';
      for (let i = snap.messages.length - 1; i >= 0; i--) {
        const m = snap.messages[i];
        if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
          latestUserMsg = m.content.trim();
          break;
        }
      }

      if (!latestUserMsg || latestUserMsg === lastExaminedRef.current || latestUserMsg === dismissedRef.current) {
        return;
      }

      lastExaminedRef.current = latestUserMsg;
      const res = await detectFn(latestUserMsg);
      if (unmounted) return;

      if (res && res.isCorrection) {
        setDetection(res);
        setStatusMessage(null);
      } else {
        setDetection(null);
      }
    };

    check();
    const interval = setInterval(check, pollMs);
    return () => {
      unmounted = true;
      clearInterval(interval);
    };
  }, [sessionId, readSnapshot, detectFn, pollMs]);

  const handleSave = async (target: 'vault' | 'soul') => {
    if (!detection) return;
    setSavingTarget(target);
    try {
      const res = await saveFn({
        target,
        text: detection.suggestedRuleText,
        title: detection.suggestedTitle,
      });
      if (res.success) {
        setStatusMessage(target === 'vault' ? 'Saved to Vault' : 'Saved to SOUL.md');
        setTimeout(() => {
          setDetection(null);
          dismissedRef.current = lastExaminedRef.current;
        }, 3000);
      } else {
        setStatusMessage(res.error || 'Failed to save');
      }
    } catch (err) {
      setStatusMessage((err as Error).message);
    } finally {
      setSavingTarget(null);
    }
  };

  const handleDismiss = () => {
    dismissedRef.current = lastExaminedRef.current;
    setDetection(null);
  };

  if (!detection) return null;

  return (
    <RuleLearnerChipView
      detection={detection}
      savingTarget={savingTarget}
      statusMessage={statusMessage}
      onSave={handleSave}
      onDismiss={handleDismiss}
    />
  );
}
