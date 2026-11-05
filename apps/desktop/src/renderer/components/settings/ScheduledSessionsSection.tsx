import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, FolderOpen, Play, RefreshCw, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type {
  ScheduleEntryView,
  ScheduledSessionsConfigView,
} from '../../../main/maker-ipc/scheduledSessions';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

function formatTimestamp(ms?: number): string {
  if (!ms) return 'Never';
  const d = new Date(ms);
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ScheduledSessionsView({
  config,
  schedules,
  loading,
  saving,
  runningId,
  onSaveConfig,
  onPickFolder,
  onRunNow,
}: {
  config: ScheduledSessionsConfigView;
  schedules: ScheduleEntryView[];
  loading: boolean;
  saving: boolean;
  runningId: string | null;
  onSaveConfig: (schedulesDir: string) => void;
  onPickFolder: () => void;
  onRunNow: (id: string) => void;
}) {
  const [draftDir, setDraftDir] = useState(config.schedulesDir ?? '');

  useEffect(() => {
    setDraftDir(config.schedulesDir ?? '');
  }, [config.schedulesDir]);

  const hasChanged = draftDir.trim() !== (config.schedulesDir ?? '').trim();
  const validSchedules = schedules.filter((s) => s.ok);

  return (
    <div className="flex flex-col gap-3" data-testid="settings-scheduled-sessions">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <CalendarClock size={18} className="text-[var(--text-secondary)]" aria-hidden="true" />
          <h2 className={SETTINGS_SECTION_TITLE_CLASS}>Scheduled Sessions</h2>
        </div>
        <p className={SETTINGS_ROW_HINT_CLASS}>
          File-backed cron schedules (~/.cindy-harness/schedules/&lt;id&gt;.md). Runs expert sessions automatically on a cron schedule and appends results to your Notes Vault.
        </p>
      </div>

      {!config.vaultConfigured && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-12 text-amber-200"
          data-testid="vault-warning"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-amber-300">Notes Vault Not Configured</span>
            <span>
              Scheduled sessions require a Notes Vault folder to save output notes. Please set a Notes Vault in the section above before running schedules.
            </span>
          </div>
        </div>
      )}

      {config.issue && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-12 text-amber-200"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-amber-300">Configuration Issue</span>
            <span>{config.issue}</span>
          </div>
        </div>
      )}

      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex flex-col gap-1.5 flex-1 min-w-0 pr-4">
            <span className={SETTINGS_ROW_LABEL_CLASS}>Schedules Folder</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draftDir}
                onChange={(e) => setDraftDir(e.target.value)}
                placeholder="/path/to/schedules"
                className={cn(
                  'w-full rounded-md border px-3 py-1.5 text-12',
                  'bg-[var(--input-bg)] border-[var(--input-border)] text-[var(--text-primary)]',
                  'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
                )}
                data-testid="schedules-dir-input"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={onPickFolder}
                disabled={saving}
                className="shrink-0 flex items-center gap-1.5"
                title="Browse folder"
              >
                <FolderOpen size={14} aria-hidden="true" />
                <span>Browse…</span>
              </Button>
            </div>
            {config.schedulesDir && (
              <span className="text-11 text-emerald-400 flex items-center gap-1 mt-0.5">
                <Check size={12} aria-hidden="true" />
                <span>
                  Connected ({validSchedules.length} valid schedule{validSchedules.length === 1 ? '' : 's'})
                </span>
              </span>
            )}
          </div>
          <div className="shrink-0 flex items-center">
            <Button
              size="sm"
              disabled={!hasChanged || saving || !draftDir.trim()}
              onClick={() => onSaveConfig(draftDir)}
            >
              {saving ? <Spinner size="sm" /> : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 mt-2">
        <div className="flex items-center justify-between">
          <span className="text-13 font-medium text-[var(--text-primary)]">Configured Schedules</span>
          {loading && <Spinner size="sm" />}
        </div>

        {schedules.length === 0 && !loading && (
          <div className={cn(SETTINGS_CARD_CLASS, 'p-4 text-center text-12 text-[var(--text-secondary)]')}>
            No schedule files found in this folder. Add markdown files with frontmatter (<code className="text-11 bg-[var(--code-inline-bg)] px-1 py-0.5 rounded">expert</code>, <code className="text-11 bg-[var(--code-inline-bg)] px-1 py-0.5 rounded">cron</code>, <code className="text-11 bg-[var(--code-inline-bg)] px-1 py-0.5 rounded">output</code>) to schedule runs.
          </div>
        )}

        {schedules.map((item) => {
          if (!item.ok) {
            return (
              <div
                key={item.file}
                className={cn(
                  SETTINGS_CARD_CLASS,
                  'p-3.5 border-amber-500/30 bg-amber-500/5 flex flex-col gap-1',
                )}
                data-testid={`schedule-error-${item.id}`}
              >
                <div className="flex items-center gap-2 text-amber-400 text-12 font-medium">
                  <XCircle size={14} aria-hidden="true" />
                  <span>{item.id}.md</span>
                </div>
                <span className="text-11 text-amber-200/90 pl-5">{item.error}</span>
              </div>
            );
          }

          const isRunning = runningId === item.id;
          const lastRun = item.lastRun;
          const isSuccess = lastRun?.status === 'success';

          return (
            <div
              key={item.id}
              className={cn(SETTINGS_CARD_CLASS, 'p-4 flex flex-col gap-2.5')}
              data-testid={`schedule-row-${item.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-13 font-semibold text-[var(--text-primary)]">{item.id}</span>
                    <span className="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 text-11 font-medium text-[var(--text-secondary)]">
                      expert: {item.expert}
                    </span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-10 font-semibold uppercase tracking-wider',
                        item.enabled
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20',
                      )}
                    >
                      {item.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-11 text-[var(--text-secondary)] flex-wrap">
                    <span>
                      Cron: <code className="font-mono text-11 text-[var(--text-primary)]">{item.cron}</code> ({item.timezone})
                    </span>
                    <span>•</span>
                    <span>Output: {item.output}</span>
                  </div>
                </div>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onRunNow(item.id)}
                  disabled={isRunning || !config.vaultConfigured}
                  className="shrink-0 flex items-center gap-1.5 text-11 h-7"
                  data-testid={`run-now-btn-${item.id}`}
                  title={!config.vaultConfigured ? 'Configure Notes Vault first' : 'Run schedule now'}
                >
                  {isRunning ? <Spinner size="sm" /> : <Play size={12} fill="currentColor" />}
                  <span>Run now</span>
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-[var(--settings-theme-card-border)] pt-2 text-11">
                <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                  <span>Last run:</span>
                  {lastRun ? (
                    <span className={cn('flex items-center gap-1 font-medium', isSuccess ? 'text-emerald-400' : 'text-rose-400')}>
                      {isSuccess ? <Check size={12} /> : <XCircle size={12} />}
                      <span>{formatTimestamp(lastRun.at)}</span>
                      {lastRun.error && <span className="text-rose-300">({lastRun.error})</span>}
                      {lastRun.notePath && <span className="text-zinc-400">({lastRun.notePath})</span>}
                    </span>
                  ) : (
                    <span>Never</span>
                  )}
                </div>

                {item.enabled && item.nextRunMs && (
                  <div className="text-[var(--text-secondary)]">
                    Next run: <span className="text-[var(--text-primary)]">{formatTimestamp(item.nextRunMs)}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ScheduledSessionsSection() {
  const [config, setConfig] = useState<ScheduledSessionsConfigView>({
    schedulesDir: '',
    vaultDir: '',
    vaultConfigured: false,
  });
  const [schedules, setSchedules] = useState<ScheduleEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const api = window.electronAPI?.maker?.scheduledSessions;

  const loadData = useCallback(async () => {
    if (!api) return;
    try {
      const [cfg, list] = await Promise.all([
        api.getConfig(),
        api.list(),
      ]);
      setConfig(cfg);
      setSchedules(list);
    } catch (err) {
      console.error('Failed to load scheduled sessions:', err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadData();
    if (!api?.onChanged) return;
    return api.onChanged(() => {
      void loadData();
    });
  }, [api, loadData]);

  const handleSaveConfig = useCallback(
    async (schedulesDir: string) => {
      if (!api) return;
      setSaving(true);
      try {
        const updated = await api.setConfig(schedulesDir);
        setConfig(updated);
        await loadData();
        toast.success('Schedules folder updated');
      } catch (err) {
        toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [api, loadData],
  );

  const handlePickFolder = useCallback(async () => {
    if (!api) return;
    try {
      const picked = await api.pickFolder();
      if (picked) {
        await handleSaveConfig(picked);
      }
    } catch (err) {
      toast.error(`Folder picker failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [api, handleSaveConfig]);

  const handleRunNow = useCallback(
    async (id: string) => {
      if (!api) return;
      setRunningId(id);
      try {
        const result = await api.runNow(id);
        if (result.status === 'success') {
          toast.success(`Schedule "${id}" finished successfully! Output written to ${result.notePath}`);
        } else {
          toast.error(`Schedule "${id}" failed: ${result.error ?? 'Unknown error'}`);
        }
        await loadData();
      } catch (err) {
        toast.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRunningId(null);
      }
    },
    [api, loadData],
  );

  return (
    <ScheduledSessionsView
      config={config}
      schedules={schedules}
      loading={loading}
      saving={saving}
      runningId={runningId}
      onSaveConfig={handleSaveConfig}
      onPickFolder={handlePickFolder}
      onRunNow={handleRunNow}
    />
  );
}
