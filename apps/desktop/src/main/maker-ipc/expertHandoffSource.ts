/**
 * Ask-expert handoff source (ROADMAP 3.6b): stored session rows → the minimal transcript shape
 * `buildExpertHandoff` (`@cindy/maker-core/expert-handoff`) summarises. Text comes from the same
 * parser the engine-switch handoff uses (`extractPlainText`); tool calls keep their name only and
 * tool results are dropped, so no tool payload reaches the expert.
 */

import type { ExportMessage } from '@cindy/maker-core/session-export';

import { extractPlainText, type HandoffSourceMessage } from './agentHandoff.js';

/** Synthetic UI trigger rows (same marker the engine-switch handoff skips). */
const SYNTHETIC_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

function toolNameOf(content: unknown): string {
  let c = content;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch {
      return '';
    }
  }
  const name = c && typeof c === 'object' ? (c as Record<string, unknown>).toolName ?? (c as Record<string, unknown>).name : undefined;
  return typeof name === 'string' ? name : '';
}

export function toExpertHandoffMessages(rows: readonly HandoffSourceMessage[]): ExportMessage[] {
  const out: ExportMessage[] = [];
  let pendingTools: { name: string }[] = [];
  const flushTools = (): void => {
    if (pendingTools.length === 0) return;
    out.push({ role: 'assistant', text: '', toolCalls: pendingTools });
    pendingTools = [];
  };
  for (const row of rows) {
    if (row.role === 'tool_use') {
      const name = toolNameOf(row.content);
      if (name) pendingTools.push({ name });
    } else if (row.role === 'assistant') {
      const text = extractPlainText(row.content).trim();
      if (!text && pendingTools.length === 0) continue;
      out.push({ role: 'assistant', text, ...(pendingTools.length > 0 ? { toolCalls: pendingTools } : {}) });
      pendingTools = [];
    } else if (row.role === 'user') {
      const text = extractPlainText(row.content).trim();
      if (!text || text.startsWith(SYNTHETIC_TRIGGER_PREFIX)) continue;
      flushTools();
      out.push({ role: 'user', text });
    }
    // tool_result, system and other rows stay out.
  }
  flushTools();
  return out;
}
