import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  FileCode,
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type {
  WorktreeDiffResponse,
  WorktreeMergeResponse,
} from '../../../main/worktree';
import type {
  WorktreeCouncilStatus,
  WorktreeMergeCleanupResult,
} from '../../../main/worktree/worktreeCouncil';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';

export interface WorktreeMergeStripViewProps {
  diff: WorktreeDiffResponse | null;
  loading: boolean;
  merging: boolean;
  merged: boolean;
  errorMessage: string | null;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onMerge: () => void;
  onRefresh: () => void;
  /** ROADMAP 11.11: Council state for this worktree; null/unconfigured keeps the 9.2 merge. */
  council?: WorktreeCouncilStatus | null;
  councilBusy?: boolean;
  onRunCouncil?: () => void;
  onMergeCleanup?: () => void;
  cleanupMessage?: string | null;
}

const COUNCIL_PILL: Record<string, string> = {
  passed: 'border-emerald-500/50 text-emerald-600',
  failed: 'border-rose-500/50 text-rose-500',
  unusable: 'border-rose-500/50 text-rose-500',
  stale: 'border-[var(--warning-accent)] text-foreground',
  pending: 'border-border/60 text-muted-foreground',
  running: 'border-primary/50 text-primary',
  empty: 'border-border/60 text-muted-foreground',
};

function councilLabel(council: WorktreeCouncilStatus): string {
  switch (council.gate.state) {
    case 'passed':
      return 'Council passed';
    case 'failed':
      return `Council: ${council.gate.blocking} blocking`;
    case 'unusable':
      return 'Council: no usable review';
    case 'stale':
      return 'Council: diff changed';
    case 'running':
      return 'Council reviewing…';
    case 'empty':
      return 'Council: nothing to review';
    default:
      return 'Council: not reviewed';
  }
}

