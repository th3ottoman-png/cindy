import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExpertAgent, ExpertEntry } from '@cindy/maker-core/experts';
import type { ImportedAgent } from '@cindy/maker-core/imported-agents';

import { makerToDbAgentKind } from '../../../shared/agentKindConversion';
import { patchVendorPrefs } from '@/state/newMakerDraft';

/**
 * New-task "Expert" picker for Hermes drafts (ROADMAP 3.2a). The pick is held by main as the
 * pending expert and bound to the next fresh Hermes session on its first send; the session
 * header then shows it. Experts are read from ~/.cindy-harness/experts; broken or non-Hermes
 * experts are listed but cannot be picked.
 *
 * When an expert with a configured `model:` is selected, it is automatically applied to the
 * draft model preference (resolving routing.yaml routes when present).
 */

export interface ExpertOption {
  slug: string;
  label: string;
  disabled: boolean;
  title: string;
}

/**
 * Resolves an expert's model preference: if the value matches a route name in routing.yaml,
 * returns the route's target model so the UI picker highlights the actual model row.
 * Otherwise returns the expert's model identifier directly.
 */
export function resolveExpertDraftModel(
  expertModel: string,
  routing?: { routes?: Record<string, { model?: string }> } | null,
): string {
  const trimmed = expertModel.trim();
  if (!trimmed) return '';
  if (routing?.routes && trimmed in routing.routes) {
    const routeModel = routing.routes[trimmed]?.model?.trim();
    if (routeModel) return routeModel;
  }
  return trimmed;
}

export function buildExpertOptions(
  entries: readonly ExpertEntry[],
  activeVendor: string = 'hermes',
): ExpertOption[] {
  return entries.map((entry) => {
    const expert = entry.expert;
    if (!expert) {
      return { slug: entry.slug, label: `${entry.slug} (broken)`, disabled: true, title: entry.error ?? 'cannot load' };
    }
    if (expert.agent !== activeVendor) {
      return {
        slug: entry.slug,
        label: `${expert.name} (${expert.agent})`,
        disabled: true,
        title: `Configured for ${expert.agent}; current agent is ${activeVendor}.`,
      };
    }
    const parts = [expert.description, expert.model ? `Model route: ${expert.model}` : '', entry.dir].filter(Boolean);
    return { slug: entry.slug, label: expert.name, disabled: false, title: parts.join('\n') };
  });
}

/**
 * ROADMAP 12.1: imported agents join the same picker. Fail closed — an agent that cannot run
 * on the active vendor is listed but unpickable, and the blocking tool is named. Its declared
 * `model:` is shown for information only; it is never applied to the draft.
 */
export function buildImportedAgentOptions(
  agents: readonly ImportedAgent[],
  activeVendor: string = 'hermes',
): ExpertOption[] {
  return agents.map((agent) => {
    if (agent.error) {
      return { slug: agent.id, label: `${agent.name} (broken)`, disabled: true, title: agent.error };
    }
    const label = `${agent.name} (imported · ${agent.source})`;
    if (!agent.runsOn.includes(activeVendor as ExpertAgent)) {
      const blocked = agent.blockedTools?.length ? ` Tools that block it: ${agent.blockedTools.join(', ')}.` : '';
      return { slug: agent.id, label, disabled: true, title: `Cannot run on ${activeVendor}.${blocked}` };
    }
    const parts = [
      agent.description,
      agent.declaredModel ? `Declared model: ${agent.declaredModel} (not mapped; the session keeps its own model)` : '',
      agent.absolutePath,
    ].filter(Boolean);
    return { slug: agent.id, label, disabled: false, title: parts.join('\n') };
  });
}

