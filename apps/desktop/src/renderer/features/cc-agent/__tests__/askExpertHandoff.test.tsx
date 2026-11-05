import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveDraft = vi.fn();
const resetDraftWorkspaceTargets = vi.fn();
const switchVendor = vi.fn();
const patchDraft = vi.fn();
const patchVendorPrefs = vi.fn();
const patchVendorPrefsPreservingModelChoice = vi.fn();

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: (...args: unknown[]) => saveDraft(...args),
  plainTextToTiptapDoc: (text: string) => ({ type: 'doc', plain: text }),
}));

vi.mock('@/state/newMakerDraft', () => ({
  resetDraftWorkspaceTargets: () => resetDraftWorkspaceTargets(),
  switchVendor: (v: unknown) => switchVendor(v),
  patchDraft: (p: unknown) => patchDraft(p),
  patchVendorPrefs: (v: unknown, p: unknown) => patchVendorPrefs(v, p),
  patchVendorPrefsPreservingModelChoice: (v: unknown, p: unknown) => patchVendorPrefsPreservingModelChoice(v, p),
}));

const { prefillExpertHandoffDraft, prefillGoAheadDraft } = await import('../lib/startExpertHandoff');
const { AskExpertMenuView, GO_AHEAD_VALUE } = await import('../AskExpertMenu');

describe('Ask expert (ROADMAP 3.6b)', () => {
  beforeEach(() => {
    saveDraft.mockClear();
    resetDraftWorkspaceTargets.mockClear();
    switchVendor.mockClear();
    patchDraft.mockClear();
    patchVendorPrefs.mockClear();
    patchVendorPrefsPreservingModelChoice.mockClear();
  });

  it('prefills a clean Hermes new-task draft with the handoff text and sends nothing', () => {
    prefillExpertHandoffDraft('The owner wants your take…');
    expect(saveDraft).toHaveBeenCalledWith('__new_maker_draft__', {
      text: { type: 'doc', plain: 'The owner wants your take…' },
      attachments: [],
    });
    expect(resetDraftWorkspaceTargets).toHaveBeenCalledTimes(1);
    expect(switchVendor).toHaveBeenCalledWith('hermes');
    expect(patchVendorPrefs).not.toHaveBeenCalled();
  });

  it('prefills expert model into Hermes draft preferences when model is present', () => {
    prefillExpertHandoffDraft('Take a look', 'deepseek-v4-pro');
    expect(switchVendor).toHaveBeenCalledWith('hermes');
    expect(patchVendorPrefs).toHaveBeenCalledWith('hermes', { model: 'deepseek-v4-pro' });
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
    expect(html).toContain('Ask expert (new task)…');
    expect(html).toContain('value="code-reviewer"');
    expect(html).toContain('Code Reviewer (new task)');
    expect(html).not.toContain('value="codex-one"');
    expect(html).not.toContain('value="broken"');
  });

  it('renders nothing when there is no Hermes expert to ask', () => {
    expect(renderToStaticMarkup(<AskExpertMenuView entries={[]} busy={false} onPick={() => undefined} />)).toBe('');
  });
});

describe('"Go ahead" (ROADMAP 3.10c)', () => {
  beforeEach(() => {
    saveDraft.mockClear();
    resetDraftWorkspaceTargets.mockClear();
    switchVendor.mockClear();
    patchDraft.mockClear();
    patchVendorPrefsPreservingModelChoice.mockClear();
  });

  it('prefills a Hermes draft in the source folder with the source access level, and sends nothing', () => {
    prefillGoAheadDraft('Carry out the option…', { workingDir: '/projects/modoki', permissionMode: 'bypassPermissions' });
    expect(saveDraft).toHaveBeenCalledWith('__new_maker_draft__', { text: { type: 'doc', plain: 'Carry out the option…' }, attachments: [] });
    expect(resetDraftWorkspaceTargets).toHaveBeenCalledTimes(1);
    expect(patchDraft).toHaveBeenCalledWith({ workingDir: '/projects/modoki' });
    expect(resetDraftWorkspaceTargets.mock.invocationCallOrder[0]).toBeLessThan(patchDraft.mock.invocationCallOrder[0]);
    expect(switchVendor).toHaveBeenCalledWith('hermes');
    expect(patchVendorPrefsPreservingModelChoice).toHaveBeenCalledWith('hermes', { permissionMode: 'bypassPermissions' });
  });

  it('leaves folder and access alone when the source has none or an unknown access value', () => {
    prefillGoAheadDraft('x', { workingDir: null, permissionMode: 'something-else' });
    expect(resetDraftWorkspaceTargets).toHaveBeenCalledTimes(1);
    expect(patchDraft).not.toHaveBeenCalled();
    expect(patchVendorPrefsPreservingModelChoice).not.toHaveBeenCalled();
  });

  it('offers Go ahead first in a locked chat, even with no expert to ask', () => {
    const html = renderToStaticMarkup(<AskExpertMenuView entries={[]} goAhead busy={false} onPick={() => undefined} />);
    expect(html).toContain(`value="${GO_AHEAD_VALUE}"`);
    expect(html).toContain('Go ahead');
    const plain = renderToStaticMarkup(<AskExpertMenuView entries={[]} busy={false} onPick={() => undefined} />);
    expect(plain).toBe('');
  });
});
