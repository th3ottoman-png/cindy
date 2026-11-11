/**
 * Entry points for council review (ROADMAP 11.4).
 *
 * Two placements, one dialog:
 * - `header`: a chip in the session header, visible the moment a session is open. The Review
 *   panel is where a diff is read, but burying the only entry point there meant the owner could
 *   not find the feature at all.
 * - `toolbar`: a bordered chip in the Review panel toolbar, next to the diff controls.
 */

import { Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { CouncilReviewDialog } from './CouncilReviewDialog';

export interface CouncilReviewButtonProps {
  sessionId: string;
  /**
   * Whether there is a text diff to send. The header chip cannot know without reading the diff,
   * so it passes `true` and lets the host answer honestly with "nothing to review".
   */
  enabled?: boolean;
  variant?: 'header' | 'toolbar';
}

export function CouncilReviewButton({
  sessionId,
  enabled = true,
  variant = 'toolbar',
}: CouncilReviewButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const className = variant === 'header'
    ? cn(
      'inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-11 font-medium transition-colors',
      'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
      !enabled && 'opacity-40',
    )
    : cn(
      'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-11',
      'border-[var(--chat-input-border)] text-[var(--text-secondary)]',
      'hover:text-[var(--text-primary)]',
      !enabled && 'opacity-40',
    );

  return (
    <>
      <button
        type="button"
        data-testid={`council-review-button-${variant}`}
        disabled={!enabled}
        onClick={() => setOpen(true)}
        title={t('councilReview.buttonTooltip')}
        aria-label={t('councilReview.buttonTooltip')}
        className={className}
      >
        <Users size={13} strokeWidth={1.75} className="shrink-0" />
        <span>{t('councilReview.button')}</span>
      </button>
      <CouncilReviewDialog open={open} sessionId={sessionId} onOpenChange={setOpen} />
    </>
  );
}
