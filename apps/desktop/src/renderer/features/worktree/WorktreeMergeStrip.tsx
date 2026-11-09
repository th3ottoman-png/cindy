import React, { useCallback, useEffect, useState } from 'react';
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
} from 'lucide-react';
import type {
  WorktreeDiffResponse,
  WorktreeMergeResponse,
} from '../../../main/worktree';

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
}: WorktreeMergeStripViewProps) {
  if (!diff || !diff.hasWorktree) {
    return null;
  }

  const { decision, summary, worktreeBranch, baseBranch } = diff;
  const isAllowed = Boolean(decision?.allowed && !merged);
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
            onClick={onMerge}
            disabled={!isAllowed || merging || loading}
            data-testid="worktree-merge-btn"
            title={decision?.message ?? 'Merge worktree into working tree'}
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
                <span>Merge into working tree</span>
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

  useEffect(() => {
    setMerged(false);
    setDetailsOpen(false);
    void loadDiff();

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
      onRefresh={loadDiff}
    />
  );
}
