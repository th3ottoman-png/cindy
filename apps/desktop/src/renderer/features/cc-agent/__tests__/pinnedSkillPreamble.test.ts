// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyPinnedSkillsForTurn } from '../pinnedSkillPreamble';

const resolvePinned = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  resolvePinned.mockReset();
});

function stubApi(skills: unknown): void {
  vi.stubGlobal('window', { electronAPI: skills === undefined ? undefined : { maker: { skills } } });
}

describe('applyPinnedSkillsForTurn (ROADMAP 11.1 Tier 2B)', () => {
  it('injects the full SKILL.md body and strips the pin for one turn', async () => {
    resolvePinned.mockResolvedValue({
      skills: [{
        slug: 'git-worktree',
        name: 'git-worktree',
        instructions: '# Steps\n1. Add a worktree.\n',
        truncated: false,
        availableScripts: ['scripts/add.sh'],
        availableReferences: [],
      }],
      knownSlugs: ['git-worktree'],
      estimatedDiscoveryTokens: 42,
    });
    stubApi({ resolvePinned });

    const out = await applyPinnedSkillsForTurn('review @skill:git-worktree this diff');
    expect(resolvePinned).toHaveBeenCalledWith({ text: 'review @skill:git-worktree this diff', chatOnly: undefined });
    expect(out).toContain('<pinned_skills>');
    expect(out).toContain('# Steps');
    expect(out).toContain('scripts/add.sh');
    expect(out).not.toContain('@skill:git-worktree');
    expect(out).toContain('review this diff');
  });

  it('supports the /name slash form', async () => {
    resolvePinned.mockResolvedValue({
      skills: [{ slug: 'code-review', name: 'code-review', instructions: 'Check the diff.', truncated: false, availableScripts: [], availableReferences: [] }],
      knownSlugs: ['code-review'],
      estimatedDiscoveryTokens: 20,
    });
    stubApi({ resolvePinned });
    const out = await applyPinnedSkillsForTurn('/code-review please');
    expect(out).toContain('Check the diff.');
    expect(out).not.toContain('/code-review');
  });

  it('does not call IPC when the message has no pin-shaped text', async () => {
    stubApi({ resolvePinned });
    const text = 'just a normal question about routing';
    expect(await applyPinnedSkillsForTurn(text)).toBe(text);
    expect(resolvePinned).not.toHaveBeenCalled();
  });

  it('fails closed in chat-only mode', async () => {
    stubApi({ resolvePinned });
    const text = 'review @skill:git-worktree';
    expect(await applyPinnedSkillsForTurn(text, { chatOnly: true })).toBe(text);
    expect(resolvePinned).not.toHaveBeenCalled();
  });

  it('fails open when the preload API is missing', async () => {
    stubApi(undefined);
    const text = 'review @skill:git-worktree';
    expect(await applyPinnedSkillsForTurn(text)).toBe(text);
  });

  it('fails open when the IPC rejects, leaving the message byte-identical', async () => {
    resolvePinned.mockRejectedValue(new Error('daemon down'));
    stubApi({ resolvePinned });
    const text = 'review @skill:git-worktree';
    expect(await applyPinnedSkillsForTurn(text)).toBe(text);
  });

  it('leaves the message alone when no skill resolved (unknown slug)', async () => {
    resolvePinned.mockResolvedValue({ skills: [], knownSlugs: [], estimatedDiscoveryTokens: 0 });
    stubApi({ resolvePinned });
    const text = 'use @skill:missing here';
    expect(await applyPinnedSkillsForTurn(text)).toBe(text);
  });
});
