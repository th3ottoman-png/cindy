/**
 * Squads tab (ROADMAP 12.4b, ADR 0012): saved teams under ~/.cindy-harness/squads. List, create /
 * edit (atomic write through the host), delete, and Launch. Launch resolves a fail-closed plan
 * (unknown roster ids and non-Hermes entries refuse), makes the lead the pending pick, prefills a
 * new Hermes lead task with the member mentions + task, and opens it. The owner sends it; the
 * unchanged 12.3 send boundary joins each member as an Orca worker. Nothing starts on its own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { SquadView } from '../../../main/maker-ipc/squads';
import { toast } from '@/lib/toast';

import { prefillSquadLaunchDraft } from '../cc-agent/lib/startExpertHandoff';
import type { RosterRow } from './agentsRosterModel';

const INPUT_CLASS = 'w-full rounded-md border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]';

interface SquadFormState {
  name: string;
  description: string;
  lead: string;
  members: string[];
  workerPermissionMode: 'auto' | 'bypassPermissions';
  maxTurns: number;
}

const EMPTY_FORM: SquadFormState = {
  name: '',
  description: '',
  lead: '',
  members: [],
  workerPermissionMode: 'bypassPermissions',
  maxTurns: 40,
};

function isHermesRow(row: RosterRow): boolean {
  if (row.error) return false;
  return row.kind === 'expert' ? row.program === 'hermes' : (row.runsOn?.includes('hermes') ?? false);
}

export function SquadsTab({ rows, workingDir }: { rows: readonly RosterRow[]; workingDir: string | null }) {
  const navigate = useNavigate();
  const [squads, setSquads] = useState<SquadView[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [form, setForm] = useState<SquadFormState>(EMPTY_FORM);
  const [notice, setNotice] = useState<string | null>(null);
  const [launchSlug, setLaunchSlug] = useState<string | null>(null);
  const [launchTask, setLaunchTask] = useState('');
  const [busy, setBusy] = useState(false);

  const hermesRows = useMemo(() => rows.filter(isHermesRow), [rows]);

  useEffect(() => {
    const api = window.electronAPI?.maker?.squads;
    if (!api) return undefined;
    let alive = true;
    void api.list().then((view) => { if (alive) setSquads(view.squads); }).catch(() => undefined);
    const off = api.onChanged((view) => { if (alive) setSquads(view.squads); });
    return () => { alive = false; off(); };
  }, []);

  const openCreate = useCallback(() => {
    setEditingSlug(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setNotice(null);
    setLaunchSlug(null);
  }, []);

  const openEdit = useCallback((squad: SquadView) => {
    setEditingSlug(squad.slug);
    setForm({
      name: squad.name,
      description: squad.description,
      lead: squad.lead,
      members: [...squad.members],
      workerPermissionMode: squad.workerPermissionMode === 'auto' ? 'auto' : 'bypassPermissions',
      maxTurns: squad.maxTurns || 40,
    });
    setFormOpen(true);
    setNotice(null);
    setLaunchSlug(null);
  }, []);

  const save = useCallback(async () => {
    const api = window.electronAPI?.maker?.squads;
    if (!api) return;
    setBusy(true);
    try {
      const request = editingSlug
        ? { op: 'edit', slug: editingSlug, fields: form }
        : { op: 'create', fields: form };
      const res = await api.save(request);
      if (!res.ok) {
        setNotice(res.message);
        return;
      }
      setFormOpen(false);
      setEditingSlug(null);
      setNotice(editingSlug ? `Saved "~/.cindy-harness/squads/${res.slug}". Hand-edit the file any time.` : `Created "~/.cindy-harness/squads/${res.slug}".`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [editingSlug, form]);

  const remove = useCallback(async (slug: string) => {
    const api = window.electronAPI?.maker?.squads;
    if (!api) return;
    const res = await api.save({ op: 'delete', slug });
    if (!res.ok) toast.error(res.message);
  }, []);

  const launch = useCallback(async (slug: string) => {
    const api = window.electronAPI?.maker?.squads;
    const experts = window.electronAPI?.maker?.experts;
    if (!api || !experts) return;
    setBusy(true);
    try {
      const res = await api.resolveLaunch(slug, workingDir, launchTask);
      if (!res.ok) {
        setNotice(res.errors.join(' '));
        return;
      }
      // The lead becomes the pending pick; the first send binds it (3.2). Members join at send
      // through the unchanged 12.3 boundary. Nothing starts here.
      await experts.setPending(res.plan.leadBindingId, workingDir);
      prefillSquadLaunchDraft(res.plan, workingDir);
      navigate('/cc-agent/new');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [workingDir, launchTask, navigate]);

  const toggleMember = useCallback((id: string) => {
    setForm((f) => ({
      ...f,
      members: f.members.includes(id) ? f.members.filter((m) => m !== id) : [...f.members, id],
    }));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="squads-tab">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <span className="text-xs text-[var(--text-tertiary)]">{squads.length} squads</span>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-md bg-[var(--bg-accent,#3b82f6)] px-3 py-1.5 text-sm text-white"
          data-testid="squads-new"
        >
          New squad
        </button>
      </div>

      {notice && <p className="px-4 pb-2 text-xs text-[var(--text-secondary)]" data-testid="squads-notice">{notice}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {formOpen && (
          <div className="mb-4 rounded-lg border border-[var(--border-default)] p-3" data-testid="squad-form">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                Name
                <input className={INPUT_CLASS} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid="squad-form-name" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                Lead (Hermes)
                <select className={INPUT_CLASS} value={form.lead} onChange={(e) => setForm((f) => ({ ...f, lead: e.target.value }))} data-testid="squad-form-lead">
                  <option value="">Pick a lead…</option>
                  {hermesRows.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.id})</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)] sm:col-span-2">
                Description
                <input className={INPUT_CLASS} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} data-testid="squad-form-description" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                Worker permission ceiling
                <select className={INPUT_CLASS} value={form.workerPermissionMode} onChange={(e) => setForm((f) => ({ ...f, workerPermissionMode: e.target.value === 'auto' ? 'auto' : 'bypassPermissions' }))} data-testid="squad-form-mode">
                  <option value="bypassPermissions">Full access (bypassPermissions)</option>
                  <option value="auto">Auto (refused for Hermes workers)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                Max turns
                <input className={INPUT_CLASS} type="number" min={1} max={200} value={form.maxTurns} onChange={(e) => setForm((f) => ({ ...f, maxTurns: Number(e.target.value) }))} data-testid="squad-form-max-turns" />
              </label>
            </div>
            <fieldset className="mt-2 flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <legend>Members (Hermes)</legend>
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-[var(--border-default)] p-2" data-testid="squad-form-members">
                {hermesRows.length === 0 && <span className="text-[var(--text-tertiary)]">No Hermes-runnable agents in the roster.</span>}
                {hermesRows.map((r) => (
                  <label key={r.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={form.members.includes(r.id)} onChange={() => toggleMember(r.id)} disabled={r.id === form.lead} />
                    <span className="text-[var(--text-primary)]">{r.name}</span>
                    <span className="text-[var(--text-tertiary)]">{r.id}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => { void save(); }} disabled={busy} className="rounded-md bg-[var(--bg-accent,#3b82f6)] px-3 py-1.5 text-sm text-white disabled:opacity-50" data-testid="squad-form-save">
                {editingSlug ? 'Save' : 'Create'}
              </button>
              <button type="button" onClick={() => { setFormOpen(false); setEditingSlug(null); }} className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)]" data-testid="squad-form-cancel">
                Cancel
              </button>
            </div>
          </div>
        )}

        {squads.length === 0 && !formOpen ? (
          <p className="py-8 text-center text-sm text-[var(--text-tertiary)]">No squads yet. Create one to launch a saved team.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2">
            {squads.map((squad) => (
              <div key={squad.slug} className="flex flex-col gap-1 rounded-lg border border-[var(--border-default)] p-3" data-testid={`squad-card-${squad.slug}`}>
                <span className="truncate text-sm text-[var(--text-primary)]">{squad.name}</span>
                <span className="line-clamp-2 min-h-[2em] text-xs text-[var(--text-secondary)]">{squad.description || squad.error || ''}</span>
                <span className="flex flex-wrap gap-1 text-xs">
                  <span className="rounded bg-[var(--bg-subtle,rgba(127,127,127,0.12))] px-1.5 py-0.5 text-[var(--text-secondary)]">lead: {squad.lead || '—'}</span>
                  <span className="rounded bg-[var(--bg-subtle,rgba(127,127,127,0.12))] px-1.5 py-0.5 text-[var(--text-tertiary)]">{squad.members.length} members</span>
                  {squad.error && <span className="rounded px-1.5 py-0.5 text-[var(--text-danger,#d33)]">error</span>}
                </span>
                {launchSlug === squad.slug ? (
                  <div className="mt-1 flex flex-col gap-1" data-testid={`squad-launch-${squad.slug}`}>
                    <textarea
                      className={INPUT_CLASS}
                      rows={2}
                      placeholder="Task for the squad (optional)"
                      value={launchTask}
                      onChange={(e) => setLaunchTask(e.target.value)}
                      data-testid={`squad-launch-task-${squad.slug}`}
                    />
                    <div className="flex gap-2">
                      <button type="button" disabled={busy} onClick={() => { void launch(squad.slug); }} className="rounded-md bg-[var(--bg-accent,#3b82f6)] px-2 py-1 text-xs text-white disabled:opacity-50" data-testid={`squad-launch-confirm-${squad.slug}`}>
                        Open lead task
                      </button>
                      <button type="button" onClick={() => { setLaunchSlug(null); setLaunchTask(''); }} className="rounded-md border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 flex gap-2">
                    <button type="button" disabled={Boolean(squad.error)} onClick={() => { setLaunchSlug(squad.slug); setLaunchTask(''); setNotice(null); }} className="rounded-md bg-[var(--bg-accent,#3b82f6)] px-2 py-1 text-xs text-white disabled:opacity-50" data-testid={`squad-launch-open-${squad.slug}`}>
                      Launch
                    </button>
                    <button type="button" onClick={() => openEdit(squad)} className="rounded-md border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)]" data-testid={`squad-edit-${squad.slug}`}>
                      Edit
                    </button>
                    <button type="button" onClick={() => { void remove(squad.slug); }} className="rounded-md border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-danger,#d33)]" data-testid={`squad-delete-${squad.slug}`}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
