import { redactSecrets } from '../export/session-markdown';

export interface HandoffMessage {
  role: string;
  content?: string;
  text?: string;
  toolCalls?: Array<{ name: string; input?: unknown }>;
  toolName?: string;
}

export interface SessionHandoffInput {
  sessionId: string;
  sessionTitle?: string;
  workingDir?: string;
  model?: string;
  expertSlug?: string;
  messages: readonly HandoffMessage[];
}

export interface SessionHandoffResult {
  sessionId: string;
  prompt: string;
  summary: string;
  decisions: string[];
  touchedFiles: string[];
  pendingActions: string[];
  totalMessagesCount: number;
}

const FILE_PATH_PATTERNS = [
  /(?:^|\s)(?:file:\/\/)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9_-]{1,10})(?::\d+)?(?:\s|$)/g,
  /\b(?:in|into|created|modified|updated|read|viewed|file)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9_-]{1,10})[`"']?/gi,
];

const DECISION_PATTERNS = [
  /\b(?:decided to|agreed to|decision:|we will|we chose to)\s+(.+)$/i,
  /\b(?:by decision|ADR|confirmed that|approved)\b/i,
];

const PENDING_PATTERNS = [
  /\b(?:next step:?|pending:?|todo:?|remaining:?|next action:?)\s*(.+)$/i,
  /(?:^|[-*•\s]|\d+\.)\[ \]\s*(.+)$/,
  /\b(?:still need to|next turn|follow-up|subsequent task)\b/i,
];

/**
 * Extracts distinct file paths mentioned in messages.
 */
export function extractTouchedFiles(messages: readonly HandoffMessage[]): string[] {
  const set = new Set<string>();

  for (const m of messages) {
    const text = m.content || m.text || '';
    if (!text) continue;

    for (const pat of FILE_PATH_PATTERNS) {
      const re = new RegExp(pat.source, pat.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const file = match[1]?.trim();
        // Skip common false positives
        if (
          file &&
          !file.startsWith('http') &&
          !file.includes('node_modules') &&
          file.length >= 3 &&
          !file.endsWith('.')
        ) {
          set.add(file);
        }
      }
    }
  }

  return Array.from(set).slice(0, 15);
}

/**
 * Extracts key decisions and agreements made in the conversation.
 */
export function extractSessionDecisions(messages: readonly HandoffMessage[]): string[] {
  const decisions: string[] = [];

  for (const m of messages) {
    const text = m.content || m.text || '';
    if (!text) continue;

    const lines = text.split(/(?:\r?\n)+|(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      for (const pat of DECISION_PATTERNS) {
        if (pat.test(line)) {
          let clean = line.replace(/^[-*•\s]+/, '').trim();
          if (!clean.endsWith('.')) clean += '.';
          if (!decisions.includes(clean)) {
            decisions.push(clean);
          }
          break;
        }
      }
    }
  }

  if (decisions.length === 0) {
    decisions.push('Architectural baseline established in previous turns.');
  }

  return decisions.slice(0, 8);
}

/**
 * Extracts pending next steps, remaining tasks, or open checklist items.
 */
export function extractPendingNextActions(messages: readonly HandoffMessage[]): string[] {
  const pending: string[] = [];

  // Scan backwards from newest turns
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = m.content || m.text || '';
    if (!text) continue;

    const lines = text.split(/(?:\r?\n)+|(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      for (const pat of PENDING_PATTERNS) {
        if (pat.test(line)) {
          let clean = line.replace(/^[-*•\s]+/, '').replace(/^\[ \]\s*/, '').trim();
          if (!clean.endsWith('.')) clean += '.';
          if (!pending.includes(clean)) {
            pending.push(clean);
          }
          break;
        }
      }
    }
  }

  if (pending.length === 0) {
    pending.push('Proceed with next planned tasks according to roadmap.');
  }

  return pending.slice(0, 8);
}

/**
 * Assembles a clean, structured handoff prompt for initializing a fresh session.
 */
export function assembleHandoffPrompt(input: SessionHandoffInput): SessionHandoffResult {
  const { sessionId, sessionTitle, workingDir, model, expertSlug, messages } = input;

  const decisions = extractSessionDecisions(messages);
  const touchedFiles = extractTouchedFiles(messages);
  const pendingActions = extractPendingNextActions(messages);

  // Compute a concise summary from the first goal and last turn
  let initialGoal = '';
  for (const m of messages) {
    if (m.role === 'user' && (m.content || m.text)) {
      initialGoal = (m.content || m.text || '').trim().split(/\r?\n/)[0];
      break;
    }
  }

  let finalOutcome = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && (m.content || m.text)) {
      finalOutcome = (m.content || m.text || '').trim().split(/\r?\n/)[0];
      break;
    }
  }

  const summary = [
    initialGoal ? `Initial Goal: ${initialGoal}` : '',
    finalOutcome ? `Latest State: ${finalOutcome}` : '',
  ]
    .filter(Boolean)
    .join('\n') || 'Session compacted after completing previous milestone.';

  const recentExcerpt = messages
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content || m.text || '').trim().slice(0, 500)}`)
    .filter(Boolean)
    .join('\n\n');

  const promptSections = [
    '# Session Continuation & Handoff',
    '',
    `**Previous Session:** ${sessionTitle || sessionId}`,
    workingDir ? `**Working Directory:** \`${workingDir}\`` : null,
    model ? `**Model:** \`${model}\`` : null,
    expertSlug ? `**Expert:** \`${expertSlug}\`` : null,
    '',
    '## Context & Summary',
    summary,
    '',
    '## Key Decisions Made',
    ...decisions.map((d) => `- ${d}`),
    '',
    touchedFiles.length > 0 ? '## Relevant Files' : null,
    touchedFiles.length > 0 ? touchedFiles.map((f) => `- \`${f}\``).join('\n') : null,
    touchedFiles.length > 0 ? '' : null,
    recentExcerpt ? '## Recent Context & Discussion' : null,
    recentExcerpt ? recentExcerpt : null,
    recentExcerpt ? '' : null,
    '## Pending Next Actions',
    ...pendingActions.map((a) => `- [ ] ${a}`),
    '',
    'Please continue execution from these pending actions.',
  ].filter((line): line is string => line !== null);

  const rawPrompt = promptSections.join('\n');
  const sanitizedPrompt = redactSecrets(rawPrompt);

  return {
    sessionId,
    prompt: sanitizedPrompt,
    summary,
    decisions,
    touchedFiles,
    pendingActions,
    totalMessagesCount: messages.length,
  };
}
