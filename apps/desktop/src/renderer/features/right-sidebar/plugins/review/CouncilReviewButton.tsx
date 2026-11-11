/**
 * Toolbar entry point for council review (ROADMAP 11.4). Keeps the dialog state out of
 * ReviewTabBody, which is already large.
 */

import { Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { CouncilReviewDialog } from './CouncilReviewDialog';

export interface CouncilReviewButtonProps {
  sessionId: string;
  /** Review data has at least one text file to send. */
  enabled: boolean;
}

export function CouncilReviewButton({ sessionId, enabled }: CouncilReviewButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!enabled}
        onClick={() => setOpen(true)}
        title={t('councilReview.buttonTooltip')}
        className={cn(
          'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-11',
          'border-[var(--chat-input-border)] text-[var(--text-secondary)]',
          'hover:text-[var(--text-primary)]',
          !enabled && 'opacity-40',
        )}
      >
        <Users size={12} />
        {t('councilReview.button')}
      </button>
      <CouncilReviewDialog open={open} sessionId={sessionId} onOpenChange={setOpen} />
    </>
  );
}
