import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Copy, Pencil, Plus, Trash2, Users } from 'lucide-react';

import type {
  ExpertEditExtras,
  ExpertEditFields,
  ExpertNotesSource,
} from '@cindy/maker-core/expert-draft';
import type { ExpertEntry } from '@cindy/maker-core/experts';

import { Button } from '@/components/ui/button';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

/**
 * Settings expert editor (ROADMAP 3.3). Lists ~/.cindy-harness/experts (broken experts with
 * their error), and creates, duplicates and edits them through one main-process RPC that writes
 * the files atomically. The files win: a clean form reloads when expert.md changes on disk; a
 * form with unsaved edits is told, and main refuses its save until it is reloaded.
 */

export interface ExpertForm {
  name: string;
  description: string;
  model: string;
  /** Comma-separated. */
  tags: string;
  memory: boolean;
  prompt: string;
}

export function formFromFields(fields: ExpertEditFields): ExpertForm {
  return {
    name: fields.name,
    description: fields.description,
    model: fields.model ?? '',
    tags: fields.tags.join(', '),
    memory: fields.memory,
    prompt: fields.prompt,
  };
}

export function fieldsFromForm(form: ExpertForm): ExpertEditFields {
  const model = form.model.trim();
  return {
    name: form.name,
    description: form.description,
    ...(model ? { model } : {}),
    tags: form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    memory: form.memory,
    prompt: form.prompt,
  };
}

const EMPTY_FORM: ExpertForm = {
  name: '',
  description: '',
  model: '',
  tags: '',
  memory: false,
  prompt: '',
};

/** Kebab-case folder name from a display name, not clashing with `taken`. */
export function uniqueExpertSlug(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56)
      .replace(/-+$/, '') || 'expert';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** What to do with an open form when the experts folder changed on disk. */
export function decideExternalChange(input: {
  dirty: boolean;
  openHash: string;
  /** Hash of expert.md now, or null when it no longer loads. */
  diskHash: string | null;
}): 'unchanged' | 'reload' | 'conflict' {
  if (input.diskHash === input.openHash) return 'unchanged';
  return input.dirty ? 'conflict' : 'reload';
}

/**
 * The expert's memory.md (ROADMAP 3.4b), read-only. The expert appends through its one tool;
 * the owner edits the file by hand, so the path is shown and nothing here writes it.
 */
export function ExpertMemoryNotes({
  notes,
  memory,
}: {
  notes: ExpertNotesSource;
  memory: boolean;
}) {
  return (
    <div className="flex flex-col gap-1" data-testid="expert-memory-notes">
      <span className="text-12 font-medium text-[var(--text-secondary)]">Memory notes</span>
      {notes.text ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--bg-card)] px-2.5 py-2 font-mono text-11 leading-[1.5] text-[var(--text-primary)]">
          {notes.text}
        </pre>
      ) : (
        <span className="text-12 text-[var(--text-tertiary)]">
          {memory
            ? 'No notes yet. The expert adds them during its sessions.'
            : 'Memory is off; no notes are kept.'}
        </span>
      )}
      {memory || notes.text ? (
        <span className="text-11 text-[var(--text-tertiary)]">
          {`Read-only here. Edit by hand: ${notes.file}`}
          {memory ? '' : ' (memory is off, so these notes are not used)'}
        </span>
      ) : null}
    </div>
  );
}

