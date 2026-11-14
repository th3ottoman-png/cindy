/**
 * Settings -> Personalization -> Storage (ROADMAP 13.2b, ADR 0014).
 *
 * Read-only. Shows what the storage roots actually weigh, the retention setting, and a preview of
 * what housekeeping would reclaim. Nothing here deletes: the Prune action is 13.2c. The host scan
 * is local and deadline-bounded; this component never touches the filesystem itself.
 */

import { useCallback, useEffect, useState } from 'react';

import type { StorageView } from '../../../main/maker-ipc/housekeeping';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('StorageSection');

const MIN_RETENTION_DAYS = 7;

function formatAge(ms: number | undefined, now: number): string {
  if (!ms) return '—';
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-13 text-[var(--text-primary)]">{label}</span>
        {hint ? <span className="text-11 leading-[1.4] text-[var(--text-tertiary)]">{hint}</span> : null}
      </div>
      <span className="shrink-0 text-13 font-medium tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

export function StorageSection() {
  const [view, setView] = useState<StorageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState('30');
  const [showPreview, setShowPreview] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.electronAPI.maker.storage.scan();
      setView(next);
      setRetention(String(next.settings.retentionDays));
    } catch (err) {
      log.warn('storageScan failed', err);
      toast.error('Could not measure storage.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRetention = useCallback(async () => {
    const parsed = Number(retention);
    if (!Number.isFinite(parsed) || parsed < MIN_RETENTION_DAYS) {
      toast.error(`Retention must be at least ${MIN_RETENTION_DAYS} days.`);
      return;
    }
    setBusy(true);
    try {
      const next = await window.electronAPI.maker.storage.setRetention({ retentionDays: Math.floor(parsed) });
      setView(next);
      setRetention(String(next.settings.retentionDays));
      toast.success('Retention saved.');
    } catch (err) {
      log.warn('storageSetRetention failed', err);
      toast.error('Could not save retention.');
    } finally {
      setBusy(false);
    }
  }, [retention]);

  if (!view) {
    return (
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">Storage</h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {busy ? 'Measuring…' : 'Storage sizes are unavailable.'}
        </p>
      </div>
    );
  }

  const homes = view.sessionHomes;
  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">Storage</h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          What Cindy and Hermes keep on this machine. Measured locally, nothing is sent anywhere.
        </p>
      </div>

      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <p className="text-14 font-medium text-[var(--text-primary)]">On disk</p>
          <button
            type="button"
            onClick={() => { void load(); }}
            disabled={busy}
            className="shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-12 font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            {busy ? 'Measuring…' : 'Remeasure'}
          </button>
        </div>
        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />
        <Row
          label="Session homes"
          value={`${homes.count} · ${formatBytes(homes.totalBytes)}`}
          hint={`oldest ${formatAge(homes.oldestMs, view.scannedAt)}`}
        />
        <Row
          label="Orphan homes"
          value={`${view.orphanHomes.count} · ${formatBytes(view.orphanHomes.totalBytes)}`}
          hint="No session owns these; the startup reaper removes them after 24 h idle."
        />
        <Row
          label="Model catalog copies"
          value={`${view.modelCatalogCopies.count} · ${formatBytes(view.modelCatalogCopies.totalBytes)}`}
          hint="models_dev_cache.json in each home — re-downloaded on demand."
        />
        <Row label="Hermes cache" value={formatBytes(view.hermesCache.totalBytes)} hint={`uv package cache ${formatBytes(view.hermesUvCache.totalBytes)}`} />
        <Row label="Harness backups" value={`${view.harnessBackups.count} · ${formatBytes(view.harnessBackups.totalBytes)}`} hint="*.bak-* files and directories in ~/.cindy-harness" />
        <Row label="App logs" value={formatBytes(view.appLogs.totalBytes)} hint={`dev-terminal logs ${formatBytes(view.devTerminalLogs.totalBytes)}`} />
        {view.truncated ? (
          <p className="px-4 pb-3 text-12 leading-[1.5] text-[var(--text-warning,#a60)]">
            The scan hit its time limit, so these numbers are a lower bound. Remeasure to continue.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-4">
        <div className="flex flex-col gap-1">
          <p className="text-14 font-medium text-[var(--text-primary)]">Retention</p>
          <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">
            Homes and caches idle longer than this become eligible for housekeeping. A conversation's
            transcript is never removed, and open, running, scheduled or pinned sessions are always kept.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={MIN_RETENTION_DAYS}
            step={1}
            value={retention}
            onChange={(e) => { setRetention(e.target.value); }}
            aria-label="Retention in days"
            className="w-[90px] rounded-md border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-1.5 text-13 tabular-nums text-[var(--text-primary)]"
          />
          <span className="text-12 text-[var(--text-secondary)]">days (minimum {MIN_RETENTION_DAYS})</span>
          <button
            type="button"
            onClick={() => { void saveRetention(); }}
            disabled={busy}
            className="ml-auto shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-12 font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-14 font-medium text-[var(--text-primary)]">Reclaimable now</p>
            <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">
              {view.reclaimableItems} items · about {formatBytes(view.estimatedFreedBytes)} (a size estimate,
              not measured free space). Preview only — pruning is not enabled yet.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setShowPreview((v) => !v); }}
            disabled={view.preview.length === 0}
            className="shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-12 font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            {showPreview ? 'Hide list' : 'Show list'}
          </button>
        </div>
        {showPreview && view.preview.length > 0 ? (
          <>
            <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />
            <div className="flex max-h-[280px] flex-col overflow-y-auto">
              {view.preview.slice(0, 200).map((d) => (
                <div key={d.path} className="flex items-baseline justify-between gap-3 px-4 py-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-12 text-[var(--text-primary)]" title={d.path}>{d.path}</span>
                    <span className="text-11 leading-none text-[var(--text-tertiary)]">{d.reason}</span>
                  </div>
                  <span className="shrink-0 text-12 tabular-nums text-[var(--text-secondary)]">{formatBytes(d.sizeBytes)}</span>
                </div>
              ))}
            </div>
            {view.preview.length > 200 ? (
              <p className="px-4 pb-3 text-11 text-[var(--text-tertiary)]">
                Showing the first 200 of {view.preview.length} items.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
