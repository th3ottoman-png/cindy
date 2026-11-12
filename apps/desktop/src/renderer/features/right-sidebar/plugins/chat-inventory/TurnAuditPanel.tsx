/**
 * "Audit & Assumptions" view of the In This Chat inspector (ROADMAP 11.10).
 *
 * Shows what audited turns reported in their `cindy-audit` footers: overall progress, the
 * decisions made, and the assumptions relied on. Assumptions below 80% confidence (or with no
 * confidence) carry an amber pill. "Verify" prefills the session composer with a check prompt;
 * the owner still decides whether to send it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, RefreshCw, ShieldQuestion } from 'lucide-react';

import { cn } from '@/lib/utils';
import { insertPromptIntoComposer } from '@/lib/composerActionsBus';
import { makerChatStore } from '@/lib/makerChatStore';
import type { TurnAuditSummaryView } from '@/../main/maker-ipc/turnAudit';

type Assumption = TurnAuditSummaryView['audit']['assumptions'][number];

export function verifyPrompt(assumption: Pick<Assumption, 'text' | 'verify'>): string {
  const check = assumption.verify ? ` Suggested check: ${assumption.verify}.` : '';
  return `Verify this assumption before relying on it: "${assumption.text}".${check} Run the check, then tell me whether it holds and what changes if it does not.`;
}

export function TurnAuditPanel({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<TurnAuditSummaryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = window.electronAPI?.maker?.turnAudit;
    if (!sessionId || !api) return;
    try {
      setView(await api.summary({ sessionId }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A finished turn lands in the chat store; re-fold the stored messages then.
  useEffect(() => {
    if (!sessionId) return undefined;
    return makerChatStore.subscribe(sessionId, () => {
      void load();
    });
  }, [sessionId, load]);

  const verify = (assumption: Assumption) => {
    const accepted = insertPromptIntoComposer({
      targetSessionId: sessionId,
      text: verifyPrompt(assumption),
    });
    setNotice(
      accepted
        ? 'Check prompt placed in the composer — review and send.'
        : 'Open this chat to place the check prompt.',
    );
  };

  const audit = view?.audit;
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden text-xs"
      data-testid="turn-audit-panel"
    >
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <span className="flex items-center gap-1.5 font-semibold text-sm">
          <ShieldQuestion className="h-4 w-4 text-primary" />
          Audit & Assumptions
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Refresh audit"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {error && <div className="text-destructive">Failed to load the audit: {error}</div>}
        {view && !view.turnAudit && (
          <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-muted-foreground">
            Turn audit is off for this chat. Turn on the “Audit” chip in the session header; each
            later turn then reports progress, decisions and assumptions here.
          </div>
        )}
        {notice && <div className="text-muted-foreground">{notice}</div>}

        {audit && audit.auditedTurns > 0 && (
          <>
            <div className="rounded-lg border border-border/70 bg-card/60 p-3">
              <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                <span>Completion progress</span>
                <span
                  className="font-mono font-semibold text-foreground"
                  data-testid="turn-audit-progress"
                >
                  {audit.progress === null ? '—' : `${audit.progress}%`}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary/80">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${audit.progress ?? 0}%` }}
                />
              </div>
              <div className="mt-2 text-[10px] text-muted-foreground">
                {audit.auditedTurns} audited turn{audit.auditedTurns === 1 ? '' : 's'} ·{' '}
                {audit.lowConfidenceCount} low-confidence assumption
                {audit.lowConfidenceCount === 1 ? '' : 's'}
              </div>
            </div>

            <section className="space-y-1.5">
              <div className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Assumptions ({audit.assumptions.length})
              </div>
              {audit.assumptions.length === 0 && (
                <div className="px-1 text-muted-foreground">None reported.</div>
              )}
              {audit.assumptions.map((assumption, index) => (
                <div
                  key={`${assumption.turn}-${index}`}
                  className={cn(
                    'rounded-md border p-2',
                    assumption.low
                      ? 'border-[var(--warning-accent)] bg-[var(--warning-bg-soft)]'
                      : 'border-border/60',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-foreground">{assumption.text}</span>
                    {assumption.low ? (
                      <span
                        data-testid="assumption-low-pill"
                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--warning-accent)] px-1.5 py-0.5 text-[10px] font-medium text-foreground"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        Confidence:{' '}
                        {assumption.confidence === null ? 'unknown' : `${assumption.confidence}%`}
                      </span>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                        <CheckCircle2 className="h-3 w-3" />
                        {assumption.confidence}%
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span className="truncate">
                      Turn {assumption.turn}
                      {assumption.verify ? ` · check: ${assumption.verify}` : ''}
                    </span>
                    <button
                      type="button"
                      aria-label={`Verify: ${assumption.text}`}
                      onClick={() => verify(assumption)}
                      className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-foreground hover:bg-muted"
                    >
                      Verify
                    </button>
                  </div>
                </div>
              ))}
            </section>

            <section className="space-y-1.5">
              <div className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Decisions ({audit.decisions.length})
              </div>
              {audit.decisions.length === 0 && (
                <div className="px-1 text-muted-foreground">None reported.</div>
              )}
              {audit.decisions.map((decision, index) => (
                <div
                  key={`${decision.turn}-${index}`}
                  className="flex items-start gap-1.5 rounded-md border border-border/60 p-2"
                >
                  <GitBranch className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
                  <div>
                    <div className="text-foreground">{decision.text}</div>
                    <div className="text-[10px] text-muted-foreground">
                      Turn {decision.turn}
                      {decision.why ? ` · ${decision.why}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
        {view?.turnAudit && audit && audit.auditedTurns === 0 && (
          <div className="text-muted-foreground">
            No audited turns yet. The next reply will report here.
          </div>
        )}
      </div>
    </div>
  );
}
