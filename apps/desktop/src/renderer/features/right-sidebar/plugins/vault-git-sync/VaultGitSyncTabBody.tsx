/**
 * VaultGitSyncTabBody — Right sidebar view for Git Workspace ↔ Vault Project Note Auto-Sync.
 *
 * Inspects active workspace git status (branch, recent commits, dirty files) and offers
 * a 1-click sync to append a formatted progress section to the matching project note in the vault.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommit,
  Loader2,
  RefreshCw,
  Send,
  AlertCircle,
  FileText,
} from 'lucide-react';
import type { GitWorkspaceInspection } from '@cindy/maker-core/vault-git-sync';
import { cn } from '@/lib/utils';

export function VaultGitSyncTabBody() {
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [inspection, setInspection] = useState<GitWorkspaceInspection | null>(null);
  const [targetNotePath, setTargetNotePath] = useState<string>('');
  const [matchType, setMatchType] = useState<'exact' | 'heuristic' | 'default'>('default');
  const [summaryNote, setSummaryNote] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{ path: string; created: boolean } | null>(null);

  const runInspection = useCallback(async () => {
    if (!window.electronAPI?.maker?.vault?.gitSyncInspect) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await window.electronAPI.maker.vault.gitSyncInspect();
      if (!res.ok) {
        setErrorMessage(res.error || 'Failed to inspect git repository');
        setInspection(null);
      } else {
        setInspection(res.inspection ?? null);
        setTargetNotePath(res.targetNotePath || '');
        setMatchType(res.matchType || 'default');
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Failed to inspect workspace');
      setInspection(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runInspection();
  }, [runInspection]);

  const handleApplySync = async () => {
    if (!window.electronAPI?.maker?.vault?.gitSyncApply || syncing) return;
    setSyncing(true);
    setErrorMessage(null);
    setSuccessResult(null);

    try {
      const res = await window.electronAPI.maker.vault.gitSyncApply({
        targetNotePath: targetNotePath || undefined,
        summaryNote: summaryNote.trim() || undefined,
      });

      if (!res.ok) {
        setErrorMessage(res.error || 'Failed to append progress to project note');
      } else {
        setSuccessResult({
          path: res.path || targetNotePath,
          created: Boolean(res.created),
        });
        setSummaryNote('');
        await runInspection();
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Failed to sync to project note');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden text-xs bg-background text-foreground">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b px-3 py-2 border-border/40 bg-muted/20">
        <div className="flex items-center gap-1.5 font-medium">
          <FolderGit2 className="h-4 w-4 text-primary" />
          <span>Git Workspace ↔ Vault Sync</span>
        </div>
        <button
          type="button"
          onClick={runInspection}
          disabled={loading || syncing}
          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title="Refresh Git Workspace Status"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {errorMessage && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold">Inspection Notice</div>
              <div className="text-[11px] leading-tight opacity-90">{errorMessage}</div>
            </div>
          </div>
        )}

        {successResult && (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold">
                {successResult.created ? 'Created & Synced to Project Note!' : 'Appended Progress Log!'}
              </div>
              <div className="text-[11px] font-mono leading-tight break-all">
                {successResult.path}
              </div>
            </div>
          </div>
        )}

        {loading && !inspection && (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <span>Inspecting workspace git repository...</span>
          </div>
        )}

        {inspection && (
          <>
            {/* Target Note Banner */}
            <div className="rounded-md border border-border/50 bg-card p-2.5 space-y-1.5 shadow-sm">
              <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                <span className="flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  Target Project Note
                </span>
                <span
                  className={cn(
                    'px-1.5 py-0.2 rounded text-[10px] font-medium uppercase tracking-wider',
                    matchType === 'exact' && 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400',
                    matchType === 'heuristic' && 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
                    matchType === 'default' && 'bg-muted text-muted-foreground',
                  )}
                >
                  {matchType} match
                </span>
              </div>
              <div className="font-mono text-[11px] font-semibold text-foreground break-all bg-muted/30 px-2 py-1 rounded">
                {targetNotePath || `memory/Project — ${inspection.projectName}.md`}
              </div>
            </div>

            {/* Workspace & Branch Details */}
            <div className="rounded-md border border-border/50 bg-card p-2.5 space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground">{inspection.projectName}</span>
                <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  <GitBranch className="h-3 w-3" />
                  {inspection.branch || 'HEAD'}
                </span>
              </div>

              {/* Working Tree Status */}
              <div className="flex items-center justify-between pt-1 border-t border-border/30 text-[11px]">
                <span className="text-muted-foreground">Working tree:</span>
                {inspection.totalDirty === 0 ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Clean
                  </span>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                    {[
                      inspection.modified.length > 0 && `${inspection.modified.length} modified`,
                      inspection.staged.length > 0 && `${inspection.staged.length} staged`,
                      inspection.untracked.length > 0 && `${inspection.untracked.length} untracked`,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </span>
                )}
              </div>
            </div>

            {/* Recent Commits */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                <span className="flex items-center gap-1 font-medium">
                  <GitCommit className="h-3 w-3" />
                  Recent Commits ({inspection.recentCommits.length})
                </span>
              </div>

              <div className="space-y-1 rounded-md border border-border/40 bg-card/50 p-2 max-h-40 overflow-y-auto">
                {inspection.recentCommits.length === 0 ? (
                  <div className="py-2 text-center text-muted-foreground italic">No commits recorded</div>
                ) : (
                  inspection.recentCommits.map((c) => (
                    <div key={c.hash} className="flex items-start gap-1.5 text-[11px] leading-snug">
                      <span className="font-mono text-primary shrink-0 select-all font-semibold">
                        {c.hash}
                      </span>
                      <span className="text-foreground line-clamp-1">{c.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Milestone / Summary Input */}
            <div className="space-y-1.5 pt-1">
              <label htmlFor="vault-git-summary-input" className="text-[11px] font-medium text-muted-foreground">
                Progress Milestone Summary (Optional)
              </label>
              <textarea
                id="vault-git-summary-input"
                value={summaryNote}
                onChange={(e) => setSummaryNote(e.target.value)}
                placeholder="What did you achieve or change in this iteration?"
                className="w-full h-16 rounded-md border border-input bg-background p-2 text-xs placeholder:text-[var(--text-placeholder)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
              />
            </div>

            {/* 1-Click Action Button */}
            <button
              type="button"
              onClick={handleApplySync}
              disabled={syncing || loading}
              className="w-full flex items-center justify-center gap-1.5 rounded-md bg-primary py-2 px-3 font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {syncing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Syncing to Project Note...</span>
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  <span>Append Progress & Commit Log</span>
                </>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
