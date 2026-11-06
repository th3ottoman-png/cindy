import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderGit2, RefreshCw, Terminal, ExternalLink, Copy, Check, GitBranch, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { sessionsStore } from '@/lib/sessionsStore';
import type { TabKindBodyProps } from '../../types';
import type { WorktreeMeta } from '@/lib/worktree.types';
import { openTerminalTab } from '../../lib/openTerminalTab';

export function WorktreeManagerBody({ ctx }: TabKindBodyProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [worktrees, setWorktrees] = useState<WorktreeMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const loadWorktrees = useCallback(async () => {
    try {
      setLoading(true);
      if (window.electronAPI?.worktreeListAll) {
        const list = await window.electronAPI.worktreeListAll();
        setWorktrees(Array.isArray(list) ? list : []);
      }
    } catch {
      setWorktrees([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorktrees();
    const unsub = window.electronAPI?.onWorktreeChanged?.(() => {
      void loadWorktrees();
    });
    return () => {
      unsub?.();
    };
  }, [loadWorktrees]);

  const copyPath = (path: string) => {
    void navigator.clipboard.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 2000);
  };

  const handleReveal = (path: string) => {
    void window.electronAPI?.worktreeReveal?.({ path });
  };

  const handleSwitchSession = (sessionId: string) => {
    navigate(`/cc-agent/${sessionId}`);
  };

  const handleOpenTerminal = (sessionId: string) => {
    void openTerminalTab(sessionId);
  };

  const currentWorktree = worktrees.find((w) => w.sessionId === ctx.sessionId);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <FolderGit2 className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Worktree Manager</span>
          <span className="ml-1 rounded-full bg-secondary/70 px-2 py-0.5 text-[10px] text-muted-foreground font-mono">
            {worktrees.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void loadWorktrees()}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Refresh worktrees"
          aria-label="Refresh worktrees"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Current Session Isolation Status */}
        <div className={cn(
          'rounded-lg border p-2.5',
          currentWorktree ? 'border-primary/30 bg-primary/5' : 'border-border/60 bg-muted/20'
        )}>
          <div className="flex items-center justify-between font-medium">
            <span className="flex items-center gap-1.5 text-foreground">
              <GitBranch className={cn('h-3.5 w-3.5', currentWorktree ? 'text-primary' : 'text-muted-foreground')} />
              Current Task Workspace
            </span>
            <span className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-medium',
              currentWorktree ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
            )}>
              {currentWorktree ? 'Worktree Isolated' : 'Main Project'}
            </span>
          </div>
          <div className="mt-1.5 truncate text-[11px] text-muted-foreground font-mono" title={currentWorktree ? currentWorktree.path : ctx.workdir}>
            {currentWorktree ? currentWorktree.path : (ctx.workdir || 'No directory bound')}
          </div>
        </div>

        {/* Worktrees list */}
        <div className="space-y-2">
          <div className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider px-1">
            Active Worktrees ({worktrees.length})
          </div>

          {worktrees.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/80 p-8 text-center text-muted-foreground">
              <FolderGit2 className="mb-2 h-8 w-8 text-muted-foreground/50" />
              <div className="font-medium text-foreground">No active Git worktrees</div>
              <p className="mt-1 text-[11px] leading-relaxed max-w-[260px]">
                Worktrees allow Cindy to branch and edit code in separate parallel directories without touching your main working copy.
              </p>
            </div>
          ) : (
            worktrees.map((wt) => {
              const isCurrent = wt.sessionId === ctx.sessionId;
              const sessionTitle = sessionsStore.findById(wt.sessionId)?.title || wt.sessionId.slice(0, 8);
              const branchName = wt.branch || wt.path.split('/').pop() || 'worktree';

              return (
                <div
                  key={wt.sessionId}
                  className={cn(
                    'group relative rounded-lg border p-2.5 transition-all',
                    isCurrent ? 'border-primary/40 bg-primary/[0.03]' : 'border-border/70 hover:border-border'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-foreground truncate" title={sessionTitle}>
                          {sessionTitle}
                        </span>
                        {isCurrent && (
                          <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.2 text-[9px] font-semibold text-primary">
                            CURRENT
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground font-mono">
                        <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                        <span className="truncate">{branchName}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => copyPath(wt.path)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Copy directory path"
                        aria-label="Copy directory path"
                      >
                        {copiedPath === wt.path ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReveal(wt.path)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Reveal in Finder / Explorer"
                        aria-label="Reveal in Finder / Explorer"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenTerminal(wt.sessionId)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Open terminal here"
                        aria-label="Open terminal here"
                      >
                        <Terminal className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-2 text-[10px]">
                    <span className="truncate text-muted-foreground font-mono max-w-[200px]" title={wt.path}>
                      {wt.path}
                    </span>
                    {!isCurrent && (
                      <button
                        type="button"
                        onClick={() => handleSwitchSession(wt.sessionId)}
                        className="font-medium text-primary hover:underline"
                      >
                        Switch Task →
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
