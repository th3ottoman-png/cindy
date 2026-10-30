/**
 * Expert handoff (ROADMAP 3.6a).
 *
 * "Ask <expert> about this": builds the first message for a NEW session that carries a compact,
 * deterministic summary of the current one (no model call). It returns a draft only; nothing
 * here starts a session, so the owner stays in the loop. The summary keeps the newest messages
 * within a character budget, shows tool calls by name only (payloads stay out), and redacts
 * obvious credentials.
 */

import type { Expert } from './expert-loader';
import { redactSecrets, type ExportSession } from '../export/session-markdown';

export const DEFAULT_HANDOFF_QUESTION = 'Review this conversation and tell me what you think.';

export interface BuildHandoffOptions {
  /** The owner's question for the expert; defaults to a plain review request. */
  question?: string;
  /** Budget for the conversation excerpt. Default 12000. */
  maxChars?: number;
  /** Per-message cap before it is cut with a marker. Default 2000. */
  maxMessageChars?: number;
}

export interface ExpertHandoff {
  expertSlug: string;
  /** The text to send as the new session's first message. */
  prompt: string;
  includedMessages: number;
  omittedMessages: number;
  /** True when older messages were dropped or a message was cut. */
  truncated: boolean;
}

export type BuildHandoffResult = ExpertHandoff | { error: 'no-messages' | 'expert-unavailable'; message: string };

const ROLE_LABEL = { user: 'Owner', assistant: 'Assistant', system: 'System' } as const;

function clip(text: string, max: number): { text: string; cut: boolean } {
  return text.length <= max ? { text, cut: false } : { text: `${text.slice(0, max)}… [${text.length - max} more characters cut]`, cut: true };
}

function renderMessage(m: ExportSession['messages'][number], maxMessageChars: number): { text: string; cut: boolean } {
  const body = clip(redactSecrets((m.text ?? '').trim()), maxMessageChars);
  const tools = (m.toolCalls ?? []).map((c) => c.name.replace(/\s+/g, ' ')).filter(Boolean);
  const toolLine = tools.length > 0 ? `\n(tools used: ${tools.join(', ')})` : '';
  if (!body.text && !toolLine) return { text: '', cut: false };
  return { text: `${ROLE_LABEL[m.role]}: ${body.text}${toolLine}`, cut: body.cut };
}

export function buildExpertHandoff(
  expert: Pick<Expert, 'slug' | 'name'>,
  session: Pick<ExportSession, 'title' | 'agent' | 'model' | 'messages'>,
  opts: BuildHandoffOptions = {},
): BuildHandoffResult {
  if (!expert.slug || !expert.name) return { error: 'expert-unavailable', message: 'the target expert did not load' };
  const rendered = session.messages.map((m) => renderMessage(m, opts.maxMessageChars ?? 2000)).filter((r) => r.text !== '');
  if (rendered.length === 0) return { error: 'no-messages', message: 'the source session has nothing to hand off' };

  const budget = opts.maxChars ?? 12000;
  const kept: string[] = [];
  let used = 0;
  let cutAny = false;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const entry = rendered[i];
    // Always keep the newest message, even over budget, so the excerpt is never empty.
    if (kept.length > 0 && used + entry.text.length + 2 > budget) break;
    kept.unshift(entry.text);
    used += entry.text.length + 2;
    cutAny = cutAny || entry.cut;
  }
  const omitted = rendered.length - kept.length;

  const header = [
    `The owner wants your take on a conversation from another session.`,
    `Source session: "${session.title.replace(/\s+/g, ' ').trim() || 'Untitled'}" (agent ${session.agent}${session.model ? `, model ${session.model}` : ''}).`,
    `You have no tools or files from that session; only the excerpt below.`,
  ];
  const question = (opts.question ?? '').trim() || DEFAULT_HANDOFF_QUESTION;
  const excerptHeading =
    omitted > 0 ? `--- Conversation excerpt (newest ${kept.length} messages; ${omitted} older omitted) ---` : '--- Conversation excerpt ---';

  const prompt = [...header, '', `Owner's question: ${question}`, '', excerptHeading, '', kept.join('\n\n'), '', '--- End of excerpt ---'].join('\n');
  return { expertSlug: expert.slug, prompt, includedMessages: kept.length, omittedMessages: omitted, truncated: omitted > 0 || cutAny };
}
