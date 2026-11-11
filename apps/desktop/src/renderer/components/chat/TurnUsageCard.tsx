/**
 * TurnUsageCard — ROADMAP 10.4. One turn's numbers, opened from that turn's usage text.
 *
 * Not hover-only: the trigger is a real button, so Tab reaches it and focus opens the card; Esc
 * closes it (Radix), and hovering is a shortcut rather than the only way in.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { RegionalMoney } from '../../../shared/regionalMoney';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';
import { buildTurnUsageCard } from '@/lib/turnUsageCard';

export interface TurnUsageCardProps {
  details: TurnUsageDetails;
  money?: RegionalMoney | undefined;
  costUsd?: number | undefined;
  isEstimate?: boolean;
  /** What the trigger reads (the same cost/token text the row already shows). */
  label: string;
  className?: string;
}

export function TurnUsageCard({ details, money, costUsd, isEstimate = false, label, className }: TurnUsageCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const model = buildTurnUsageCard({
    details,
    t,
    ...(money ? { money } : {}),
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
    isEstimate,
  });

  const close = useCallback(() => setOpen(false), []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="turn-usage-trigger"
          aria-label={t('chat.turnUsage.openLabel')}
          className={cn(
            'inline-flex h-6 items-center rounded-full border-0 bg-transparent p-0 text-12 font-normal whitespace-nowrap',
            'cursor-pointer text-[var(--settings-section-desc)] transition-colors hover:text-[var(--text-primary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            className,
          )}
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[268px] p-0"
        data-testid="turn-usage-card"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerLeave={close}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-12 font-medium text-[var(--text-primary)]">
              {t('chat.turnUsage.title')}
            </span>
            <span
              data-testid="turn-usage-cost"
              data-cost-kind={model.cost.kind}
              className={cn(
                'text-12 font-medium tabular-nums',
                model.cost.kind === 'unknown'
                  ? 'text-[var(--settings-section-desc)]'
                  : 'text-[var(--text-primary)]',
              )}
            >
              {model.cost.text}
            </span>
          </div>
          <div className="flex flex-col gap-[3px]">
            {model.rows.map((row) => (
              <div key={row.key} className="flex flex-col">
                <div className="flex items-baseline justify-between gap-3 text-12">
                  <span className="min-w-0 truncate text-[var(--settings-section-desc)]">{row.label}</span>
                  <span
                    data-testid={`turn-usage-${row.key}`}
                    className="shrink-0 font-medium tabular-nums text-[var(--text-primary)]"
                  >
                    {row.value}
                  </span>
                </div>
                {row.hint ? (
                  <span className="text-11 leading-tight text-[var(--settings-section-desc)]">
                    {row.hint}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
