import { useState, useCallback } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import {
  patchDraft,
  patchVendorPrefs,
  resetDraftWorkspaceTargets,
  switchVendor,
} from '@/state/newMakerDraft';
import type { ExecuteHandoffResponse } from '@/../main/maker-ipc/sessionHandoff';

export interface SessionHandoffButtonProps {
  sessionId: string;
  disabled?: boolean;
  onHandoffTriggered?: () => void;
  executeHandoffApi?: (params: { sessionId: string }) => Promise<ExecuteHandoffResponse>;
  className?: string;
}

export function prefillSessionHandoffDraft(
  prompt: string,
  options?: { workingDir?: string; model?: string },
): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(prompt),
    attachments: [],
    focusAtEnd: true,
  });
  resetDraftWorkspaceTargets();
  if (options?.workingDir) {
    patchDraft({ workingDir: options.workingDir });
  }
  switchVendor('hermes');
  if (options?.model?.trim()) {
    patchVendorPrefs('hermes', { model: options.model.trim() });
  }
}

export function SessionHandoffButtonView({
  isCompacting,
  statusMessage,
  disabled,
  onClick,
  className,
}: {
  isCompacting: boolean;
  statusMessage: string | null;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid="session-handoff-button"
      title="Compact accumulated context and handoff to clean fresh session (/handoff)"
      disabled={disabled || isCompacting}
      onClick={onClick}
      className={
        className ??
        'inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--surface-hover)] px-2 py-0.5 text-11 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed'
      }
    >
      <ArrowRightLeft size={12} className="shrink-0 text-cyan-500" />
      <span>{isCompacting ? 'Compacting…' : statusMessage || 'Clean Handoff'}</span>
    </button>
  );
}

export function SessionHandoffButton({
  sessionId,
  disabled = false,
  onHandoffTriggered,
  executeHandoffApi,
  className,
}: SessionHandoffButtonProps) {
  const [isCompacting, setIsCompacting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const executeApi = useCallback(
    async (params: { sessionId: string }): Promise<ExecuteHandoffResponse> => {
      if (executeHandoffApi) {
        return executeHandoffApi(params);
      }
      if (window.electronAPI?.maker?.sessionHandoff?.execute) {
        return window.electronAPI.maker.sessionHandoff.execute(params);
      }
      return {
        ok: false,
        prompt: '',
        title: '',
        error: 'sessionHandoff API unavailable',
      };
    },
    [executeHandoffApi],
  );

  const handleHandoff = useCallback(async () => {
    if (disabled || isCompacting || !sessionId) return;

    setIsCompacting(true);
    setStatusMessage('Compacting…');

    try {
      const res = await executeApi({ sessionId });
      if (res.ok && res.prompt) {
        prefillSessionHandoffDraft(res.prompt, {
          workingDir: res.workingDir,
          model: res.model,
        });

        setStatusMessage('✓ Handoff Ready!');
        onHandoffTriggered?.();

        // Optional route transition to new draft
        if (typeof window !== 'undefined' && window.location.hash) {
          window.location.hash = '#/cc-agent/new';
        }

        setTimeout(() => {
          setStatusMessage(null);
        }, 3000);
      } else {
        setStatusMessage(res.error || 'Failed');
        setTimeout(() => {
          setStatusMessage(null);
        }, 3000);
      }
    } catch (err) {
      setStatusMessage((err as Error).message);
      setTimeout(() => {
        setStatusMessage(null);
      }, 3000);
    } finally {
      setIsCompacting(false);
    }
  }, [disabled, executeApi, isCompacting, onHandoffTriggered, sessionId]);

  return (
    <SessionHandoffButtonView
      isCompacting={isCompacting}
      statusMessage={statusMessage}
      disabled={disabled}
      onClick={handleHandoff}
      className={className}
    />
  );
}
