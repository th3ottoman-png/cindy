import { describe, it, expect } from 'vitest';
import {
  assembleHandoffPrompt,
  extractSessionDecisions,
  extractTouchedFiles,
  extractPendingNextActions,
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
