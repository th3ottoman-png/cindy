import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  RefreshCw,
  Stethoscope,
  Terminal,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  applyDoctorFix,
  listDoctorSnapshots,
  previewDoctorFix,
  refreshDoctorState,
  runDoctorChecks,
  setDoctorRunOnStart,
  takeDoctorSnapshot,
  useDoctorStatus,
} from '@/state/doctorStatusStore';
import {
  DOCTOR_LAYERS,
  DOCTOR_LAYER_LABELS,
  formatDoctorReportMarkdown,
  type CheckResult,
  type DoctorLayer,
  type FixOutcome,
  type FixPlan,
  type LkgSnapshotRecord,
  type Severity,
} from '../../../shared/doctor';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  fail: 0,
  warn: 1,
  ok: 2,
  skip: 3,
};

const SEVERITY_BADGE_CLASS: Readonly<Record<Severity, string>> = {
  fail: 'bg-[var(--card-status-error)]/15 text-[var(--card-status-error)] border-[var(--card-status-error)]/30',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  ok: 'bg-[var(--card-status-done)]/15 text-[var(--card-status-done)] border-[var(--card-status-done)]/30',
  skip: 'bg-[var(--bg-elevated)] text-[var(--text-tertiary)] border-[var(--border-subtle)]',
};

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  fail: 'FAIL',
  warn: 'WARN',
  ok: 'OK',
  skip: 'SKIP',
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (copied) return true;
    }
  } catch {
    // Clipboard unavailable
  }
  return false;
}

