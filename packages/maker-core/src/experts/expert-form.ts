/**
 * Expert form contract (ROADMAP 12.2).
 *
 * The New-agent form on the Agents page maps 1:1 onto `expert.md`: name, description,
 * program (`agent:`), model route, conversations at once (`max_concurrent:`) and the
 * working instructions (the body). This module is the pure parse/render pair behind it.
 *
 * Re-rendering an existing file keeps every frontmatter key the form does not own
 * (tools, tags, temperature, anything hand-added) and keeps the body byte-identical.
 * YAML comments are not preserved — same convention as the 3.3 Settings editor.
 */

import matter from 'gray-matter';

import { EXPERT_AGENTS, type ExpertAgent } from './expert-loader.js';

export interface ExpertFormFields {
  name: string;
  description: string;
  agent: ExpertAgent;
  /** Route name from routing.yaml; absent = the session keeps its own model. */
  model?: string;
  /** Absent = the default cap of 1. */
  maxConcurrent?: number;
  /** The raw markdown body, untrimmed, so a parse/render round-trip is byte-identical. */
  prompt: string;
}

function asExpertAgent(value: unknown): ExpertAgent {
  return typeof value === 'string' && (EXPERT_AGENTS as readonly string[]).includes(value)
    ? (value as ExpertAgent)
    : 'hermes';
}

/** Parse expert.md into form fields. Unknown keys are ignored here and kept on re-render. */
export function markdownToExpertForm(markdown: string): ExpertFormFields {
  const parsed = matter(markdown, {});
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const model = typeof fm.model === 'string' && fm.model.trim() ? fm.model.trim() : undefined;
  const maxConcurrent = typeof fm.max_concurrent === 'number' && Number.isInteger(fm.max_concurrent) && fm.max_concurrent >= 1
    ? fm.max_concurrent
    : undefined;
  return {
    name: typeof fm.name === 'string' ? fm.name : '',
    description: typeof fm.description === 'string' ? fm.description : '',
    agent: asExpertAgent(fm.agent),
    ...(model ? { model } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    prompt: parsed.content,
  };
}

/**
 * Render form fields as expert.md. With `baseMarkdown`, every key the form does not own
 * survives; without it, a fresh file gets `memory: false` and nothing else.
 */
export function expertFormToMarkdown(fields: ExpertFormFields, baseMarkdown?: string): string {
  const data: Record<string, unknown> = baseMarkdown
    ? { ...((matter(baseMarkdown, {}).data ?? {}) as Record<string, unknown>) }
    : { memory: false };
  data.name = fields.name;
  data.description = fields.description;
  data.agent = fields.agent;
  if (fields.model) data.model = fields.model;
  else delete data.model;
  if (fields.maxConcurrent !== undefined && fields.maxConcurrent > 1) data.max_concurrent = fields.maxConcurrent;
  else delete data.max_concurrent;
  // lineWidth -1: one line per field, so the owner can hand-edit it (no folded blocks).
  const text = matter.stringify(fields.prompt, data, { lineWidth: -1 } as Parameters<typeof matter.stringify>[2]);
  // gray-matter appends a trailing newline; keep the body byte-identical when it had none.
  return fields.prompt.endsWith('\n') ? text : text.replace(/\n$/, '');
}

/** Lowercase kebab-case, 2–64 characters, starting with a letter or digit (the 3.8 slug rule). */
export function expertSlugFromName(value: string): string {
  const slug = value.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  const cleaned = slug.replace(/^[^a-z0-9]+/, '');
  return cleaned.length >= 2 ? cleaned : `agent-${cleaned}`.slice(0, 64);
}
