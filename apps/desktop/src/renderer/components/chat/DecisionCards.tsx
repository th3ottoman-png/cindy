/**
 * DecisionCards — interactive Plan First cards (ROADMAP 11.7).
 *
 * Renders the `cindy-decisions` blocks the model returns while a session's Plan First lock is
 * on: one card per decision, radio options with one-line details, and a single
 * "Proceed to Build" button. Proceeding calls `planFirst.decide` (unlock from the next turn)
 * and sends the owner's selections back into the session as a normal user message, so the
 * choices are in the transcript the build turns read.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PlanDecision } from '@/lib/decisionCards';
import { useSessionQuickSend } from './SessionQuickSendContext';

interface DecisionCardsProps {
  sessionId: string;
  decisions: PlanDecision[];
}

function summaryFor(decisions: PlanDecision[], picks: Record<string, string>): string {
  const lines = decisions.map((d) => {
    const opt = d.options.find((o) => o.id === picks[d.id]) ?? d.options[0];
    return `- ${d.question} → ${opt?.label ?? picks[d.id] ?? '(skipped)'}`;
  });
  return ['Plan decisions:', ...lines, 'Proceed to build.'].join('\n');
}

export function DecisionCards({ sessionId, decisions }: DecisionCardsProps) {
  const { t } = useTranslation();
  // Message-level controls send through the session's own path (same as
  // BotStarterOptions/RichAnswer): the view's handleSend already carries the
  // session's model/effort/permissionMode. Null outside the session view.
  const quickSend = useSessionQuickSend();
  const [picks, setPicks] = useState<Record<string, string>>(() =>
    Object.fromEntries(decisions.map((d) => [d.id, d.defaultOptionId ?? d.options[0]?.id ?? ''])),
  );
  const [state, setState] = useState<'open' | 'sending' | 'done' | 'error'>('open');

  const complete = useMemo(
    () => decisions.every((d) => picks[d.id] && d.options.some((o) => o.id === picks[d.id])),
    [decisions, picks],
  );
  const canProceed = complete && state === 'open';

  const proceed = async () => {
    if (state === 'sending' || state === 'done' || !complete || !quickSend) return;
    setState('sending');
    try {
      const list = decisions.map((d) => {
        const opt = d.options.find((o) => o.id === picks[d.id]);
        return {
          decisionId: d.id,
          optionId: picks[d.id] ?? '',
          summary: `${d.question} → ${opt?.label ?? ''}`.slice(0, 300),
        };
      });
      await window.electronAPI.maker.planFirst.decide({ sessionId, decisions: list });
      // literalText: option labels come from the model and must never run as
      // slash commands. False (or no send path) keeps the cards up.
      const sent = quickSend
        ? await quickSend.send(summaryFor(decisions, picks), { literalText: true })
        : false;
      setState(sent ? 'done' : 'error');
    } catch {
      setState('error');
    }
  };

  // No send path outside the session view: render nothing rather than a
  // dead Proceed button (the fence is still stripped from display text).
  if (!quickSend) return null;

  if (state === 'done') {
    return (
      <div
        data-testid="decision-cards-decided"
        className="rounded-xl border border-border/40 bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
      >
        {t('chat.planFirst.decided')}
      </div>
    );
  }

  return (
    <div data-testid="decision-cards" className="flex w-full max-w-[914px] flex-col gap-2">
      {decisions.map((d) => (
        <div
          key={d.id}
          className="rounded-xl border border-[var(--warning-accent)] bg-[var(--warning-bg-soft)] p-3"
        >
          <p className="text-sm font-medium text-foreground">{d.question}</p>
          <div className="mt-2 flex flex-col gap-1.5" role="radiogroup" aria-label={d.question}>
            {d.options.map((o) => {
              const selected = picks[d.id] === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={state !== 'open'}
                  onClick={() => setPicks((p) => ({ ...p, [d.id]: o.id }))}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors',
                    selected
                      ? 'border-[var(--warning-accent)] bg-muted/60 text-foreground'
                      : 'border-border/40 bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span aria-hidden className="mt-0.5 text-sm font-medium leading-none">
                    {selected ? '◉' : '○'}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{o.label}</span>
                    {o.detail && <span className="block text-muted-foreground">{o.detail}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => void proceed()}
          disabled={!canProceed}
          data-testid="decision-cards-proceed"
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            canProceed
              ? 'border-[var(--warning-accent)] bg-[var(--warning-bg-soft)] text-foreground'
              : 'cursor-not-allowed border-border/40 bg-muted/40 text-muted-foreground',
          )}
        >
          {state === 'sending'
            ? t('chat.planFirst.sending')
            : t('chat.planFirst.proceed')}
        </button>
        {state === 'error' && (
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {t('chat.planFirst.failed')}
          </p>
        )}
      </div>
    </div>
  );
}
