import { describe, it, expect } from 'vitest';
import { SessionHandoffHost } from '../sessionHandoff';

describe('sessionHandoff live proof (ROADMAP 7.8)', () => {
  it('live compiles session history into a fresh handoff continuation prompt', async () => {
    const realSessionId = 'live-session-8dc79b78';
    const realSessionRow = {
      id: realSessionId,
      title: 'Cindy Cloud Migration & Autonomous Phases',
      workingDir: '/home/antigravity/th3ottoman-png/cindy',
      model: 'deepseek-v4-pro',
      expertSlug: 'vault-researcher',
    };

    const realMessages = [
      {
        role: 'user',
        content: 'We need to advance Cindy roadmap phases 7.4 to 7.8 autonomously. Keep all gates green under Node 22.',
      },
      {
        role: 'assistant',
        content: 'Understood. We decided to build Phase 7.4 (git-vault sync) in packages/maker-core/src/notes/vault-git-sync.ts and Phase 7.5 (rule learner) in packages/maker-core/src/rules/rule-learner.ts.',
      },
      {
        role: 'user',
        content: 'Also make sure never to leak API keys like token="sk-proj-supersecretkey123456789".',
      },
      {
        role: 'assistant',
        content: 'Confirmed that secret redaction is active. Next step: complete Phase 7.8 clean handoff.\n- [ ] Wire 1-click continuation button.\n- [ ] Update ROADMAP.md and Project — Cindy.md.',
      },
    ];

    const host = new SessionHandoffHost({
      getSessionRow: async (id) => (id === realSessionId ? realSessionRow : null),
      listMessages: async (id) => (id === realSessionId ? realMessages : []),
    });

    const buildResult = await host.buildHandoff(realSessionId);
    expect(buildResult.ok).toBe(true);

    if (buildResult.ok) {
      const { handoff } = buildResult;
      expect(handoff.sessionId).toBe(realSessionId);
      expect(handoff.totalMessagesCount).toBe(4);
      expect(handoff.decisions.some((d) => d.toLowerCase().includes('decided to build'))).toBe(true);
      expect(handoff.touchedFiles.some((f) => f.includes('vault-git-sync.ts'))).toBe(true);
      expect(handoff.pendingActions.some((p) => p.includes('clean handoff'))).toBe(true);

      // Verify prompt structure
      expect(handoff.prompt).toContain('# Session Continuation & Handoff');
      expect(handoff.prompt).toContain('Cindy Cloud Migration & Autonomous Phases');
      expect(handoff.prompt).toContain('/home/antigravity/th3ottoman-png/cindy');
      expect(handoff.prompt).toContain('deepseek-v4-pro');
      expect(handoff.prompt).toContain('vault-researcher');

      // Verify credential redaction
      expect(handoff.prompt).not.toContain('sk-proj-supersecretkey123456789');
      expect(handoff.prompt).toContain('[redacted]');
    }

    const execResult = await host.executeHandoff(realSessionId);
    expect(execResult.ok).toBe(true);
    expect(execResult.title).toBe('Continuation of Cindy Cloud Migration & Autonomous Phases');
    expect(execResult.workingDir).toBe('/home/antigravity/th3ottoman-png/cindy');
    expect(execResult.model).toBe('deepseek-v4-pro');
    expect(execResult.expertSlug).toBe('vault-researcher');
    expect(execResult.prompt).toContain('# Session Continuation & Handoff');
  });
});
