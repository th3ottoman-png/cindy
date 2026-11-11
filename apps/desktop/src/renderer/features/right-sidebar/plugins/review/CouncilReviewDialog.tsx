/**
 * Council review dialog (ROADMAP 11.4).
 *
 * Pick one to three models from the live providers.yaml catalogue, send the same neutral diff
 * brief to all of them, and read the consensus checklist. The dialog owns no review logic: the
 * host validates, dispatches, deduplicates and ranks. This file only renders what came back and
 * is explicit when a reviewer failed, so `[2/3 models agreed]` always names a real denominator.
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Check, Copy, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export interface CouncilReviewerOption {
  providerId: string;
  model: string;
  local: boolean;
}

export type CouncilSeverity = 'blocker' | 'major' | 'minor' | 'nit';

export interface CouncilFindingView {
  id: string;
  file: string;
  line: number;
  severity: CouncilSeverity;
  /** Closed defect class; drives consensus, shown as a quiet tag. */
  kind: string;
  title: string;
  detail: string;
  suggestion?: string;
  agreedBy: { providerId: string; model: string }[];
  agreement: number;
  of: number;
}

export interface CouncilOutcomeView {
  reviewer: { providerId: string; model: string };
  status: 'ok' | 'failed';
  reason?: string;
}

export interface CouncilVerdictView {
  findings: CouncilFindingView[];
  outcomes: CouncilOutcomeView[];
  usableReviewers: number;
  failedReviewers: number;
}

export interface CouncilReviewDialogProps {
  open: boolean;
  sessionId: string;
  onOpenChange: (open: boolean) => void;
}

type Phase = 'loading' | 'picking' | 'running' | 'done' | 'error';

const reviewerKey = (r: { providerId: string; model: string }): string => `${r.providerId}::${r.model}`;

const SEVERITY_CLASS: Record<CouncilSeverity, string> = {
  blocker: 'text-[var(--warning-fg)]',
  major: 'text-[var(--warning-fg)]',
  minor: 'text-[var(--text-secondary)]',
  nit: 'text-[var(--text-tertiary)]',
};

