/**
 * Tool-result side of the injection guard (ROADMAP 10.1b).
 *
 * A tool result is different from a tool call: by the time Cindy sees the event, Hermes has already
 * fed the text back to the model, so nothing here can un-read it. What it *can* do is refuse to let
 * the turn act on poisoned input quietly — one flagged result taints the session and the bar for
 * every later tool call drops (0.8 → 0.5), so a follow-up like `ls ~/.ssh` that passes in a clean
 * session is held in a tainted one.
 */

import { scoreToolResult, type GuardConfig, type GuardVerdict } from '@cindy/maker-core/injection-guard';

/** How low the bar drops once a result carried injected instructions. */
export const TAINTED_THRESHOLD = 0.5;

export interface ToolResultSample {
  tool: string;
  output: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The result text of a stream event, in any of the shapes Hermes emits it: a top-level
 * `tool_result` event, an Anthropic-style `message.content` block, or a `kind: 'tool-result'`
 * variant. Unknown shapes return null rather than a guess.
 */
export function toolResultOf(event: unknown): ToolResultSample | null {
  const evt = asRecord(event);
  if (!evt) return null;
  const type = evt.type ?? evt.kind;
  if (type === 'tool_result' || type === 'tool-result') {
    const tool = evt.tool ?? evt.name ?? evt.tool_name;
    const output = evt.output ?? evt.content ?? evt.result ?? evt.text;
    if (output === undefined) return null;
    return { tool: typeof tool === 'string' && tool ? tool : 'tool', output };
  }
  const content = asRecord(evt.message)?.content;
  if (Array.isArray(content)) {
    const blocks = content
      .map(asRecord)
      .filter((b): b is Record<string, unknown> => !!b && (b.type === 'tool_result' || b.type === 'tool-result'));
    if (!blocks.length) return null;
    return { tool: 'tool', output: blocks.map((b) => b.content ?? b.output) };
  }
  return null;
}

export interface ToolResultGuardDecision {
  sample: ToolResultSample;
  verdict: GuardVerdict;
  /** True when the result crossed the configured threshold and the session is now tainted. */
  tainted: boolean;
}

/** Scores a tool-result event; null when the event carries no result. `off` scores nothing. */
export function decideToolResultGuard(event: unknown, config: GuardConfig): ToolResultGuardDecision | null {
  if (config.policy === 'off') return null;
  const sample = toolResultOf(event);
  if (!sample) return null;
  const verdict = scoreToolResult(sample);
  return { sample, verdict, tainted: verdict.score > 0 && verdict.score >= config.threshold };
}

/** The config a tainted session is judged by: same policy, lower bar, never silently `off`. */
export function taintedGuardConfig(config: GuardConfig, tainted: boolean): GuardConfig {
  if (!tainted || config.policy === 'off') return config;
  return { ...config, threshold: Math.min(config.threshold, TAINTED_THRESHOLD) };
}
