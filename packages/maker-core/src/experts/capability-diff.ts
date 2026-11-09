/**
 * capability-diff — ROADMAP 8.3 "Capability diff on the 7.2 chip".
 * ---------------------------------------------------------------------------
 * Pure, deterministic comparison of two capability sets, so a suggestion can
 * say what switching would change before the owner clicks. No blind switches.
 *
 * Contract:
 * - No I/O, no clock, no network, no model call. Same input, same output.
 * - Kinds are open strings. The phrase table is DATA, so a new kind renders
 *   with its own slug instead of needing a branch in a switch statement.
 * - Descriptors come from `@cindy/maker-core/extensions`, so the diff and the
 *   8.1 Capabilities hub speak the same language.
 */

import type { CapabilityDescriptor } from '../extensions/registry.js';

/** The facts an expert file exposes that can change what a session may do. */
export interface ExpertCapabilityFacts {
  slug: string;
  name?: string;
  dir?: string;
  model?: string;
  tools?: readonly string[];
  toolsets?: readonly string[];
  /** Skill names declared in `expert.md` frontmatter. */
  skills?: readonly string[];
  /** Absolute `skills/<name>/SKILL.md` paths the loader found on disk. */
  skillFiles?: readonly string[];
  toolsFile?: string;
}

export const EXPERT_KIND = 'expert';
export const TOOL_KIND = 'tool';
export const TOOLSET_KIND = 'toolset';
export const SKILL_KIND = 'skill';
export const MODEL_ROUTE_KIND = 'model-route';

/**
 * Human label per kind. Unknown kinds fall back to the slug itself, which keeps
 * a new source visible without editing this table.
 */
export const KIND_PHRASE_LABELS: Readonly<Record<string, string>> = {
  [TOOL_KIND]: 'tool',
  [TOOLSET_KIND]: 'toolset lock',
  [SKILL_KIND]: 'skill',
  [MODEL_ROUTE_KIND]: 'model',
  connector: 'connector',
  'mcp-server': 'MCP server',
  'vault-note': 'pinned note',
  plugin: 'plugin',
  [EXPERT_KIND]: 'expert',
};

/** Phrase order. Special-cased kinds come first so the summary reads naturally. */
export const KIND_PHRASE_ORDER: readonly string[] = [
  TOOL_KIND,
  TOOLSET_KIND,
  MODEL_ROUTE_KIND,
  SKILL_KIND,
];

/** Kinds whose change is already stated by the chip title, so they get no phrase. */
export const KINDS_WITHOUT_PHRASE: readonly string[] = [EXPERT_KIND];

export interface CapabilityDiffGroup {
  kind: string;
  added: CapabilityDescriptor[];
  removed: CapabilityDescriptor[];
}

export interface ModelRouteChange {
  before: string | null;
  after: string | null;
  changed: boolean;
}

export type ToolsetLockState = 'none' | 'unchanged' | 'added' | 'dropped' | 'changed';

export interface ToolsetLockChange {
  before: string[];
  after: string[];
  state: ToolsetLockState;
}

export interface CapabilityDiff {
  groups: CapabilityDiffGroup[];
  added: CapabilityDescriptor[];
  removed: CapabilityDescriptor[];
  keptIds: string[];
  model: ModelRouteChange;
  toolsetLock: ToolsetLockChange;
  phrases: string[];
  summary: string;
}

function keyOf(descriptor: CapabilityDescriptor): string {
  return `${descriptor.kind}:${descriptor.id}`;
}

function uniqueByKey(
  descriptors: readonly CapabilityDescriptor[],
): Map<string, CapabilityDescriptor> {
  const map = new Map<string, CapabilityDescriptor>();
  for (const descriptor of descriptors ?? []) {
    if (!descriptor || typeof descriptor.kind !== 'string' || typeof descriptor.id !== 'string') {
      continue;
    }
    const key = keyOf(descriptor);
    if (!map.has(key)) map.set(key, descriptor);
  }
  return map;
}

function descriptor(
  kind: string,
  id: string,
  title: string,
  source: string,
  declaredInterface: string,
): CapabilityDescriptor {
  return {
    kind,
    id,
    title,
    source,
    trust: 'local-file',
    declaredInterface,
    enabled: true,
  };
}

