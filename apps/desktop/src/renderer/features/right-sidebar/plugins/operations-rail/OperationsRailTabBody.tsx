import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Play,
  Square,
  RotateCcw,
  FlaskConical,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Bot,
  Terminal,
  Calendar,
  Users,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  formatRelative,
  type OperationAction,
  type OperationRow,
  type OperationStatus,
} from '@cindy/maker-core/operations-rail';
import type { TabKindBodyProps } from '../../types';

import { LocalServicesPanel } from './LocalServicesPanel';

export function OperationsRailTabBody(_props: TabKindBodyProps) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<OperationRow[]>([]);
  const [summary, setSummary] = useState<{ kind: string; count: number; running: number }[]>([]);
  const [hasRunning, setHasRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const fetchOperations = useCallback(async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.maker?.operations) {
        const res = await window.electronAPI.maker.operations.list();
        if (res && Array.isArray(res.rows)) {
          setRows(res.rows);
          setSummary(res.summary || []);
          setHasRunning(res.hasRunning || false);
        }
      }
    } catch (err) {
      console.error('Failed to fetch operations rail:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchOperations();
    const interval = setInterval(() => {
      void fetchOperations();
    }, 4000);

    const unsub = window.electronAPI?.maker?.operations?.onChanged?.(() => {
      void fetchOperations();
    });

    return () => {
      clearInterval(interval);
      unsub?.();
    };
  }, [fetchOperations]);

  const handleCancel = async (row: OperationRow) => {
    setActionInProgress(`cancel-${row.id}`);
    try {
      const res = await window.electronAPI?.maker?.operations?.cancel({
        kind: row.kind,
        id: row.id,
      });
      if (res?.ok) {
        toast.info(`Cancelled ${row.kind}: ${row.title}`);
      } else {
        toast.warning(res?.message || `Failed to cancel ${row.title}`);
      }
      await fetchOperations();
    } catch (err) {
      toast.error(`Error cancelling operation: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleReplay = async (row: OperationRow) => {
    setActionInProgress(`replay-${row.id}`);
    try {
      const res = await window.electronAPI?.maker?.operations?.replay({
        kind: row.kind,
        id: row.id,
      });
      if (res?.ok) {
        toast.success(`Replay triggered for ${row.title}`);
      } else {
        toast.warning(res?.message || `Failed to replay ${row.title}`);
      }
      await fetchOperations();
    } catch (err) {
      toast.error(`Error replaying operation: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRunScheduleNow = async (row: OperationRow) => {
    setActionInProgress(`run-${row.id}`);
    try {
      const res = await window.electronAPI?.maker?.scheduledSessions?.runNow(row.id);
      if (res?.status === 'success') {
        toast.success(`Schedule "${row.title}" executed successfully`);
      } else {
        toast.error(`Schedule execution failed: ${res?.error || 'Unknown error'}`);
      }
      await fetchOperations();
    } catch (err) {
      toast.error(`Error executing schedule: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDryRunSchedule = async (row: OperationRow) => {
    setActionInProgress(`dryrun-${row.id}`);
    try {
      const res = await window.electronAPI?.maker?.operations?.dryRunSchedule({ id: row.id });
      if (res?.status === 'success') {
        toast.success(
          `Dry-run successful! 0 bytes written to vault. Output: ${(res.output || '').slice(0, 80)}...`,
        );
      } else {
        toast.error(`Dry-run failed: ${res?.error || 'Unknown error'}`);
      }
      await fetchOperations();
    } catch (err) {
      toast.error(`Error in dry-run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleOpen = (row: OperationRow) => {
    if (row.kind === 'turn' || row.kind === 'worker') {
      navigate(`/cc-agent/${row.id}`);
    } else if (row.kind === 'schedule') {
      navigate('/settings');
    }
  };

  const renderStatusBadge = (status: OperationStatus) => {
    switch (status) {
      case 'running':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Running
          </span>
        );
      case 'success':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
            <CheckCircle2 size={11} />
            Success
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-500/15 text-rose-400 border border-rose-500/30">
            <AlertCircle size={11} />
            Failed
          </span>
        );
      case 'scheduled':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <Clock size={11} />
            Scheduled
          </span>
        );
      case 'idle':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20">
            Idle
          </span>
        );
    }
  };

  const renderKindIcon = (kind: string) => {
    switch (kind) {
      case 'turn':
        return <Terminal size={13} className="text-blue-400" />;
      case 'worker':
        return <Users size={13} className="text-purple-400" />;
      case 'bot':
        return <Bot size={13} className="text-cyan-400" />;
      case 'schedule':
        return <Calendar size={13} className="text-amber-400" />;
      default:
        return <Activity size={13} className="text-slate-400" />;
    }
  };

  const nowMs = Date.now();

  return (
    <div className="flex flex-col h-full w-full overflow-hidden text-sm select-text bg-background">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/20">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-primary" />
          <span className="font-semibold text-xs tracking-wide uppercase text-foreground">
            Operations Rail
          </span>
          {hasRunning && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
              Active
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void fetchOperations()}
          disabled={loading}
          aria-label="Refresh operations rail"
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition"
        >
          <RotateCcw size={13} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {/* Active Services (ROADMAP 11.6) */}
      <LocalServicesPanel />

      {/* Summary Chips */}
      {summary.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-border/30 bg-muted/10">
          {summary.map((item) => (
            <div
              key={item.kind}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-muted/50 border border-border/40 text-muted-foreground"
            >
              {renderKindIcon(item.kind)}
              <span className="capitalize">{item.kind}s:</span>
              <span className="font-medium text-foreground">{item.count}</span>
              {item.running > 0 && (
                <span className="px-1 py-0.2 rounded text-[10px] bg-emerald-500/20 text-emerald-300 font-bold">
                  {item.running} active
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Rows Container */}
      <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2.5">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-center p-4">
            <Activity size={28} className="mb-2 opacity-40 text-primary" />
            <p className="text-xs font-medium">No operations in flight or scheduled</p>
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              Active agent turns, background workers, bots, and cron schedules appear here.
            </p>
          </div>
        ) : (
          rows.map((row) => {
            const isActing = actionInProgress?.includes(row.id);
            const isRunning = row.status === 'running';

            return (
              <div
                key={`${row.kind}-${row.id}`}
                className={cn(
                  'rounded-lg border p-2.5 transition flex flex-col gap-2',
                  isRunning
                    ? 'border-emerald-500/40 bg-emerald-500/5 shadow-sm'
                    : row.status === 'failed'
                    ? 'border-rose-500/30 bg-rose-500/5'
                    : 'border-border/50 bg-card/60 hover:bg-card',
                )}
              >
                {/* Header row */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="p-1 rounded bg-muted/60 border border-border/40">
                      {renderKindIcon(row.kind)}
                    </span>
                    <span className="font-medium text-xs text-foreground truncate" title={row.title}>
                      {row.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {renderStatusBadge(row.status)}
                    {row.atMs && (
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelative(row.atMs, nowMs)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Detail */}
                {row.detail && (
                  <p
                    className="text-[11px] text-muted-foreground line-clamp-2 font-mono bg-muted/30 px-2 py-1 rounded"
                    title={row.detail}
                  >
                    {row.detail}
                  </p>
                )}

                {/* Actions row */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/30">
                  {row.actions.map((act) => {
                    if (act === 'cancel') {
                      return (
                        <button
                          key={act}
                          type="button"
                          onClick={() => void handleCancel(row)}
                          disabled={isActing}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20 transition disabled:opacity-50"
                        >
                          <Square size={10} />
                          Cancel
                        </button>
                      );
                    }
                    if (act === 'replay') {
                      return (
                        <button
                          key={act}
                          type="button"
                          onClick={() => void handleReplay(row)}
                          disabled={isActing}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition disabled:opacity-50"
                        >
                          <RotateCcw size={10} />
                          Replay
                        </button>
                      );
                    }
                    if (act === 'run-now') {
                      return (
                        <React.Fragment key={act}>
                          <button
                            type="button"
                            onClick={() => void handleRunScheduleNow(row)}
                            disabled={isActing}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition disabled:opacity-50"
                          >
                            <Play size={10} />
                            Run Now
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDryRunSchedule(row)}
                            disabled={isActing}
                            title="Execute in a throwaway sandbox without writing to vault"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 transition disabled:opacity-50"
                          >
                            <FlaskConical size={10} />
                            Dry-Run
                          </button>
                        </React.Fragment>
                      );
                    }
                    if (act === 'open') {
                      return (
                        <button
                          key={act}
                          type="button"
                          onClick={() => handleOpen(row)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-border/40 transition ml-auto"
                        >
                          <ExternalLink size={10} />
                          Open
                        </button>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
