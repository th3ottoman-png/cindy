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

interface MatrixDecisionProps {
  decision: PlanDecision & { criteria: string[] };
  state: 'open' | 'sending' | 'done' | 'error';
  picks: Record<string, string>;
  onPick: (update: (p: Record<string, string>) => Record<string, string>) => void;
}

/**
 * Interrogate 4x4 (11.7b): the decision rendered as a tradeoff table — selectable option rows
 * scored against the criteria columns. Same radiogroup/radio semantics as the card list, so
 * the pick and Proceed paths are identical.
 */
function MatrixDecision({ decision: d, state, picks, onPick }: MatrixDecisionProps) {
  const open = state === 'open';
  return (
    <div className="rounded-xl border border-[var(--warning-accent)] bg-[var(--warning-bg-soft)] p-3">
      <p className="text-sm font-medium text-foreground">{d.question}</p>
      <div className="mt-2 overflow-x-auto" role="radiogroup" aria-label={d.question}>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
                <span className="sr-only">{d.question}</span>
              </th>
              {d.criteria.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="px-2 py-1 text-left font-medium text-muted-foreground"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.options.map((o) => {
              const selected = picks[d.id] === o.id;
              return (
                <tr
                  key={o.id}
                  className={cn(
                    'border-t border-border/40',
                    selected ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <td className="px-0 py-1.5">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!open}
                      onClick={() => onPick((p) => ({ ...p, [d.id]: o.id }))}
                      className={cn(
                        'flex h-full w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors',
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
                  </td>
                  {(o.scores ?? []).map((s, i) => (
                    <td key={`${o.id}:${i}`} className="px-2 py-1.5 align-top">
                      {s}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
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
      {decisions.map((d) => {
        if (d.criteria) {
          return <MatrixDecision key={d.id} decision={{ ...d, criteria: d.criteria }} state={state} picks={picks} onPick={setPicks} />;
        }
        return (
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
        );
      })}
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
