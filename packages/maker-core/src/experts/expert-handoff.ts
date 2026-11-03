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

interface Excerpt {
  heading: string;
  body: string;
  includedMessages: number;
  omittedMessages: number;
  truncated: boolean;
}

function buildExcerpt(messages: ExportSession['messages'], opts: BuildHandoffOptions): Excerpt | null {
  const rendered = messages.map((m) => renderMessage(m, opts.maxMessageChars ?? 2000)).filter((r) => r.text !== '');
  if (rendered.length === 0) return null;

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
  const heading =
    omitted > 0 ? `--- Conversation excerpt (newest ${kept.length} messages; ${omitted} older omitted) ---` : '--- Conversation excerpt ---';
  return { heading, body: kept.join('\n\n'), includedMessages: kept.length, omittedMessages: omitted, truncated: omitted > 0 || cutAny };
}

function sourceLine(session: Pick<ExportSession, 'title' | 'agent' | 'model'>): string {
  return `Source session: "${session.title.replace(/\s+/g, ' ').trim() || 'Untitled'}" (agent ${session.agent}${session.model ? `, model ${session.model}` : ''}).`;
}

export function buildExpertHandoff(
  expert: Pick<Expert, 'slug' | 'name'>,
  session: Pick<ExportSession, 'title' | 'agent' | 'model' | 'messages'>,
  opts: BuildHandoffOptions = {},
): BuildHandoffResult {
  if (!expert.slug || !expert.name) return { error: 'expert-unavailable', message: 'the target expert did not load' };
  const excerpt = buildExcerpt(session.messages, opts);
  if (!excerpt) return { error: 'no-messages', message: 'the source session has nothing to hand off' };

  const header = [
    `The owner wants your take on a conversation from another session.`,
    sourceLine(session),
    `You have no tools or files from that session; only the excerpt below.`,
  ];
  const question = (opts.question ?? '').trim() || DEFAULT_HANDOFF_QUESTION;
  const prompt = [...header, '', `Owner's question: ${question}`, '', excerpt.heading, '', excerpt.body, '', '--- End of excerpt ---'].join('\n');
  return {
    expertSlug: expert.slug,
    prompt,
    includedMessages: excerpt.includedMessages,
    omittedMessages: excerpt.omittedMessages,
    truncated: excerpt.truncated,
  };
}

export type GoAheadHandoff = Omit<ExpertHandoff, 'expertSlug'>;

/** First line of a "Go ahead" draft; the owner writes the picked option after it before sending. */
export const GO_AHEAD_PICK_LABEL = 'Option picked:';

/**
 * "Go ahead" (ROADMAP 3.10c): the first message for a NEW plain task (no expert) that carries
 * out the option the owner picked in a locked Options first chat. Same excerpt rules as
 * `buildExpertHandoff`; it only drafts text and starts nothing. The draft opens with an empty
 * "Option picked:" line for the owner to fill in, because Hermes's `clarify` gets no answer in a
 * Cindy run (live 2026-11-03: the agent then picked an option itself and wrote files).
 */
export function buildGoAheadHandoff(
  session: Pick<ExportSession, 'title' | 'agent' | 'model' | 'messages'>,
  opts: Omit<BuildHandoffOptions, 'question'> = {},
): GoAheadHandoff | { error: 'no-messages'; message: string } {
  const excerpt = buildExcerpt(session.messages, opts);
  if (!excerpt) return { error: 'no-messages', message: 'the source session has nothing to hand off' };

  const header = [
    `The owner picked an option in an Options first chat and wants it done in this task.`,
    sourceLine(session),
    `That chat could not read files or run commands, so check the project yourself before you change anything.`,
  ];
  const request =
    `Carry out the option named on the "${GO_AHEAD_PICK_LABEL}" line at the top. ` +
    `If that line is empty or unclear, ask in your reply which option to do and stop: do not use the clarify tool, and change nothing until the owner answers.`;
  const prompt = [`${GO_AHEAD_PICK_LABEL} `, '', ...header, '', `Owner's request: ${request}`, '', excerpt.heading, '', excerpt.body, '', '--- End of excerpt ---'].join('\n');
  return { prompt, includedMessages: excerpt.includedMessages, omittedMessages: excerpt.omittedMessages, truncated: excerpt.truncated };
}
