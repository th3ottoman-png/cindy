/**
 * New-agent form (ROADMAP 12.2). Maps 1:1 onto expert.md: name, description ("when should
 * other agents bring it in"), program, model route, conversations at once, working
 * instructions. Save writes through EXPERTS_SAVE create-from-form (owner-authored, atomic,
 * never overwrites). "Generate with model" hands the form contents to the 3.8 expert
 * creator as a brief; nothing is sent until the owner sends it.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { expertSlugFromName } from '@cindy/maker-core/expert-form';
import { EXPERT_AGENTS, type ExpertAgent } from '@cindy/maker-core/experts';

import { prefillExpertHandoffDraft } from '@/features/cc-agent/lib/startExpertHandoff';

import type { RosterRow } from './agentsRosterModel';

export interface NewAgentFormFields {
  name: string;
  description: string;
  agent: ExpertAgent;
  model: string;
  maxConcurrent: number;
  prompt: string;
}

const EMPTY: NewAgentFormFields = {
  name: '',
  description: '',
  agent: 'hermes',
  model: '',
  maxConcurrent: 1,
  prompt: '',
};

/** The brief handed to the expert creator (3.8) by "Generate with model". */
export function buildCreatorBrief(fields: NewAgentFormFields): string {
  return [
    'Create a new expert with these details (propose it as a draft; I will approve it):',
    `Name: ${fields.name.trim() || '(choose a good name)'}`,
    `When other agents should bring it in: ${fields.description.trim() || '(choose a good description)'}`,
    `Program: ${fields.agent}`,
    `Model route: ${fields.model.trim() || 'inherit the session model'}`,
    `Conversations at once: ${fields.maxConcurrent}`,
    '',
    'Working instructions:',
    fields.prompt.trim() || '(none yet — propose suitable instructions)',
  ].join('\n');
}

const FIELD_CLASS = 'w-full rounded-md border border-[var(--border-default)] bg-transparent px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]';
const LABEL_CLASS = 'flex flex-col gap-1 text-xs text-[var(--text-secondary)]';

export function NewAgentForm({
  rows,
  routes,
  workingDir,
  onClose,
  onSaved,
}: {
  rows: readonly RosterRow[];
  routes: Record<string, { provider?: string; model?: string }>;
  workingDir: string | null;
  onClose: () => void;
  onSaved: (slug: string) => void;
}) {
  const navigate = useNavigate();
  const [fields, setFields] = useState<NewAgentFormFields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const slug = useMemo(() => expertSlugFromName(fields.name), [fields.name]);
  const creatorAvailable = rows.some((r) => r.kind === 'expert' && r.slug === 'expert-creator' && !r.error);
  const patch = (part: Partial<NewAgentFormFields>): void => {
    setFields((current) => ({ ...current, ...part }));
    setResult(null);
  };

  const startFrom = (id: string): void => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    patch({
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      agent: row.kind === 'expert' && (EXPERT_AGENTS as readonly string[]).includes(row.program)
        ? (row.program as ExpertAgent)
        : 'hermes',
      model: row.kind === 'expert' ? row.model ?? '' : '',
    });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const res = await window.electronAPI.maker.experts.save({
        op: 'create-from-form',
        slug,
        fields: {
          name: fields.name,
          description: fields.description,
          agent: fields.agent,
          ...(fields.model.trim() ? { model: fields.model.trim() } : {}),
          ...(fields.maxConcurrent > 1 ? { maxConcurrent: fields.maxConcurrent } : {}),
          prompt: fields.prompt,
        },
      });
      if (res.ok) {
        onSaved(res.slug);
      } else {
        setResult({ ok: false, message: res.message });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const generate = async (): Promise<void> => {
    await window.electronAPI.maker.experts.setPending('expert-creator');
    prefillExpertHandoffDraft(buildCreatorBrief(fields));
    navigate('/cc-agent/new');
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-default)] p-4" data-testid="new-agent-form">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">New agent</h2>
        <button type="button" onClick={onClose} aria-label="Close form" className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
      </div>

      <label className={LABEL_CLASS}>
        Start from a role (optional)
        <select className={FIELD_CLASS} defaultValue="" onChange={(e) => startFrom(e.target.value)} data-testid="new-agent-start-from">
          <option value="">Blank</option>
          {rows.filter((r) => !r.error).map((r) => (
            <option key={r.id} value={r.id}>{r.name} ({r.source})</option>
          ))}
        </select>
      </label>

      <label className={LABEL_CLASS}>
        Name
        <input className={FIELD_CLASS} value={fields.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Code Reviewer" data-testid="new-agent-name" />
      </label>
      <p className="-mt-2 text-xs text-[var(--text-tertiary)]">Folder: ~/.cindy-harness/experts/{slug || '…'}</p>

      <label className={LABEL_CLASS}>
        When should other agents bring it in?
        <input className={FIELD_CLASS} value={fields.description} onChange={(e) => patch({ description: e.target.value })} placeholder="Reviews diffs for correctness and security" data-testid="new-agent-description" />
      </label>

      <label className={LABEL_CLASS}>
        Working instructions
        <textarea className={FIELD_CLASS} rows={6} value={fields.prompt} onChange={(e) => patch({ prompt: e.target.value })} placeholder="You are…" data-testid="new-agent-prompt" />
      </label>

      <div className="grid grid-cols-3 gap-3">
        <label className={LABEL_CLASS}>
          Program
          <select className={FIELD_CLASS} value={fields.agent} onChange={(e) => patch({ agent: e.target.value as ExpertAgent })} data-testid="new-agent-program">
            {EXPERT_AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          Model route
          <select className={FIELD_CLASS} value={fields.model} onChange={(e) => patch({ model: e.target.value })} data-testid="new-agent-model">
            <option value="">Inherit session model</option>
            {Object.keys(routes).sort().map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          Conversations at once
          <input
            className={FIELD_CLASS}
            type="number"
            min={1}
            step={1}
            value={fields.maxConcurrent}
            onChange={(e) => patch({ maxConcurrent: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            data-testid="new-agent-max-concurrent"
          />
        </label>
      </div>

      <p className="text-xs text-[var(--text-tertiary)]">
        Runs on: this computer{workingDir ? ` · ${workingDir}` : ' · no project folder picked'}
      </p>

      {result && (
        <p className={`text-xs ${result.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-danger,#d33)]'}`} data-testid="new-agent-result">
          {result.message}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !fields.name.trim()}
          className="rounded-md bg-[var(--bg-accent,#3b82f6)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          data-testid="new-agent-save"
        >
          {busy ? 'Saving…' : 'Save agent'}
        </button>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={!creatorAvailable}
          title={creatorAvailable ? 'Hand these details to the expert creator; you approve the draft' : 'Install the expert-creator starter expert to use this'}
          className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:opacity-50"
          data-testid="new-agent-generate"
        >
          Generate with model
        </button>
      </div>
    </div>
  );
}
