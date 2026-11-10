export interface StructuredPromptSections {
  goal: string;
  context: string;
  guardrails: string[];
  doneCriteria: string[];
}

export interface StructuredPromptResult {
  raw: string;
  structuredMarkdown: string;
  sections: StructuredPromptSections;
}

const GUARDRAIL_PATTERNS = [
  /^(?:don't|do not|never|must not|cannot|should not|make sure not to|avoid|ensure no)\s+(.+)$/i,
  /^(?:strictly|keep in mind that|no\s+telemetry|no\s+cloud|local-only)\b/i,
];

const CONTEXT_PATTERNS = [
  /^(?:because|since|currently|the reason is|right now|the issue is|the problem is|in our case)\b/i,
  /\b(?:is broken|doesn't work|fails because|is needed because)\b/i,
];

const DONE_PATTERNS = [
  /^(?:done when|done means|needs to|should pass|verify that|must pass|ensure tests?)\b/i,
  /\b(?:all tests pass|unit tests? pass|live proof|passes?)\b/i,
];

const GOAL_PATTERNS = [
  /^(?:i want to|we need to|please\s+|goal:?\s*|build\s+|create\s+|implement\s+|add\s+|fix\s+|refactor\s+|update\s+)/i,
];

/**
 * Splits plain unstructured brain-dump text into sentences and thought fragments.
 */
export function splitThoughts(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  // Split on newlines, periods followed by space/capital, or semicolons
  return text
    .split(/(?:\r?\n)+|(?<=[.!?])\s+(?=[A-Z0-9"']|\b)|;\s+/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Deterministically structures unstructured brain-dump text into 4 clear sections:
 * Goal, Context, Guardrails, Done Criteria.
 */
export function structureBrainDumpPrompt(rawText: string): StructuredPromptResult {
  const raw = (rawText || '').trim();
  if (!raw) {
    return {
      raw: '',
      structuredMarkdown: '',
      sections: {
        goal: '',
        context: '',
        guardrails: [],
        doneCriteria: [],
      },
    };
  }

  const thoughts = splitThoughts(raw);

  // Split any thought containing " because " into action and reason
  const expandedThoughts: string[] = [];
  for (const t of thoughts) {
    const becauseIdx = t.search(/\s+because\s+/i);
    if (becauseIdx !== -1) {
      expandedThoughts.push(t.slice(0, becauseIdx).trim());
      expandedThoughts.push(t.slice(becauseIdx).trim());
    } else {
      expandedThoughts.push(t);
    }
  }

  const goalThoughts: string[] = [];
  const contextThoughts: string[] = [];
  const guardrailThoughts: string[] = [];
  const doneThoughts: string[] = [];

  for (const thought of expandedThoughts) {
    let matched = false;

    // Check guardrails
    for (const pat of GUARDRAIL_PATTERNS) {
      if (pat.test(thought)) {
        guardrailThoughts.push(thought);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Check done criteria
    for (const pat of DONE_PATTERNS) {
      if (pat.test(thought)) {
        doneThoughts.push(thought);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Check context
    for (const pat of CONTEXT_PATTERNS) {
      if (pat.test(thought)) {
        contextThoughts.push(thought);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Check goal
    for (const pat of GOAL_PATTERNS) {
      if (pat.test(thought)) {
        goalThoughts.push(thought);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // If first thought and no category matched, treat as primary goal
    if (goalThoughts.length === 0) {
      goalThoughts.push(thought);
    } else {
      contextThoughts.push(thought);
    }
  }

  // Normalize goal
  let goal = goalThoughts.join(' ').trim();
  if (!goal && expandedThoughts.length > 0) {
    goal = expandedThoughts[0];
  }
  // Strip conversational filler prefixes like "hey so basically i want to" or "please"
  goal = goal.replace(/^(?:(?:hey|so|basically|well|look|ok|um|uh|please)[,!\s]+)+/i, '');
  if (/^i want to\s+/i.test(goal)) {
    goal = goal.replace(/^i want to\s+/i, '');
  }
  if (/^we need to\s+/i.test(goal)) {
    goal = goal.replace(/^we need to\s+/i, '');
  }
  if (goal) {
    goal = goal.charAt(0).toUpperCase() + goal.slice(1);
  }

  // Normalize context
  const context = contextThoughts.join(' ').trim() || 'Direct user requirement.';

  // Normalize guardrails
  const guardrails = guardrailThoughts.map((g) => {
    let clean = g.replace(/^[-*•\s]+/, '').trim();
    if (!clean.endsWith('.')) clean += '.';
    return clean;
  });
  if (guardrails.length === 0) {
    guardrails.push('Follow local-first architecture and pre-commit gate standards.');
  }

  // Normalize done criteria
  const doneCriteria = doneThoughts.map((d) => {
    let clean = d.replace(/^[-*•\s]+/, '').trim();
    if (!clean.endsWith('.')) clean += '.';
    return clean;
  });
  if (doneCriteria.length === 0) {
    doneCriteria.push('Implementation complete and proven with passing tests.');
  }

  // Format into standard Markdown
  const markdownLines: string[] = [
    '## Goal',
    goal,
    '',
    '## Context & Background',
    context,
    '',
    '## Guardrails & Constraints',
    ...guardrails.map((g) => `- ${g}`),
    '',
    '## Done Criteria',
    ...doneCriteria.map((d) => `- [ ] ${d}`),
  ];

  const structuredMarkdown = markdownLines.join('\n');

  return {
    raw,
    structuredMarkdown,
    sections: {
      goal,
      context,
      guardrails,
      doneCriteria,
    },
  };
}