export function WorktreeMergeStripView({
  diff,
  loading,
  merging,
  merged,
  errorMessage,
  detailsOpen,
  onToggleDetails,
  onMerge,
  onRefresh,
  council = null,
  councilBusy = false,
  onRunCouncil,
  onMergeCleanup,
  cleanupMessage = null,
}: WorktreeMergeStripViewProps) {
  if (cleanupMessage) {
    return (
      <div
        data-testid="worktree-merge-strip"
        className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-emerald-600 select-none"
      >
        <span className="flex items-center gap-1 font-medium" data-testid="worktree-cleanup-message">
          <Check size={12} />
          {cleanupMessage}
        </span>
      </div>
    );
  }
  if (!diff || !diff.hasWorktree) {
    return null;
  }
  const councilGated = Boolean(council?.configured);

  const { decision, summary, worktreeBranch, baseBranch } = diff;
  const isAllowed = Boolean(
    decision?.allowed && !merged && (!councilGated || council?.gate.mergeAllowed),
  );
  const totalFiles = summary?.fileCount ?? 0;
  const totalAdded = summary?.added ?? 0;
  const totalRemoved = summary?.removed ?? 0;

  return (
    <div
      data-testid="worktree-merge-strip"
      className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground select-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Left: branch indicators & diff summary */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-foreground">
            <GitBranch size={13} className="text-primary" />
            <span className="truncate max-w-[140px]" title={worktreeBranch}>
              {worktreeBranch ?? 'worktree'}
            </span>
            <span className="text-muted-foreground">→</span>
            <span className="text-muted-foreground truncate max-w-[100px]" title={baseBranch}>
              {baseBranch ?? 'base'}
            </span>
          </div>

          {/* Diff stats chip */}
          <div className="flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[11px] font-mono border border-border/50">
            {totalFiles === 0 ? (
              <span className="text-muted-foreground">clean</span>
            ) : (
              <>
                <span className="text-foreground">{totalFiles} file{totalFiles === 1 ? '' : 's'}</span>
                {totalAdded > 0 && <span className="text-emerald-500 font-semibold">+{totalAdded}</span>}
                {totalRemoved > 0 && <span className="text-rose-500 font-semibold">-{totalRemoved}</span>}
              </>
            )}
          </div>

          {/* Ahead / Behind count */}
          {(diff.ahead !== undefined || diff.behind !== undefined) && (
            <span className="text-[11px] text-muted-foreground">
              ({diff.ahead ?? 0} ahead, {diff.behind ?? 0} behind)
            </span>
          )}

          {/* Status / Message */}
          {errorMessage && (
            <span className="flex items-center gap-1 text-[11px] text-rose-500" title={errorMessage}>
              <AlertCircle size={12} />
              <span className="truncate max-w-[220px]">{errorMessage}</span>
            </span>
          )}

          {merged && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-500 font-medium">
              <Check size={12} />
              Merged into {baseBranch}
            </span>
          )}
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-1.5">
          {totalFiles > 0 && (
            <button
              type="button"
              onClick={onToggleDetails}
              data-testid="worktree-review-diff-btn"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground border border-transparent hover:border-border"
              title="Review modified files"
            >
              <FileCode size={12} />
              <span>Review diff</span>
              {detailsOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}

          {councilGated && council && (
            <>
              <span
                data-testid="worktree-council-pill"
                data-state={council.gate.state}
                title={council.error ?? council.gate.message}
                className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${COUNCIL_PILL[council.gate.state] ?? ''}`}
              >
                {council.gate.state === 'running' || councilBusy ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <ShieldCheck size={11} />
                )}
                {councilBusy && council.gate.state !== 'running' ? 'Council reviewing…' : councilLabel(council)}
              </span>
              <button
                type="button"
                onClick={onRunCouncil}
                disabled={councilBusy || merging || loading || council.gate.state === 'empty'}
                data-testid="worktree-council-run-btn"
                className="rounded px-2 py-0.5 text-[11px] text-muted-foreground border border-border/50 hover:bg-background hover:text-foreground disabled:opacity-40"
                title="Run the Council on this worktree's diff"
              >
                Run council
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || merging}
            data-testid="worktree-refresh-btn"
            className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-40"
            title="Refresh worktree diff"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>

          <button
            type="button"
            onClick={councilGated ? onMergeCleanup : onMerge}
            disabled={!isAllowed || merging || loading || councilBusy}
            data-testid="worktree-merge-btn"
            title={
              councilGated && council && !council.gate.mergeAllowed
                ? council.gate.message
                : decision?.message ?? 'Merge worktree into working tree'
            }
            className={`flex items-center gap-1 rounded px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              isAllowed
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
                : 'bg-muted text-muted-foreground/60 cursor-not-allowed border border-border/40'
            }`}
          >
            {merging ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                <span>Merging…</span>
              </>
            ) : (
              <>
                <GitMerge size={12} />
                <span>{councilGated ? 'Merge to Main Worktree' : 'Merge into working tree'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Expandable diff files drawer */}
      {detailsOpen && summary && summary.files.length > 0 && (
        <div
          data-testid="worktree-diff-drawer"
          className="mt-1.5 rounded border border-border bg-background p-2 text-[11px]"
        >
          <div className="mb-1 flex items-center justify-between font-medium text-muted-foreground">
            <span>Files changed ({summary.files.length}{summary.truncated ? '+' : ''})</span>
            {decision && <span className="text-[10px] italic">{decision.message}</span>}
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5 font-mono">
            {summary.files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-2 px-1 py-0.5 rounded hover:bg-muted/50"
              >
                <span className="truncate text-foreground" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 flex items-center gap-1.5 text-[10px]">
                  {file.binary ? (
                    <span className="text-muted-foreground">binary</span>
                  ) : (
                    <>
                      {file.added > 0 && (
                        <span className="text-emerald-500 font-semibold">+{file.added}</span>
                      )}
                      {file.removed > 0 && (
                        <span className="text-rose-500 font-semibold">-{file.removed}</span>
                      )}
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface WorktreeMergeStripProps {
  sessionId: string;
}

export function WorktreeMergeStrip({ sessionId }: WorktreeMergeStripProps) {
  const [diff, setDiff] = useState<WorktreeDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [council, setCouncil] = useState<WorktreeCouncilStatus | null>(null);
  const [councilBusy, setCouncilBusy] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);

  const loadCouncil = useCallback(async () => {
    if (!sessionId || !window.electronAPI?.worktreeCouncilStatus) return;
    try {
      setCouncil(await window.electronAPI.worktreeCouncilStatus(sessionId));
    } catch {
      setCouncil(null);
    }
  }, [sessionId]);

  const runCouncil = useCallback(
    async (auto: boolean) => {
      if (!sessionId || !window.electronAPI?.worktreeCouncilRun) return;
      setCouncilBusy(true);
      try {
        setCouncil(await window.electronAPI.worktreeCouncilRun(sessionId, auto));
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setCouncilBusy(false);
      }
    },
    [sessionId],
  );

  const loadDiff = useCallback(async () => {
    if (!sessionId || !window.electronAPI?.worktreeDiff) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const resp = (await window.electronAPI.worktreeDiff(
        sessionId,
      )) as WorktreeDiffResponse;
      setDiff(resp);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // ROADMAP 11.11: when a turn ends, review the worktree diff (the host skips an unchanged diff).
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (!sessionId) return undefined;
    wasStreaming.current = Boolean(makerChatStore.getSnapshot(sessionId)?.isStreaming);
    return makerChatStore.subscribe(sessionId, () => {
      const streaming = Boolean(makerChatStore.getSnapshot(sessionId)?.isStreaming);
      if (wasStreaming.current && !streaming) {
        void loadDiff();
        void runCouncil(true);
      }
      wasStreaming.current = streaming;
    });
  }, [sessionId, loadDiff, runCouncil]);

  useEffect(() => {
    setMerged(false);
    setDetailsOpen(false);
    setCleanupMessage(null);
    void loadDiff();
    void loadCouncil();

    if (window.electronAPI?.onWorktreeChanged) {
      const unsub = window.electronAPI.onWorktreeChanged((payload) => {
        if (!payload || payload.sessionId === sessionId) {
          void loadDiff();
        }
      });
      return unsub;
    }
  }, [sessionId, loadDiff]);

  const handleMerge = useCallback(async () => {
    if (!sessionId || !window.electronAPI?.worktreeMerge) return;
    setMerging(true);
    setErrorMessage(null);
    try {
      const resp = (await window.electronAPI.worktreeMerge(
        sessionId,
      )) as WorktreeMergeResponse;
      if (resp.ok) {
        setMerged(true);
        void loadDiff();
      } else {
        setErrorMessage(resp.message || 'Merge failed');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  }, [sessionId, loadDiff]);

  const handleMergeCleanup = useCallback(async () => {
    if (!sessionId || !window.electronAPI?.worktreeMergeCleanup) return;
    setMerging(true);
    setErrorMessage(null);
    try {
      const resp: WorktreeMergeCleanupResult = await window.electronAPI.worktreeMergeCleanup(sessionId);
      if (resp.ok) {
        setMerged(true);
        let message = resp.message;
        // The worktree folder is gone: point the chat back at the repo it came from, the same
        // way the draft route points a new chat at its worktree, so the next turn has a cwd.
        if (resp.cleaned && resp.baseRepo) {
          try {
            await sessionService.update(sessionId, { workingDir: resp.baseRepo });
            sessionsStore.patchLocal(sessionId, { workingDir: resp.baseRepo });
            message = `${message} Chat now works in ${resp.baseRepo}.`;
          } catch {
            message = `${message} Could not move the chat back to ${resp.baseRepo}.`;
          }
        }
        setCleanupMessage(message);
      } else {
        setErrorMessage(resp.message || 'Merge failed');
        void loadCouncil();
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  }, [sessionId, loadCouncil]);

  const handleToggleDetails = useCallback(() => {
    setDetailsOpen((prev) => !prev);
  }, []);

  return (
    <WorktreeMergeStripView
      diff={diff}
      loading={loading}
      merging={merging}
      merged={merged}
      errorMessage={errorMessage}
      detailsOpen={detailsOpen}
      onToggleDetails={handleToggleDetails}
      onMerge={handleMerge}
      onRefresh={() => {
        void loadDiff();
        void loadCouncil();
      }}
      council={council}
      councilBusy={councilBusy}
      onRunCouncil={() => void runCouncil(false)}
      onMergeCleanup={() => void handleMergeCleanup()}
      cleanupMessage={cleanupMessage}
    />
  );
}
