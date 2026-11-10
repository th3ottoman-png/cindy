/**
 * Context Budget Estimator (ROADMAP 8.7).
 *
 * Estimates the token impact of each capability (expert prompt, skills, tool schemas,
 * connectors, and pinned notes) before a turn. Provides actionable suggestions:
 * "Disabling 3 unused skills frees about 4,200 tokens."
 */

import type { CapabilityPack } from './capability-pack.js';
import type { SessionManifest } from '../session/session-manifest.js';
import { buildCapabilityGraph, findUnusedCapabilities } from './capability-graph.js';

export interface CapabilityBudgetItem {
  kind: 'expert' | 'skill' | 'tool' | 'connector' | 'note' | 'permission';
  id: string;
  label: string;
  tokens: number;
  percentage: number;
  isUnused: boolean;
  reason?: string;
}

export interface CapabilityBudgetReport {
  totalEstimatedTokens: number;
  maxContextTokens: number;
  utilizationPercent: number;
  breakdown: CapabilityBudgetItem[];
  unusedTokens: number;
  unusedCount: number;
  suggestion?: string;
  recommendations: string[];
}

export interface EstimateBudgetOptions {
  packOrManifest: CapabilityPack | SessionManifest;
  noteBodies?: Record<string, string>;
  invokedTools?: string[];
  activeSkills?: string[];
  maxContextTokens?: number;
}

const DEFAULT_MAX_CONTEXT_TOKENS = 128000;
const TOKENS_PER_EXPERT_SYSTEM_PROMPT = 1200;
const TOKENS_PER_SKILL = 1400;
const TOKENS_PER_CONNECTOR = 350;
const TOKENS_PER_TOOL_SCHEMA = 280;

/**
 * Estimates character count to token count (approx 4 chars/token for English/code).
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Evaluates the token footprint of attached capabilities and computes optimization suggestions.
 */
export function estimateCapabilityBudget(options: EstimateBudgetOptions): CapabilityBudgetReport {
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const graph = buildCapabilityGraph(options.packOrManifest);
  const unused = findUnusedCapabilities(
    graph,
    options.invokedTools ?? [],
    options.activeSkills ?? [],
  );

  const unusedSkillsSet = new Set(unused.unusedSkills.map((s) => s.toLowerCase()));
  const unusedToolsSet = new Set(unused.unusedTools.map((t) => t.toLowerCase()));

  const items: Omit<CapabilityBudgetItem, 'percentage'>[] = [];

  // 1. Process Expert
  const expertNode = Object.values(graph.nodes).find((n) => n.kind === 'expert');
  if (expertNode) {
    items.push({
      kind: 'expert',
      id: expertNode.id,
      label: expertNode.label,
      tokens: TOKENS_PER_EXPERT_SYSTEM_PROMPT,
      isUnused: false,
      reason: 'Base system instructions & personality',
    });
  }

  // 2. Process Skills
  for (const node of Object.values(graph.nodes).filter((n) => n.kind === 'skill')) {
    const rawName = node.id.replace(/^skill:/, '').toLowerCase();
    const isUnused = unusedSkillsSet.has(rawName);
    items.push({
      kind: 'skill',
      id: node.id,
      label: node.label,
      tokens: TOKENS_PER_SKILL,
      isUnused,
      reason: isUnused ? 'Not invoked in recent turns' : 'Active skill instructions',
    });
  }

  // 3. Process Connectors
  for (const node of Object.values(graph.nodes).filter((n) => n.kind === 'connector')) {
    items.push({
      kind: 'connector',
      id: node.id,
      label: node.label,
      tokens: TOKENS_PER_CONNECTOR,
      isUnused: false,
      reason: 'MCP server protocol schemas',
    });
  }

  // 4. Process Tools
  for (const node of Object.values(graph.nodes).filter((n) => n.kind === 'tool')) {
    const rawName = node.id.replace(/^tool:/, '').toLowerCase();
    const isUnused = unusedToolsSet.has(rawName);
    items.push({
      kind: 'tool',
      id: node.id,
      label: node.label,
      tokens: TOKENS_PER_TOOL_SCHEMA,
      isUnused,
      reason: isUnused ? 'Schema never dispatched' : 'Tool declaration JSON schema',
    });
  }

  // 5. Process Pinned Notes
  for (const node of Object.values(graph.nodes).filter((n) => n.kind === 'note')) {
    const notePath = node.label;
    const body = options.noteBodies?.[notePath] ?? options.noteBodies?.[node.id] ?? '';
    const noteTokens = body ? estimateTokensFromChars(body.length) : 450; // default 450 if body not supplied
    items.push({
      kind: 'note',
      id: node.id,
      label: `Note: ${notePath}`,
      tokens: noteTokens,
      isUnused: false,
      reason: 'Pinned reference note in session context',
    });
  }

  const totalEstimatedTokens = items.reduce((acc, it) => acc + it.tokens, 0);

  // Compute percentages
  const breakdown: CapabilityBudgetItem[] = items.map((it) => ({
    ...it,
    percentage:
      totalEstimatedTokens > 0
        ? Number(((it.tokens / totalEstimatedTokens) * 100).toFixed(1))
        : 0,
  }));

  const unusedTokens = breakdown
    .filter((b) => b.isUnused)
    .reduce((acc, it) => acc + it.tokens, 0);

  const unusedCount = breakdown.filter((b) => b.isUnused).length;

  let suggestion: string | undefined;
  const recommendations: string[] = [];

  if (unused.unusedSkills.length > 0) {
    const freedTokens = unused.unusedSkills.length * TOKENS_PER_SKILL;
    suggestion = `Disabling ${unused.unusedSkills.length} unused skill${
      unused.unusedSkills.length > 1 ? 's' : ''
    } frees about ${freedTokens.toLocaleString()} tokens.`;
    recommendations.push(suggestion);
  }

  if (unused.unusedTools.length > 5) {
    const freedToolTokens = unused.unusedTools.length * TOKENS_PER_TOOL_SCHEMA;
    recommendations.push(
      `Restricting ${unused.unusedTools.length} uncalled tool schemas frees about ${freedToolTokens.toLocaleString()} tokens.`,
    );
  }

  const utilizationPercent =
    maxContextTokens > 0
      ? Number(((totalEstimatedTokens / maxContextTokens) * 100).toFixed(1))
      : 0;

  return {
    totalEstimatedTokens,
    maxContextTokens,
    utilizationPercent,
    breakdown,
    unusedTokens,
    unusedCount,
    suggestion,
    recommendations,
  };
}
