import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveDraft = vi.fn();
const resetDraftWorkspaceTargets = vi.fn();
const switchVendor = vi.fn();

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: (...args: unknown[]) => saveDraft(...args),
  plainTextToTiptapDoc: (text: string) => ({ type: 'doc', plain: text }),
}));

vi.mock('@/state/newMakerDraft', () => ({
  resetDraftWorkspaceTargets: () => resetDraftWorkspaceTargets(),
  switchVendor: (v: unknown) => switchVendor(v),
}));

const { prefillExpertHandoffDraft } = await import('../lib/startExpertHandoff');
const { AskExpertMenuView } = await import('../AskExpertMenu');

describe('Ask expert (ROADMAP 3.6b)', () => {
  beforeEach(() => {
    saveDraft.mockClear();
    resetDraftWorkspaceTargets.mockClear();
    switchVendor.mockClear();
  });

  it('prefills a clean Hermes new-task draft with the handoff text and sends nothing', () => {
    prefillExpertHandoffDraft('The owner wants your take…');
    expect(saveDraft).toHaveBeenCalledWith('__new_maker_draft__', {
      text: { type: 'doc', plain: 'The owner wants your take…' },
      attachments: [],
    });
    expect(resetDraftWorkspaceTargets).toHaveBeenCalledTimes(1);
    expect(switchVendor).toHaveBeenCalledWith('hermes');
  });

  it('offers only loadable Hermes experts', () => {
    const html = renderToStaticMarkup(
      <AskExpertMenuView
        entries={[
          { slug: 'code-reviewer', dir: '/e/code-reviewer', expert: { slug: 'code-reviewer', dir: '/e/code-reviewer', name: 'Code Reviewer', description: '', agent: 'hermes', tools: [], skills: [], memory: false, tags: [], prompt: 'p', skillFiles: [] } },
          { slug: 'codex-one', dir: '/e/codex-one', expert: { slug: 'codex-one', dir: '/e/codex-one', name: 'Codex One', description: '', agent: 'codex', tools: [], skills: [], memory: false, tags: [], prompt: 'p', skillFiles: [] } },
          { slug: 'broken', dir: '/e/broken', error: 'bad' },
        ]}
        busy={false}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="ask-expert"');
    expect(html).toContain('Ask expert');
    expect(html).toContain('value="code-reviewer"');
    expect(html).not.toContain('value="codex-one"');
    expect(html).not.toContain('value="broken"');
  });

  it('renders nothing when there is no Hermes expert to ask', () => {
    expect(renderToStaticMarkup(<AskExpertMenuView entries={[]} busy={false} onPick={() => undefined} />)).toBe('');
  });
});
