/**
 * Agent detail drawer (ROADMAP 12.2): prompt preview, file path, Reveal in Finder,
 * Edit (experts → the Settings editor, which stays) and Copy to my experts (imported →
 * the 12.1 copy path; never overwrites a slug).
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { RosterRow } from './agentsRosterModel';

const EXPERT_SETTINGS = '/settings?tab=general&section=settings-experts';

export function AgentDetailDrawer({ row, onClose }: { row: RosterRow; onClose: () => void }) {
  const navigate = useNavigate();
  const [copyResult, setCopyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async (): Promise<void> => {
    setBusy(true);
    setCopyResult(null);
    try {
      const res = await window.electronAPI.maker.importedAgents.copyToExpert(row.id);
      setCopyResult(res.ok
        ? { ok: true, message: `Copied to ~/.cindy-harness/experts/${res.slug}. Edit it there to add tools or a model route.` }
        : { ok: false, message: res.message });
    } catch (err) {
      setCopyResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-[26rem] max-w-full shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border-default)] p-4" data-testid="agent-detail-drawer">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-[var(--text-primary)]">{row.name}</h2>
          <p className="mt-0.5 flex flex-wrap gap-1 text-xs">
            <span className="rounded bg-[var(--bg-subtle,rgba(127,127,127,0.12))] px-1.5 py-0.5 text-[var(--text-secondary)]">{row.source}</span>
            <span className="rounded bg-[var(--bg-subtle,rgba(127,127,127,0.12))] px-1.5 py-0.5 text-[var(--text-secondary)]">{row.program}</span>
            {row.maxConcurrent !== undefined && row.maxConcurrent > 1 && (
              <span className="rounded bg-[var(--bg-subtle,rgba(127,127,127,0.12))] px-1.5 py-0.5 text-[var(--text-secondary)]">max {row.maxConcurrent} at once</span>
            )}
            {row.error && <span className="rounded px-1.5 py-0.5 text-[var(--text-danger,#d33)]">error</span>}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
      </div>

      {row.description && <p className="text-xs text-[var(--text-secondary)]">{row.description}</p>}
      {row.error && <p className="text-xs text-[var(--text-danger,#d33)]" data-testid="agent-detail-error">{row.error}</p>}
      {row.blockedTools && row.blockedTools.length > 0 && (
        <p className="text-xs text-[var(--text-secondary)]">Not runnable on Hermes: {row.blockedTools.join(', ')}</p>
      )}

      <div className="min-h-0 flex-1">
        <p className="mb-1 text-xs text-[var(--text-tertiary)]">Prompt</p>
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-[var(--border-default)] p-2 text-xs text-[var(--text-secondary)]" data-testid="agent-detail-prompt">
          {row.prompt || '(empty)'}
        </pre>
      </div>

      <p className="break-all text-xs text-[var(--text-tertiary)]" data-testid="agent-detail-path">{row.path}</p>

      {copyResult && (
        <p className={`text-xs ${copyResult.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-danger,#d33)]'}`} data-testid="agent-copy-result">
          {copyResult.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void window.electronAPI.showItemInFolder({ filePath: row.path })}
          className="rounded-md border border-[var(--border-default)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
          data-testid="agent-detail-reveal"
        >
          Reveal in Finder
        </button>
        {row.kind === 'expert' ? (
          <button
            type="button"
            onClick={() => navigate(EXPERT_SETTINGS)}
            className="rounded-md border border-[var(--border-default)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
            data-testid="agent-detail-edit"
          >
            Edit
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void copy()}
            disabled={busy || Boolean(row.error)}
            className="rounded-md border border-[var(--border-default)] px-2.5 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-50"
            data-testid="agent-detail-copy"
          >
            {busy ? 'Copying…' : 'Copy to my experts'}
          </button>
        )}
      </div>
    </aside>
  );
}