export function CouncilReviewDialog({ open, sessionId, onOpenChange }: CouncilReviewDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [options, setOptions] = useState<CouncilReviewerOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [verdict, setVerdict] = useState<CouncilVerdictView | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [persistWarning, setPersistWarning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('loading');
    setErrors([]);
    setVerdict(null);
    setPersistWarning(false);
    void (async () => {
      try {
        const result = await window.electronAPI.gitReview.councilOptions();
        if (cancelled) return;
        setOptions(result.reviewers);
        const remembered = result.selection.map(reviewerKey).filter((key) =>
          result.reviewers.some((r) => reviewerKey(r) === key));
        setSelected(remembered.slice(0, 3));
        setPhase('picking');
      } catch (error) {
        if (cancelled) return;
        setErrors([error instanceof Error ? error.message : String(error)]);
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const grouped = useMemo(() => {
    const map = new Map<string, CouncilReviewerOption[]>();
    for (const option of options) {
      const list = map.get(option.providerId) ?? [];
      list.push(option);
      map.set(option.providerId, list);
    }
    return [...map.entries()];
  }, [options]);

  const toggle = useCallback((key: string) => {
    setSelected((current) => {
      if (current.includes(key)) return current.filter((k) => k !== key);
      if (current.length >= 3) return current;
      return [...current, key];
    });
  }, []);

  const run = useCallback(async () => {
    const reviewers = selected.map((key) => {
      const [providerId, ...rest] = key.split('::');
      return { providerId: providerId ?? '', model: rest.join('::') };
    }).filter((r) => r.providerId && r.model);
    if (reviewers.length === 0) return;
    setPhase('running');
    setErrors([]);
    setVerdict(null);
    try {
      const result = await window.electronAPI.gitReview.councilRun({
        sessionId,
        reviewers,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!result.ok) {
        setErrors(result.errors);
        setPhase('error');
        return;
      }
      setVerdict(result.verdict as CouncilVerdictView);
      setPersistWarning(result.selectionPersisted === false);
      setPhase('done');
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)]);
      setPhase('error');
    }
  }, [note, selected, sessionId]);

  const copySuggestion = useCallback(async (finding: CouncilFindingView) => {
    if (!finding.suggestion) return;
    try {
      await navigator.clipboard.writeText(finding.suggestion);
      setCopiedId(finding.id);
      setTimeout(() => setCopiedId((current) => (current === finding.id ? null : current)), 1_500);
    } catch {
      // Clipboard refusal is not worth an error card.
    }
  }, []);

  const running = phase === 'running';
  const canRun = selected.length > 0 && !running && phase !== 'loading';

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <AlertDialog.Content
          className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[80vh] w-full max-w-[620px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 p-4"
          onEscapeKeyDown={(event) => {
            if (running) event.preventDefault();
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <AlertDialog.Title className="text-13 font-medium text-[var(--text-primary)]">
                {t('councilReview.title')}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-1 text-11 leading-snug text-[var(--text-secondary)]">
                {t('councilReview.subtitle')}
              </AlertDialog.Description>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-md p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              onClick={() => onOpenChange(false)}
              disabled={running}
              aria-label={t('councilReview.close')}
            >
              <X size={14} />
            </button>
          </div>

          {phase === 'loading' && (
            <div className="flex items-center gap-2 py-4 text-11 text-[var(--text-secondary)]">
              <Spinner size={12} spinning />
              {t('councilReview.loading')}
            </div>
          )}

          {phase !== 'loading' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {options.length === 0 ? (
                <p className="py-3 text-11 text-[var(--text-secondary)]">
                  {t('councilReview.noReviewers')}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-11 text-[var(--text-tertiary)]">
                    {t('councilReview.selectedCount', { count: selected.length })}
                  </p>
                  {grouped.map(([providerId, models]) => (
                    <div key={providerId} className="flex flex-col gap-1">
                      <span className="text-10 uppercase tracking-wide text-[var(--text-tertiary)]">
                        {providerId}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {models.map((option) => {
                          const key = reviewerKey(option);
                          const active = selected.includes(key);
                          const capped = !active && selected.length >= 3;
                          return (
                            <button
                              key={key}
                              type="button"
                              disabled={capped || running}
                              onClick={() => toggle(key)}
                              className={cn(
                                'flex items-center gap-1 rounded-md border px-2 py-1 text-11',
                                'border-[var(--chat-input-border)]',
                                active
                                  ? 'bg-[var(--chat-input-bg)] text-[var(--text-primary)]'
                                  : 'text-[var(--text-secondary)]',
                                capped && 'opacity-40',
                              )}
                            >
                              {active && <Check size={11} />}
                              <span className="truncate">{option.model}</span>
                              {option.local && (
                                <span className="text-10 text-[var(--text-tertiary)]">
                                  {t('councilReview.localTag')}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <label className="mt-1 flex flex-col gap-1">
                    <span className="text-11 text-[var(--text-secondary)]">
                      {t('councilReview.noteLabel')}
                    </span>
                    <input
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      disabled={running}
                      placeholder={t('councilReview.notePlaceholder')}
                      className="w-full rounded-md border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] px-2 py-1 text-11 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]"
                    />
                  </label>
                </div>
              )}

              {errors.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {errors.map((message) => (
                    <li key={message} className="flex items-start gap-1 text-11 text-[var(--warning-fg)]">
                      <TriangleAlert size={11} className="mt-0.5 shrink-0" />
                      <span className="break-words">{message}</span>
                    </li>
                  ))}
                </ul>
              )}

              {verdict && (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-11 text-[var(--text-secondary)]">
                    {t('councilReview.summary', {
                      findings: verdict.findings.length,
                      usable: verdict.usableReviewers,
                      total: verdict.usableReviewers + verdict.failedReviewers,
                    })}
                  </p>
                  {verdict.outcomes.filter((o) => o.status === 'failed').map((outcome) => (
                    <p
                      key={reviewerKey(outcome.reviewer)}
                      className="text-10 text-[var(--text-tertiary)]"
                    >
                      {t('councilReview.reviewerFailed', {
                        model: outcome.reviewer.model,
                        reason: outcome.reason ?? 'unknown',
                      })}
                    </p>
                  ))}
                  {persistWarning && (
                    <p className="text-10 text-[var(--text-tertiary)]">
                      {t('councilReview.notRemembered')}
                    </p>
                  )}
                  {verdict.findings.length === 0 ? (
                    <p className="text-11 text-[var(--text-secondary)]">
                      {t('councilReview.noFindings')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {verdict.findings.map((finding) => (
                        <li
                          key={finding.id}
                          className="rounded-md border border-[var(--chat-input-border)] p-2"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('text-10 uppercase tracking-wide', SEVERITY_CLASS[finding.severity])}>
                              {t(`councilReview.severity.${finding.severity}`)}
                            </span>
                            <span className="text-11 font-medium text-[var(--text-primary)]">
                              {finding.title}
                            </span>
                            {finding.kind && finding.kind !== 'other' && (
                              <span className="rounded border border-[var(--chat-input-border)] px-1 text-10 text-[var(--text-tertiary)]">
                                {finding.kind}
                              </span>
                            )}
                            <span className="text-10 text-[var(--text-tertiary)]">
                              {t('councilReview.agreed', {
                                agreement: finding.agreement,
                                of: finding.of,
                              })}
                            </span>
                          </div>
                          <p className="mt-1 text-10 text-[var(--text-tertiary)]">
                            {finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-11 leading-snug text-[var(--text-secondary)]">
                            {finding.detail}
                          </p>
                          {finding.suggestion && (
                            <div className="mt-1 flex items-start gap-2">
                              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--chat-input-bg)] p-1 text-10 text-[var(--text-primary)]">
                                {finding.suggestion}
                              </pre>
                              <button
                                type="button"
                                onClick={() => void copySuggestion(finding)}
                                className="shrink-0 rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                aria-label={t('councilReview.copySuggestion')}
                              >
                                {copiedId === finding.id ? <Check size={12} /> : <Copy size={12} />}
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={running}
              className="rounded-md px-3 py-1 text-11 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              {t('councilReview.close')}
            </button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={!canRun}
              className={cn(
                'rounded-md px-3 py-1 text-11',
                'bg-[var(--chat-input-bg)] text-[var(--text-primary)] border border-[var(--chat-input-border)]',
                !canRun && 'opacity-40',
              )}
            >
              {running ? t('councilReview.running') : t('councilReview.run')}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