/**
 * The skills that actually ride a session: the frontmatter list plus whatever
 * `skills/<name>/SKILL.md` the loader found on disk. Deduped and sorted so the
 * diff is stable regardless of directory order.
 */
function declaredSkills(facts: ExpertCapabilityFacts): string[] {
  const names = new Set<string>();
  for (const skill of facts.skills ?? []) {
    if (typeof skill === 'string' && skill.trim() !== '') names.add(skill.trim());
  }
  for (const file of facts.skillFiles ?? []) {
    if (typeof file !== 'string') continue;
    const normalised = file.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalised.endsWith('/SKILL.md')) continue;
    const parent = normalised.slice(0, -'/SKILL.md'.length);
    const name = parent.slice(parent.lastIndexOf('/') + 1);
    if (name !== '') names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Turns one expert file's declared facts into capability descriptors. `null`
 * means "no expert", i.e. a plain Hermes task with no expert-declared surface.
 */
export function expertCapabilityDescriptors(
  facts: ExpertCapabilityFacts | null | undefined,
): CapabilityDescriptor[] {
  if (!facts || typeof facts.slug !== 'string' || facts.slug.trim() === '') return [];
  const file = facts.dir ? `${facts.dir}/expert.md` : `${facts.slug}/expert.md`;
  const toolsFile = facts.toolsFile ?? file;
  const out: CapabilityDescriptor[] = [
    descriptor(EXPERT_KIND, facts.slug, facts.name?.trim() || facts.slug, file, 'expert.md'),
  ];
  for (const tool of facts.tools ?? []) {
    if (typeof tool === 'string' && tool.trim() !== '') {
      out.push(descriptor(TOOL_KIND, tool.trim(), tool.trim(), toolsFile, 'Hermes built-in tool'));
    }
  }
  for (const toolset of facts.toolsets ?? []) {
    if (typeof toolset === 'string' && toolset.trim() !== '') {
      out.push(
        descriptor(TOOLSET_KIND, toolset.trim(), toolset.trim(), file, 'Hermes built-in toolset'),
      );
    }
  }
  for (const skill of declaredSkills(facts)) {
    out.push(descriptor(SKILL_KIND, skill, skill, file, 'SKILL.md'));
  }
  if (typeof facts.model === 'string' && facts.model.trim() !== '') {
    out.push(
      descriptor(
        MODEL_ROUTE_KIND,
        facts.model.trim(),
        facts.model.trim(),
        '~/.cindy-harness/routing.yaml',
        'routing.yaml route',
      ),
    );
  }
  return out;
}

function idsOfKind(
  descriptors: readonly CapabilityDescriptor[],
  kind: string,
): string[] {
  return descriptors
    .filter((row) => row.kind === kind)
    .map((row) => row.id)
    .sort();
}

function plural(label: string, count: number): string {
  return count === 1 ? label : `${label}s`;
}

function kindOrder(kind: string): number {
  const index = KIND_PHRASE_ORDER.indexOf(kind);
  return index === -1 ? KIND_PHRASE_ORDER.length : index;
}

function sortKinds(kinds: string[]): string[] {
  return [...kinds].sort(
    (a, b) => kindOrder(a) - kindOrder(b) || a.localeCompare(b),
  );
}

function toolsetLockChange(
  before: string[],
  after: string[],
): ToolsetLockChange {
  const same =
    before.length === after.length && before.every((value, index) => value === after[index]);
  let state: ToolsetLockState;
  if (before.length === 0 && after.length === 0) state = 'none';
  else if (same) state = 'unchanged';
  else if (before.length === 0) state = 'added';
  else if (after.length === 0) state = 'dropped';
  else state = 'changed';
  return { before, after, state };
}

/**
 * Compares two capability sets. Pure and total: it never throws on odd input,
 * it just reports fewer differences.
 */
export function diffCapabilitySets(
  before: readonly CapabilityDescriptor[],
  after: readonly CapabilityDescriptor[],
): CapabilityDiff {
  const beforeMap = uniqueByKey(before);
  const afterMap = uniqueByKey(after);

  const added: CapabilityDescriptor[] = [];
  const removed: CapabilityDescriptor[] = [];
  const keptIds: string[] = [];

  for (const [key, row] of afterMap) {
    if (beforeMap.has(key)) keptIds.push(key);
    else added.push(row);
  }
  for (const [key, row] of beforeMap) {
    if (!afterMap.has(key)) removed.push(row);
  }

  const kindsWithChange = new Set<string>([
    ...added.map((row) => row.kind),
    ...removed.map((row) => row.kind),
  ]);
  const groups: CapabilityDiffGroup[] = sortKinds([...kindsWithChange]).map((kind) => ({
    kind,
    added: added.filter((row) => row.kind === kind).sort((a, b) => a.id.localeCompare(b.id)),
    removed: removed.filter((row) => row.kind === kind).sort((a, b) => a.id.localeCompare(b.id)),
  }));

  const beforeIds = [...beforeMap.values()];
  const afterIds = [...afterMap.values()];
  const modelBefore = idsOfKind(beforeIds, MODEL_ROUTE_KIND)[0] ?? null;
  const modelAfter = idsOfKind(afterIds, MODEL_ROUTE_KIND)[0] ?? null;
  const model: ModelRouteChange = {
    before: modelBefore,
    after: modelAfter,
    changed: modelBefore !== modelAfter,
  };
  const toolsetLock = toolsetLockChange(
    idsOfKind(beforeIds, TOOLSET_KIND),
    idsOfKind(afterIds, TOOLSET_KIND),
  );

  // Phrases are ranked by KIND_PHRASE_ORDER, "adds" before "drops" inside a
  // kind, so the summary always reads in the same order. The rank table is
  // data: an unknown kind lands after the known ones without a code change.
  const ranked: Array<{ rank: number; text: string }> = [];
  for (const group of groups) {
    if (KINDS_WITHOUT_PHRASE.includes(group.kind)) continue;
    if (group.kind === MODEL_ROUTE_KIND || group.kind === TOOLSET_KIND) continue;
    const label = KIND_PHRASE_LABELS[group.kind] ?? group.kind;
    const base = kindOrder(group.kind) * 2;
    if (group.added.length > 0) {
      ranked.push({
        rank: base,
        text: `adds ${group.added.length} ${plural(label, group.added.length)}`,
      });
    }
    if (group.removed.length > 0) {
      ranked.push({
        rank: base + 1,
        text: `drops ${group.removed.length} ${plural(label, group.removed.length)}`,
      });
    }
  }

  const toolsetRank = kindOrder(TOOLSET_KIND) * 2;
  if (toolsetLock.state === 'added') ranked.push({ rank: toolsetRank, text: 'adds toolset lock' });
  else if (toolsetLock.state === 'dropped') ranked.push({ rank: toolsetRank, text: 'drops toolset lock' });
  else if (toolsetLock.state === 'changed') ranked.push({ rank: toolsetRank, text: 'changes toolset lock' });
  else if (toolsetLock.state === 'unchanged') ranked.push({ rank: toolsetRank, text: 'keeps toolset lock' });

  const modelRank = kindOrder(MODEL_ROUTE_KIND) * 2;
  if (model.changed) {
    if (model.before === null && model.after !== null) {
      ranked.push({ rank: modelRank, text: `adds model route ${model.after}` });
    } else if (model.before !== null && model.after === null) {
      ranked.push({ rank: modelRank, text: 'drops model route' });
    } else if (model.after !== null) {
      ranked.push({ rank: modelRank, text: `changes model to ${model.after}` });
    }
  } else if (model.before !== null) {
    ranked.push({ rank: modelRank, text: 'keeps model' });
  }

  const phrases = ranked
    .sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text))
    .map((entry) => entry.text);

  return {
    groups,
    added,
    removed,
    keptIds: keptIds.sort(),
    model,
    toolsetLock,
    phrases,
    summary: phrases.length > 0 ? phrases.join(', ') : 'no capability changes',
  };
}

/** Convenience for UI: one line, never empty. */
export function capabilityDiffSummary(diff: CapabilityDiff): string {
  return diff.summary;
}
