import { describe, it, expect } from 'vitest';
import {
  assembleHandoffPrompt,
  extractSessionDecisions,
  extractTouchedFiles,
  extractPendingNextActions,
  extractSessionConstraints,
  type HandoffMessage,
} from '../session-compaction-handoff';

describe('session-compaction-handoff (ROADMAP 7.8)', () => {
  const sampleMessages: HandoffMessage[] = [
    {
      role: 'user',
      content: 'We need to implement session compaction and clean handoff for long sessions in apps/desktop/src/main/maker-ipc/sessionHandoff.ts',
    },
    {
      role: 'assistant',
      content: 'I analyzed the architecture. We decided to use pure extraction in packages/maker-core/src/session/session-compaction-handoff.ts.',
    },
    {
      role: 'user',
      content: 'Make sure not to leak secrets like api_key="sk-secret1234567890123456".',
    },
    {
      role: 'assistant',
      content: 'Understood. Confirmed that all outputs pass through redactSecrets.\n\nNext step: create the IPC handler and wire the 1-click handoff button.\n- [ ] Run pre-commit gates.',
    },
  ];

  it('extracts touched file paths from messages', () => {
    const files = extractTouchedFiles(sampleMessages);
    expect(files.some((f) => f.includes('sessionHandoff.ts'))).toBe(true);
    expect(files.some((f) => f.includes('session-compaction-handoff.ts'))).toBe(true);
  });

  it('extracts decisions from messages', () => {
    const decisions = extractSessionDecisions(sampleMessages);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions.some((d) => d.toLowerCase().includes('decided to'))).toBe(true);
  });

  it('extracts pending actions from messages', () => {
    const pending = extractPendingNextActions(sampleMessages);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some((p) => p.toLowerCase().includes('create the ipc handler') || p.toLowerCase().includes('pre-commit gates'))).toBe(true);
  });

  it('assembles structured handoff prompt and redacts secrets', () => {
    const result = assembleHandoffPrompt({
      sessionId: 'sess-old-123',
      sessionTitle: 'Session Compaction Implementation',
      workingDir: '/home/antigravity/th3ottoman-png/cindy',
      model: 'claude-3-7-sonnet',
      expertSlug: 'code-reviewer',
      messages: sampleMessages,
    });

    expect(result.sessionId).toBe('sess-old-123');
    expect(result.totalMessagesCount).toBe(4);
    expect(result.prompt).toContain('# Session Continuation & Handoff');
    expect(result.prompt).toContain('**Previous Session:** Session Compaction Implementation');
    expect(result.prompt).toContain('**Working Directory:** `/home/antigravity/th3ottoman-png/cindy`');
    expect(result.prompt).toContain('## Key Decisions Made');
    expect(result.prompt).toContain('## Pending Next Actions');
    expect(result.prompt).toContain('- [ ]');

    // Verify secret redaction
    expect(result.prompt).not.toContain('sk-secret1234567890123456');
    expect(result.prompt).toContain('[redacted]');
  });
});

describe('extractSessionConstraints (ROADMAP 11.5 follow-up)', () => {
  it('keeps the owner-stated constraints that the decisions extractor misses', () => {
    // The 2026-11-12 live wording. "never commit" was lost: section 1 fell back to
    // "Architectural baseline established in previous turns."
    const messages: HandoffMessage[] = [
      { role: 'assistant', content: 'Ready.' },
      {
        role: 'user',
        content:
          'Step 1 now: append alpha to notes.txt. Step 2 pending: append beta. Never commit, never touch any other file.',
      },
      { role: 'assistant', content: 'Step 1 done, next step: append beta to notes.txt' },
    ];
    expect(extractSessionConstraints(messages)).toEqual([
      'Never commit, never touch any other file.',
    ]);
  });

  it('reads each negative or exclusive instruction as its own item', () => {
    const messages: HandoffMessage[] = [
      {
        role: 'user',
        content:
          "Don't run the gates twice.\nOnly edit src/calc.js.\nKeep the public API unchanged.\nDo not commit.",
      },
    ];
    expect(extractSessionConstraints(messages)).toEqual([
      "Don't run the gates twice.",
      'Only edit src/calc.js.',
      'Keep the public API unchanged.',
      'Do not commit.',
    ]);
  });

  it('ignores assistant restatements, questions and ordinary prose', () => {
    const messages: HandoffMessage[] = [
      { role: 'user', content: 'Hi, please look at the failing test.' },
      { role: 'assistant', content: 'Do not worry, I never commit without asking.' },
      { role: 'user', content: 'Why would you never commit?' },
    ];
    expect(extractSessionConstraints(messages)).toEqual([]);
  });

  it('dedupes and caps the list', () => {
    const messages: HandoffMessage[] = Array.from({ length: 12 }, () => ({
      role: 'user',
      content: 'Never commit.',
    }));
    const items = extractSessionConstraints(messages);
    expect(items).toEqual(['Never commit.']);
  });
});

describe('extractPendingNextActions ignores completion statements (ROADMAP 11.5 follow-up)', () => {
  it('does not list a finished step as pending just because it says "pending"', () => {
    // Live 2026-11-13: a chained handoff's section 3 carried
    // "I have completed the pending task from the handoff: appended the line beta …".
    const messages: HandoffMessage[] = [
      { role: 'user', content: 'Step 2 pending: append the line beta to notes.txt.' },
      {
        role: 'assistant',
        content:
          'I have completed the pending task from the handoff: appended the line beta to /tmp/proofs/115-work/notes.txt.',
      },
    ];
    const pending = extractPendingNextActions(messages);
    expect(pending.join(' ')).not.toContain('completed the pending task');
  });

  it('keeps a real next step that also reports progress', () => {
    const messages: HandoffMessage[] = [
      { role: 'assistant', content: 'Step 1 done, next step: append beta to notes.txt.' },
    ];
    const pending = extractPendingNextActions(messages);
    expect(pending.join(' ')).toContain('append beta');
  });
});