export function ExpertListView({
  entries,
  selected,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  entries: readonly ExpertEntry[];
  selected: string | null;
  onEdit: (slug: string) => void;
  onDuplicate: (slug: string) => void;
  onDelete: (slug: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-3 text-12 text-[var(--text-tertiary)]">
        No experts yet. Create one, or copy a folder from{' '}
        <code className="font-mono">docs/experts-examples/</code>.
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {entries.map((entry) => {
        const expert = entry.expert;
        return (
          <li
            key={entry.slug}
            className={cn(
              'flex items-start justify-between gap-3 px-4 py-2.5',
              selected === entry.slug && 'bg-[var(--settings-menu-bg)]',
            )}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-13 font-medium text-[var(--text-primary)]">
                {expert ? expert.name : entry.slug}
                <span className="ml-2 font-mono text-11 text-[var(--text-tertiary)]">
                  {entry.slug}
                </span>
              </span>
              {expert ? (
                <span className={SETTINGS_ROW_HINT_CLASS}>
                  {[
                    expert.description,
                    expert.model ? `model: ${expert.model}` : '',
                    expert.agent !== 'hermes' ? `agent: ${expert.agent}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No description'}
                </span>
              ) : (
                <span className="flex flex-col gap-0.5 text-12 text-red-500">
                  <span className="flex items-center gap-1">
                    <AlertTriangle size={12} aria-hidden="true" />
                    {entry.error ?? 'cannot load'}
                  </span>
                  <span className="font-mono text-11 text-[var(--text-tertiary)]">
                    Fix by hand: {`${entry.dir}/expert.md`}
                  </span>
                </span>
              )}
            </div>
            <div className="flex shrink-0 gap-1.5">
              {expert ? (
                <>
                  <Button
                    variant="secondary"
                    size="xs"
                    data-testid={`expert-edit-${entry.slug}`}
                    onClick={() => onEdit(entry.slug)}
                    aria-label={`Edit ${expert.name}`}
                  >
                    <Pencil size={12} aria-hidden="true" /> Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    data-testid={`expert-duplicate-${entry.slug}`}
                    onClick={() => onDuplicate(entry.slug)}
                    aria-label={`Duplicate ${expert.name}`}
                  >
                    <Copy size={12} aria-hidden="true" /> Duplicate
                  </Button>
                </>
              ) : null}
              <Button
                variant="secondary"
                tone="danger"
                size="xs"
                data-testid={`expert-delete-${entry.slug}`}
                onClick={() => onDelete(entry.slug)}
                aria-label={`Delete ${expert ? expert.name : entry.slug}`}
              >
                <Trash2 size={12} aria-hidden="true" /> Delete
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const INPUT_CLASS =
  'h-8 w-full rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--bg-card)] px-2.5 text-12 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]';

type Editing =
  | { kind: 'create'; slug: string; form: ExpertForm }
  | {
      kind: 'edit';
      slug: string;
      file: string;
      baseHash: string;
      form: ExpertForm;
      dirty: boolean;
      extras: ExpertEditExtras;
      notes: ExpertNotesSource;
      stale: boolean;
    };

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-12 font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
      {hint ? <span className="text-11 text-[var(--text-tertiary)]">{hint}</span> : null}
    </label>
  );
}

export function ExpertsSection() {
  const confirmDialog = useOptionalConfirmDialog();
  const [entries, setEntries] = useState<ExpertEntry[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;

  const api = window.electronAPI?.maker?.experts;

  const openEdit = useCallback(
    async (slug: string) => {
      if (!api) return;
      const res = await api.read(slug);
      setError(null);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setEditing({
        kind: 'edit',
        slug,
        file: res.file,
        baseHash: res.hash,
        form: formFromFields(res.fields),
        dirty: false,
        extras: res.extras,
        notes: res.notes,
        stale: false,
      });
    },
    [api],
  );

  // The files win: on any change under the experts folder, re-read the open expert.
  const onExternalChange = useCallback(async () => {
    const current = editingRef.current;
    if (!api || !current || current.kind !== 'edit') return;
    const res = await api.read(current.slug);
    const latest = editingRef.current;
    if (!latest || latest.kind !== 'edit' || latest.slug !== current.slug) return;
    const action = decideExternalChange({
      dirty: latest.dirty,
      openHash: latest.baseHash,
      diskHash: res.ok ? res.hash : null,
    });
    if (action === 'reload') {
      if (res.ok) {
        setEditing({
          ...latest,
          baseHash: res.hash,
          form: formFromFields(res.fields),
          extras: res.extras,
          notes: res.notes,
          stale: false,
        });
        toast.info(`Reloaded ${latest.slug} from disk`);
      } else {
        setEditing(null);
        setError(res.message);
      }
    } else if (action === 'conflict') {
      setEditing({ ...latest, stale: true, ...(res.ok ? { notes: res.notes } : {}) });
    } else if (res.ok && res.notes.text !== latest.notes.text) {
      // A memory note was appended (or hand-edited); expert.md itself is unchanged.
      setEditing({ ...latest, notes: res.notes });
    }
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    let alive = true;
    void api
      .list()
      .then((list) => {
        if (alive) setEntries(list);
      })
      .catch(() => undefined);
    const off = api.onChanged((list) => {
      setEntries(list);
      void onExternalChange();
    });
    return () => {
      alive = false;
      off();
    };
  }, [api, onExternalChange]);

  const update = (patch: Partial<ExpertForm>) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const form = { ...prev.form, ...patch };
      return prev.kind === 'edit' ? { ...prev, form, dirty: true } : { ...prev, form };
    });
  };

  const handleDuplicate = async (slug: string) => {
    if (!api) return;
    const source = entries.find((e) => e.slug === slug)?.expert;
    if (!source) return;
    const name = `${source.name} (copy)`;
    const newSlug = uniqueExpertSlug(
      name,
      entries.map((e) => e.slug),
    );
    const res = await api.save({ op: 'duplicate', from: slug, slug: newSlug, name });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    toast.success(`Duplicated to ${res.dir}`);
    await openEdit(newSlug);
  };

  const handleDelete = async (slug: string) => {
    if (!api) return;
    const targetName = entries.find((e) => e.slug === slug)?.expert?.name ?? slug;
    const confirmed = confirmDialog
      ? await confirmDialog.confirm({
          title: `Delete expert "${targetName}"?`,
          description: `This permanently removes ~/.cindy-harness/experts/${slug}. This action cannot be undone.`,
          confirmText: 'Delete',
          cancelText: 'Cancel',
          confirmVariant: 'destructive',
        })
      : true;
    if (!confirmed) return;
    try {
      const res = await api.save({ op: 'delete', slug });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast.success(`Deleted expert "${targetName}"`);
      if (editing?.slug === slug) {
        setEditing(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSave = async () => {
    if (!api || !editing) return;
    setSaving(true);
    setError(null);
    try {
      const fields = fieldsFromForm(editing.form);
      const res =
        editing.kind === 'create'
          ? await api.save({
              op: 'create',
              slug:
                editing.slug.trim() ||
                uniqueExpertSlug(
                  editing.form.name,
                  entries.map((e) => e.slug),
                ),
              fields,
            })
          : await api.save({ op: 'edit', slug: editing.slug, baseHash: editing.baseHash, fields });
      if (!res.ok) {
        if (res.reason === 'conflict' && editing.kind === 'edit')
          setEditing({ ...editing, stale: true });
        setError(res.message);
        return;
      }
      toast.success(`Saved ${res.file}`);
      if (editing.kind === 'create') await openEdit(res.slug);
      else setEditing({ ...editing, baseHash: res.hash, dirty: false, stale: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!api) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="settings-experts">
      <div className="flex items-center justify-between">
        <h2 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
          <Users size={16} aria-hidden="true" /> Experts
        </h2>
        <Button
          variant="secondary"
          size="sm"
          className="h-8 text-12"
          data-testid="expert-create"
          onClick={() => {
            setError(null);
            setEditing({ kind: 'create', slug: '', form: { ...EMPTY_FORM } });
          }}
        >
          <Plus size={14} aria-hidden="true" /> New expert
        </Button>
      </div>
      <p className={SETTINGS_ROW_HINT_CLASS}>
        Files in{' '}
        <code className="font-mono">~/.cindy-harness/experts/&lt;folder&gt;/expert.md</code>. Hand
        edits are picked up live and always win over this editor.
      </p>

      <div className={SETTINGS_CARD_CLASS}>
        <ExpertListView
          entries={entries}
          selected={editing?.kind === 'edit' ? editing.slug : null}
          onEdit={(slug) => void openEdit(slug)}
          onDuplicate={(slug) => void handleDuplicate(slug)}
          onDelete={(slug) => void handleDelete(slug)}
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-500/40 px-3 py-2 text-12 text-red-500"
        >
          {error}
        </div>
      ) : null}

      {editing ? (
        <div className={cn(SETTINGS_CARD_CLASS, 'gap-3 px-4 py-4')} data-testid="expert-editor">
          <div className="flex items-center justify-between gap-3">
            <span className={SETTINGS_ROW_LABEL_CLASS}>
              {editing.kind === 'create' ? 'New expert' : `Edit ${editing.slug}`}
            </span>
            {editing.kind === 'edit' ? (
              <code className="truncate font-mono text-11 text-[var(--text-tertiary)]">
                {editing.file}
              </code>
            ) : null}
          </div>

          {editing.kind === 'edit' && editing.stale ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/50 px-3 py-2 text-12"
            >
              <span>
                expert.md changed on disk. Saving is refused until you reload it; your unsaved
                changes here will be lost.
              </span>
              <Button
                variant="secondary"
                size="xs"
                data-testid="expert-reload"
                onClick={() => void openEdit(editing.slug)}
              >
                Reload from disk
              </Button>
            </div>
          ) : null}

          {editing.kind === 'create' ? (
            <Field
              label="Folder name"
              hint="Lowercase letters, digits and dashes. Left empty, it is made from the name."
            >
              <input
                className={cn(INPUT_CLASS, 'font-mono')}
                value={editing.slug}
                placeholder={uniqueExpertSlug(
                  editing.form.name,
                  entries.map((e) => e.slug),
                )}
                onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
              />
            </Field>
          ) : null}
          <Field label="Name">
            <input
              className={INPUT_CLASS}
              value={editing.form.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Field label="Description" hint="One line saying what the expert does.">
            <input
              className={INPUT_CLASS}
              value={editing.form.description}
              onChange={(e) => update({ description: e.target.value })}
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Model route (optional)">
              <input
                className={cn(INPUT_CLASS, 'font-mono')}
                value={editing.form.model}
                placeholder="session model"
                onChange={(e) => update({ model: e.target.value })}
              />
            </Field>
            <Field label="Tags (comma-separated)">
              <input
                className={INPUT_CLASS}
                value={editing.form.tags}
                onChange={(e) => update({ tags: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={editing.form.memory}
              onCheckedChange={(v) => update({ memory: v })}
              aria-label="Expert memory"
            />
            <span className="text-12 text-[var(--text-secondary)]">
              Memory (append-only notes in memory.md)
            </span>
          </div>
          <Field label="System prompt">
            <textarea
              className={cn(INPUT_CLASS, 'h-64 py-2 font-mono leading-[1.5]')}
              value={editing.form.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
            />
          </Field>
          {editing.kind === 'edit' ? (
            <ExpertMemoryNotes notes={editing.notes} memory={editing.form.memory} />
          ) : null}
          <span className="text-11 text-[var(--text-tertiary)]">
            {editing.kind === 'edit'
              ? `Kept as written in the file: agent ${editing.extras.agent}${
                  editing.extras.temperature !== undefined
                    ? `, temperature ${editing.extras.temperature}`
                    : ''
                }${editing.extras.tools.length ? `, tools [${editing.extras.tools.join(', ')}]` : ''}${
                  editing.extras.skills.length
                    ? `, skills [${editing.extras.skills.join(', ')}]`
                    : ''
                }. Edit the file for these.`
              : 'New experts run on Hermes with no extra tools; add tools by editing the file.'}
          </span>

          <div className={SETTINGS_ROW_DIVIDER_CLASS} />
          <div className="flex items-center justify-between gap-2">
            {editing.kind === 'edit' ? (
              <Button
                variant="secondary"
                tone="danger"
                size="sm"
                className="h-8 text-12"
                data-testid="expert-edit-delete"
                onClick={() => void handleDelete(editing.slug)}
              >
                <Trash2 size={12} aria-hidden="true" /> Delete expert
              </Button>
            ) : <div />}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="h-8 text-12"
                onClick={() => setEditing(null)}
              >
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="h-8 text-12"
                data-testid="expert-save"
                disabled={saving || (editing.kind === 'edit' && (editing.stale || !editing.dirty))}
                onClick={() => void handleSave()}
              >
                {editing.kind === 'create' ? 'Create' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