export function DoctorSection() {
  const { report, running, runOnStart, lastStartupSnapshotAt, fixesMeta, error } = useDoctorStatus();

  const [togglingStartup, setTogglingStartup] = useState(false);
  const [expandedLayers, setExpandedLayers] = useState<Partial<Record<DoctorLayer, boolean>>>({});
  const lastReportKeyRef = useRef<string | null>(null);

  const [copiedReport, setCopiedReport] = useState(false);
  const [copiedCliKey, setCopiedCliKey] = useState<string | null>(null);

  const [previewLoadingFixId, setPreviewLoadingFixId] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<FixPlan | null>(null);
  const [applyingFix, setApplyingFix] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<{
    fixId: string;
    outcome: FixOutcome;
  } | null>(null);

  const [snapshots, setSnapshots] = useState<LkgSnapshotRecord[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [takingSnapshot, setTakingSnapshot] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      setLoadingSnapshots(true);
      const list = await listDoctorSnapshots();
      setSnapshots(list);
    } catch {
      // Keep existing snapshot list if IPC isn't available in tests
    } finally {
      setLoadingSnapshots(false);
    }
  }, []);

  useEffect(() => {
    void refreshDoctorState();
    void loadSnapshots();
  }, [loadSnapshots]);

  // Expand layers containing failures by default whenever a new report arrives
  useEffect(() => {
    if (!report) return;
    if (lastReportKeyRef.current === report.startedAt) return;
    lastReportKeyRef.current = report.startedAt;
    const nextExpanded: Partial<Record<DoctorLayer, boolean>> = {};
    for (const layer of DOCTOR_LAYERS) {
      nextExpanded[layer] = report.results.some((r) => r.layer === layer && r.severity === 'fail');
    }
    setExpandedLayers(nextExpanded);
  }, [report]);

  const groupedByLayer = useMemo(() => {
    if (!report) return [];
    return DOCTOR_LAYERS.map((layer) => {
      const items = report.results
        .filter((r) => r.layer === layer)
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
      const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
      for (const item of items) {
        counts[item.severity] += 1;
      }
      return { layer, items, counts };
    }).filter((group) => group.items.length > 0);
  }, [report]);

  const handleToggleRunOnStart = async (checked: boolean) => {
    try {
      setTogglingStartup(true);
      await setDoctorRunOnStart(checked);
      toast.success(checked ? 'Startup health check enabled' : 'Startup health check disabled');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update startup setting');
    } finally {
      setTogglingStartup(false);
    }
  };

  const handleRunChecks = async (includeSlow: boolean) => {
    try {
      await runDoctorChecks({
        cost: includeSlow ? ['instant', 'fast', 'slow'] : ['instant', 'fast'],
      });
      await loadSnapshots();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run diagnostics');
    }
  };

  const handleCopyReport = async () => {
    if (!report) return;
    const markdown = formatDoctorReportMarkdown(report);
    const ok = await copyTextToClipboard(markdown);
    if (ok) {
      setCopiedReport(true);
      toast.success('Copied diagnostic report');
      setTimeout(() => setCopiedReport(false), 1800);
    } else {
      toast.error('Clipboard unavailable');
    }
  };

  const handleCopyCli = async (key: string, command: string) => {
    const ok = await copyTextToClipboard(command);
    if (ok) {
      setCopiedCliKey(key);
      toast.success('Copied CLI command');
      setTimeout(() => setCopiedCliKey(null), 1800);
    } else {
      toast.error('Clipboard unavailable');
    }
  };

  const handleOpenFixPreview = async (fixId: string) => {
    try {
      setPreviewLoadingFixId(fixId);
      setLastOutcome(null);
      const plan = await previewDoctorFix(fixId);
      setActivePlan(plan);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to preview fix ${fixId}`);
    } finally {
      setPreviewLoadingFixId(null);
    }
  };

  const handleApplyFix = async () => {
    if (!activePlan) return;
    const fixId = activePlan.fixId;
    try {
      setApplyingFix(true);
      const outcome = await applyDoctorFix(activePlan);
      setLastOutcome({ fixId, outcome });
      if (outcome.ok) {
        toast.success(outcome.message || `Applied fix ${fixId}`);
        setActivePlan(null);
        await loadSnapshots();
      } else {
        toast.error(outcome.message || `Fix ${fixId} did not complete`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply fix');
    } finally {
      setApplyingFix(false);
    }
  };

  const handleTakeSnapshot = async () => {
    try {
      setTakingSnapshot(true);
      await takeDoctorSnapshot('manual');
      await loadSnapshots();
      toast.success('Saved LKG snapshot');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to capture snapshot');
    } finally {
      setTakingSnapshot(false);
    }
  };

  const renderCheckFixActions = (item: CheckResult) => {
    if (!item.fixIds || item.fixIds.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.fixIds.map((fixId) => {
          const meta = fixesMeta[fixId];
          const cliCommand = meta?.cliCommand ?? `pnpm run doctor fix ${fixId}`;
          if (meta?.needsAppClosed) {
            const copyKey = `${item.id}:${fixId}`;
            return (
              <div
                key={fixId}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs"
              >
                <Terminal className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                <span className="text-[var(--text-secondary)]">Requires app closed:</span>
                <code className="font-mono text-[11px] text-[var(--text-primary)]">{cliCommand}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  tone="quiet"
                  className="h-6 px-2 text-xs"
                  onClick={() => void handleCopyCli(copyKey, cliCommand)}
                >
                  {copiedCliKey === copyKey ? (
                    <>
                      <Check className="mr-1 h-3 w-3" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-3 w-3" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
            );
          }
          const isLoading = previewLoadingFixId === fixId;
          return (
            <Button
              key={fixId}
              type="button"
              size="sm"
              variant="secondary"
              disabled={running || isLoading}
              onClick={() => void handleOpenFixPreview(fixId)}
              aria-label={`Fix ${meta?.title ?? fixId}`}
            >
              {isLoading ? (
                <Spinner size={12} className="mr-1.5" />
              ) : (
                <Wrench className="mr-1.5 h-3.5 w-3.5" />
              )}
              {meta?.title ? `Fix: ${meta.title}` : 'Fix…'}
            </Button>
          );
        })}
      </div>
    );
  };

  const activeFixMeta = activePlan ? fixesMeta[activePlan.fixId] : undefined;
  const activeFixRequiresAppClosed = Boolean(
    activePlan?.requiresAppClosed || activeFixMeta?.needsAppClosed,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-[var(--text-secondary)]" />
          <h3 className={SETTINGS_SECTION_TITLE_CLASS}>Doctor &amp; Diagnostics</h3>
        </div>
        {lastStartupSnapshotAt ? (
          <span className="text-xs text-[var(--text-tertiary)]">
            Daily LKG: {formatTimestamp(lastStartupSnapshotAt)}
          </span>
        ) : null}
      </div>

      {/* Run controls & startup setting */}
      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          <div className="min-w-0 pr-4">
            <label htmlFor="doctor-run-on-start" className={SETTINGS_ROW_LABEL_CLASS}>
              Run startup health check
            </label>
            <p className={SETTINGS_ROW_HINT_CLASS}>
              Checks critical environment, runtime, and config health 20 seconds after launch and saves a daily LKG snapshot when clear.
            </p>
          </div>
          <Switch
            id="doctor-run-on-start"
            checked={runOnStart}
            disabled={togglingStartup}
            onCheckedChange={(checked) => void handleToggleRunOnStart(checked)}
            aria-label="Run startup health check"
          />
        </div>

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        <div className={cn(SETTINGS_ROW_CLASS, 'flex-wrap gap-3')}>
          <div className="min-w-0">
            {report ? (
              <div className="space-y-0.5">
                <p className={SETTINGS_ROW_LABEL_CLASS} data-testid="doctor-summary-line">
                  {report.results.length} checks · {report.counts.ok} ok · {report.counts.warn} warn ·{' '}
                  {report.counts.fail} fail · {report.counts.skip} skip
                </p>
                <p className={SETTINGS_ROW_HINT_CLASS}>
                  Last run {formatTimestamp(report.startedAt)} ({report.durationMs} ms)
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                <p className={SETTINGS_ROW_LABEL_CLASS} data-testid="doctor-summary-line">
                  No diagnostic run recorded yet
                </p>
                <p className={SETTINGS_ROW_HINT_CLASS}>
                  Run instant &amp; fast checks, or include slow end-to-end checks.
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={running}
              onClick={() => void handleRunChecks(false)}
            >
              {running ? (
                <Spinner size={14} className="mr-1.5" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Run checks
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={running}
              onClick={() => void handleRunChecks(true)}
            >
              Run all checks
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!report}
              onClick={() => void handleCopyReport()}
            >
              {copiedReport ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copy report
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-[var(--card-status-error)]/30 bg-[var(--card-status-error)]/10 px-4 py-2.5 text-sm text-[var(--card-status-error)]"
        >
          {error}
        </div>
      ) : null}

      {lastOutcome ? (
        <div
          role="status"
          className={cn(
            'rounded-xl border px-4 py-2.5 text-sm',
            lastOutcome.outcome.ok
              ? 'border-[var(--card-status-done)]/30 bg-[var(--card-status-done)]/10 text-[var(--text-primary)]'
              : 'border-[var(--card-status-error)]/30 bg-[var(--card-status-error)]/10 text-[var(--card-status-error)]',
          )}
        >
          <p className="font-medium">
            {lastOutcome.fixId}: {lastOutcome.outcome.message}
          </p>
          {lastOutcome.outcome.rolledBack ? (
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              Post-fix recheck failed; original files were restored automatically.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Grouped diagnostic results */}
      {groupedByLayer.length > 0 ? (
        <div className={SETTINGS_CARD_CLASS}>
          {groupedByLayer.map(({ layer, items, counts }, idx) => {
            const expanded = Boolean(expandedLayers[layer]);
            return (
              <div key={layer}>
                {idx > 0 ? <div className={SETTINGS_ROW_DIVIDER_CLASS} /> : null}
                <button
                  type="button"
                  onClick={() =>
                    setExpandedLayers((prev) => ({ ...prev, [layer]: !prev[layer] }))
                  }
                  aria-expanded={expanded}
                  className={cn(
                    SETTINGS_ROW_CLASS,
                    'w-full text-left transition-colors hover:bg-[var(--surface-hover)]/60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 text-[var(--text-tertiary)]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
                    )}
                    <span className={SETTINGS_ROW_LABEL_CLASS}>
                      {DOCTOR_LAYER_LABELS[layer] ?? layer}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {counts.fail > 0 ? (
                      <span className="rounded-full border border-[var(--card-status-error)]/30 bg-[var(--card-status-error)]/15 px-2 py-0.5 font-medium text-[var(--card-status-error)]">
                        {counts.fail} fail
                      </span>
                    ) : null}
                    {counts.warn > 0 ? (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                        {counts.warn} warn
                      </span>
                    ) : null}
                    <span className="text-[var(--text-tertiary)]">{counts.ok} ok</span>
                  </div>
                </button>

                {expanded ? (
                  <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] bg-[var(--bg-subtle)]/40">
                    {items.map((item) => (
                      <div key={item.id} className="px-4 py-3 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide',
                                  SEVERITY_BADGE_CLASS[item.severity],
                                )}
                              >
                                {SEVERITY_LABEL[item.severity]}
                              </span>
                              <code className="font-mono text-xs text-[var(--text-secondary)]">
                                {item.id}
                              </code>
                            </div>
                            <p className="text-sm text-[var(--text-primary)]">{item.summary}</p>
                            {item.detail ? (
                              <p className="text-xs text-[var(--text-secondary)]">{item.detail}</p>
                            ) : null}
                            {item.action ? (
                              <p className="text-xs text-[var(--text-tertiary)]">
                                Next: {item.action}
                              </p>
                            ) : null}
                            {renderCheckFixActions(item)}
                          </div>
                          <span className="shrink-0 font-mono text-[11px] text-[var(--text-tertiary)]">
                            {item.durationMs}ms
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Last-Known-Good (LKG) Snapshots */}
      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          <div className="min-w-0 pr-4">
            <p className={SETTINGS_ROW_LABEL_CLASS}>Last-Known-Good snapshots</p>
            <p className={SETTINGS_ROW_HINT_CLASS}>
              Point-in-time config &amp; environment baselines under ~/.cindy-harness/doctor/lkg/.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={takingSnapshot}
              onClick={() => void handleTakeSnapshot()}
            >
              {takingSnapshot ? (
                <Spinner size={14} className="mr-1.5" />
              ) : (
                <Camera className="mr-1.5 h-3.5 w-3.5" />
              )}
              Take snapshot
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
                  tone="quiet"
              disabled={loadingSnapshots}
              onClick={() => void loadSnapshots()}
              aria-label="Refresh snapshots"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loadingSnapshots && 'animate-spin')} />
            </Button>
          </div>
        </div>

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        {snapshots.length === 0 ? (
          <div className="px-4 py-3 text-xs text-[var(--text-tertiary)]">
            No snapshots saved yet.
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {snapshots.slice(0, 6).map((snap) => (
              <div
                key={snap.dir}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-primary)]">
                      {snap.manifest?.reason ?? 'snapshot'}
                    </span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium',
                        snap.valid
                          ? 'bg-[var(--card-status-done)]/15 text-[var(--card-status-done)]'
                          : 'bg-[var(--card-status-error)]/15 text-[var(--card-status-error)]',
                      )}
                    >
                      {snap.valid ? 'valid' : 'corrupt'}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[11px] text-[var(--text-tertiary)]">
                    {snap.manifest?.createdAt ?? snap.stamp}
                  </p>
                </div>
                {snap.manifest?.reportCounts ? (
                  <span className="shrink-0 text-[var(--text-secondary)]">
                    {snap.manifest.reportCounts.ok} ok · {snap.manifest.reportCounts.warn} warn ·{' '}
                    {snap.manifest.reportCounts.fail} fail
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fix Preview & Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(activePlan)}
        onOpenChange={(open) => {
          if (!open && !applyingFix) {
            setActivePlan(null);
          }
        }}
        title={
          activePlan
            ? `Preview fix: ${activeFixMeta?.title ?? activePlan.fixId}`
            : 'Preview fix'
        }
        description="A Last-Known-Good snapshot will be taken before applying changes."
        confirmText={activeFixRequiresAppClosed ? 'Requires CLI (app closed)' : 'Apply fix'}
        cancelText="Cancel"
        confirmVariant={activeFixMeta?.risk === 'kills-process' ? 'destructive' : 'default'}
        confirmDisabled={activeFixRequiresAppClosed}
        loading={applyingFix}
        showCloseButton={!applyingFix}
        maxWidth={520}
        contentSelectable
        onConfirm={() => void handleApplyFix()}
        onCancel={() => {
          if (!applyingFix) setActivePlan(null);
        }}
        content={
          activePlan ? (
            <div className="space-y-3 text-xs text-[var(--text-secondary)]">
              <div className="flex items-center gap-2">
                <span className="rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-primary)]">
                  {activePlan.fixId}
                </span>
                {activeFixMeta?.risk ? (
                  <span className="rounded border border-[var(--border-subtle)] px-2 py-0.5">
                    Risk: {activeFixMeta.risk}
                  </span>
                ) : null}
              </div>

              {activeFixRequiresAppClosed ? (
                <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
                  <p className="font-medium">
                    This fix cannot run while Cindy desktop is open. Close the app and run in Terminal:
                  </p>
                  <div className="flex items-center justify-between gap-2 rounded bg-black/10 px-2.5 py-1.5 dark:bg-black/30">
                    <code className="font-mono text-[11px]">
                      pnpm run doctor fix {activePlan.fixId}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                  tone="quiet"
                      className="h-6 px-2 text-xs"
                      onClick={() =>
                        void handleCopyCli(
                          `modal:${activePlan.fixId}`,
                          `pnpm run doctor fix ${activePlan.fixId}`,
                        )
                      }
                    >
                      {copiedCliKey === `modal:${activePlan.fixId}` ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div>
                <p className="mb-1 font-medium text-[var(--text-primary)]">Planned steps</p>
                <ol className="list-decimal space-y-1 pl-4">
                  {activePlan.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>

              {activePlan.touches.length > 0 ? (
                <div>
                  <p className="mb-1 font-medium text-[var(--text-primary)]">Files touched</p>
                  <ul className="space-y-0.5 font-mono text-[11px]">
                    {activePlan.touches.map((filePath, i) => (
                      <li key={i} className="break-all">
                        {filePath}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {activeFixMeta && activeFixMeta.recheck.length > 0 ? (
                <div>
                  <p className="mb-1 font-medium text-[var(--text-primary)]">Re-checks after apply</p>
                  <p className="font-mono text-[11px]">{activeFixMeta.recheck.join(', ')}</p>
                </div>
              ) : null}
            </div>
          ) : null
        }
      />
    </div>
  );
}