export function HermesExpertPickerView({
  options,
  value,
  onChange,
}: {
  options: readonly ExpertOption[];
  value: string | null;
  onChange: (slug: string | null) => void;
}) {
  if (options.length === 0) return null;
  const selected = options.find((o) => o.slug === value);
  return (
    <select
      data-testid="hermes-expert-picker"
      aria-label="Expert"
      title={selected?.title ?? 'Start this task as an expert (~/.cindy-harness/experts)'}
      className="h-7 max-w-[11rem] shrink-0 truncate rounded-md border border-[var(--border-default)] bg-transparent px-1.5 text-xs text-[var(--text-secondary)]"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">No expert</option>
      {options.map((o) => (
        <option key={o.slug} value={o.slug} disabled={o.disabled} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface HermesExpertPickerProps {
  /** The active agent vendor for the draft ('hermes', 'claude-code', 'codex', 'pi'). Default 'hermes'. */
  activeVendor?: string;
  /** Optional callback to notify parent view when expert's model route should be selected. */
  onSelectModel?: (model: string) => void;
  /** ROADMAP 12.1: the draft's working dir; project-scoped imported agents come from here. */
  projectDir?: string | null;
}

export function HermesExpertPicker({ activeVendor = 'hermes', onSelectModel, projectDir = null }: HermesExpertPickerProps = {}) {
  const [entries, setEntries] = useState<ExpertEntry[]>([]);
  const [imported, setImported] = useState<ImportedAgent[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [routing, setRouting] = useState<{ routes?: Record<string, { model?: string }> } | null>(null);
  const lastAppliedSlugRef = useRef<string | null>(null);

  useEffect(() => {
    const providers = window.electronAPI?.maker?.providers;
    if (!providers?.getRouting) return undefined;
    let alive = true;
    void providers.getRouting().then((r) => {
      if (alive && r && typeof r === 'object') setRouting(r);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const applyExpertModel = useCallback((
    slug: string | null,
    expertList: readonly ExpertEntry[],
    routingData: { routes?: Record<string, { model?: string }> } | null,
  ) => {
    if (!slug) return;
    const match = expertList.find((e) => e.slug === slug);
    const rawModel = match?.expert?.model?.trim();
    if (!rawModel) return;
    const resolved = resolveExpertDraftModel(rawModel, routingData);
    if (!resolved) return;
    if (onSelectModel) {
      onSelectModel(resolved);
    } else {
      // Vendor prefs are keyed by the DB form ('cc'), the picker filters on the maker form.
      patchVendorPrefs(makerToDbAgentKind(activeVendor) as any, { model: resolved });
    }
  }, [activeVendor, onSelectModel]);

  useEffect(() => {
    const experts = window.electronAPI?.maker?.experts;
    if (!experts) return undefined;
    let alive = true;
    void experts.list().then((list) => { if (alive) setEntries(list); }).catch(() => undefined);
    void experts.getPending().then((slug) => { if (alive) setPending(slug); }).catch(() => undefined);
    const offList = experts.onChanged((list) => setEntries(list));
    const offSession = experts.onSessionEvent((event) => {
      if (event.type === 'pending') setPending(event.slug);
    });
    return () => {
      alive = false;
      offList();
      offSession();
    };
  }, []);

  // ROADMAP 12.1: imported agents from the foreign directories (read-only).
  useEffect(() => {
    const api = window.electronAPI?.maker?.importedAgents;
    if (!api) return undefined;
    let alive = true;
    void api.list(projectDir).then((view) => { if (alive) setImported(view.agents); }).catch(() => undefined);
    const off = api.onChanged((view) => { if (alive) setImported(view.agents); });
    return () => {
      alive = false;
      off();
    };
  }, [projectDir]);

  // When pending expert loads or changes, auto-select its model into the draft if configured
  useEffect(() => {
    if (!pending) {
      lastAppliedSlugRef.current = null;
      return;
    }
    if (lastAppliedSlugRef.current === pending) return;
    const match = entries.find((e) => e.slug === pending);
    if (!match) return; // entries might still be loading
    lastAppliedSlugRef.current = pending;
    applyExpertModel(pending, entries, routing);
  }, [pending, entries, routing, applyExpertModel]);

  return (
    <HermesExpertPickerView
      options={[...buildExpertOptions(entries, activeVendor), ...buildImportedAgentOptions(imported, activeVendor)]}
      value={pending}
      onChange={(slug) => {
        setPending(slug);
        const experts = window.electronAPI?.maker?.experts;
        // The project dir rides the pick so project-scoped imported agents resolve after a restart.
        const call = projectDir ? experts?.setPending(slug, projectDir) : experts?.setPending(slug);
        void call?.catch(() => setPending(null));
        if (slug) {
          lastAppliedSlugRef.current = slug;
          applyExpertModel(slug, entries, routing);
        } else {
          lastAppliedSlugRef.current = null;
        }
      }}
    />
  );
}
