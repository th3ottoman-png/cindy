import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExpertEntry } from '@cindy/maker-core/experts';

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
}

export function HermesExpertPicker({ activeVendor = 'hermes', onSelectModel }: HermesExpertPickerProps = {}) {
  const [entries, setEntries] = useState<ExpertEntry[]>([]);
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
      patchVendorPrefs(activeVendor as any, { model: resolved });
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
      options={buildExpertOptions(entries, activeVendor)}
      value={pending}
      onChange={(slug) => {
        setPending(slug);
        void window.electronAPI?.maker?.experts.setPending(slug).catch(() => setPending(null));
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
