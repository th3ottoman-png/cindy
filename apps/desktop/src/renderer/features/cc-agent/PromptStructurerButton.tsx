import { useCallback, useEffect, useState, useRef } from 'react';
import type { StructuredPromptResult } from '@cindy/maker-core/prompt-structurer';
import {
  getDraft,
  plainTextToTiptapDoc,
  saveDraft,
  subscribeDraftContent,
  type ComposerDraft,
} from '@/lib/composerDraftStore';
import { composerPlainText } from '@/components/turn-attachments/turnAttachmentDoc';

export interface DraftIo {
  getDraft: (key: string) => ComposerDraft | undefined;
  saveDraft: (key: string, draft: ComposerDraft) => void;
}

const DEFAULT_DRAFT_IO: DraftIo = {
  getDraft,
  saveDraft: (key, draft) => saveDraft(key, draft),
};

export interface PromptStructurerButtonProps {
  draftKey: string;
  disabled?: boolean;
  draftIo?: DraftIo;
  refineApi?: (text: string) => Promise<StructuredPromptResult>;
}

export function PromptStructurerButtonView({
  hasDraft,
  isRefining,
  statusMessage,
  onRefine,
  disabled,
}: {
  hasDraft: boolean;
  isRefining: boolean;
  statusMessage: string | null;
  onRefine: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      data-testid="prompt-structurer-container"
      className="inline-flex items-center gap-1.5"
    >
      <button
        type="button"
        data-testid="prompt-structurer-button"
        title="Refine brain dump into structured prompt (Cmd+Shift+P / Ctrl+Shift+P)"
        disabled={disabled || isRefining || !hasDraft}
        onClick={onRefine}
        className="flex items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-hover)] px-2 py-0.5 text-11 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span aria-hidden="true" className="shrink-0 text-amber-500 font-bold">
          ✨
        </span>
        <span>
          {isRefining ? 'Structuring…' : statusMessage || 'Structure Prompt'}
        </span>
      </button>
    </div>
  );
}

export function PromptStructurerButton({
  draftKey,
  disabled = false,
  draftIo,
  refineApi,
}: PromptStructurerButtonProps) {
  const io = draftIo ?? DEFAULT_DRAFT_IO;
  const [hasDraft, setHasDraft] = useState<boolean>(false);
  const [isRefining, setIsRefining] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<NodeJS.Timeout | null>(null);

  const checkHasDraft = useCallback(() => {
    const d = io.getDraft(draftKey);
    const text = composerPlainText(d?.text).trim();
    setHasDraft(text.length > 0);
  }, [draftKey, io]);

  useEffect(() => {
    checkHasDraft();
    const unsub = subscribeDraftContent(draftKey, () => {
      checkHasDraft();
    });
    return () => {
      unsub();
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [draftKey, checkHasDraft]);

  const refineFn = useCallback(
    async (text: string): Promise<StructuredPromptResult> => {
      if (refineApi) {
        return refineApi(text);
      }
      if (window.electronAPI?.maker?.promptStructurer?.refine) {
        return window.electronAPI.maker.promptStructurer.refine({ text });
      }
      return {
        raw: text,
        structuredMarkdown: text,
        sections: { goal: text, context: '', guardrails: [], doneCriteria: [] },
      };
    },
    [refineApi],
  );

  const handleRefine = useCallback(async () => {
    if (disabled || isRefining) return;
    const existing = io.getDraft(draftKey);
    const currentText = composerPlainText(existing?.text).trim();
    if (!currentText) return;

    setIsRefining(true);
    try {
      const result = await refineFn(currentText);
      if (result && result.structuredMarkdown) {
        io.saveDraft(draftKey, {
          ...existing,
          text: plainTextToTiptapDoc(result.structuredMarkdown),
          attachments: existing?.attachments ?? [],
          browserComments: existing?.browserComments ?? [],
          focusAtEnd: true,
        });
        setStatusMessage('Structured!');
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = setTimeout(() => {
          setStatusMessage(null);
        }, 2500);
      }
    } catch {
      setStatusMessage('Failed');
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => {
        setStatusMessage(null);
      }, 2500);
    } finally {
      setIsRefining(false);
    }
  }, [disabled, draftKey, io, isRefining, refineFn]);

  // Global keyboard shortcut: Cmd+Shift+P (Mac) or Ctrl+Shift+P (Linux/Windows)
  useEffect(() => {
    if (disabled) return undefined;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        e.stopPropagation();
        void handleRefine();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [disabled, handleRefine]);

  return (
    <PromptStructurerButtonView
      hasDraft={hasDraft}
      isRefining={isRefining}
      statusMessage={statusMessage}
      onRefine={handleRefine}
      disabled={disabled}
    />
  );
}
