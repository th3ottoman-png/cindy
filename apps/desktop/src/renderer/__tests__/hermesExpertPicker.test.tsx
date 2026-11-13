// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExpertEntry } from '@cindy/maker-core/experts';
import { parseImportedAgent, type ImportedAgent } from '@cindy/maker-core/imported-agents';

import { HermesExpertLabelView } from '@/features/cc-agent/HermesExpertLabel';
import {
  HermesExpertPicker,
  HermesExpertPickerView,
  buildExpertOptions,
  buildImportedAgentOptions,
  resolveExpertDraftModel,
} from '@/features/cc-agent/HermesExpertPicker';
import { patchVendorPrefs } from '@/state/newMakerDraft';

vi.mock('@/state/newMakerDraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state/newMakerDraft')>();
  return { ...actual, patchVendorPrefs: vi.fn() };
});

const importedAgent = (tools: string, extra: { name?: string } = {}): ImportedAgent =>
  parseImportedAgent(
    `---\nname: ${extra.name ?? 'Imported Reviewer'}\ndescription: Reviews.\ntools: ${tools}\nmodel: opus\n---\nYou are imported.`,
    { source: 'claude-user', absolutePath: '/home/o/.claude/agents/reviewer.md', relPath: 'reviewer.md' },
  );

const expert = (slug: string, extra: Partial<NonNullable<ExpertEntry['expert']>> = {}): ExpertEntry => ({
  slug,
  dir: `/home/o/.cindy-harness/experts/${slug}`,
  expert: {
    slug,
    dir: `/home/o/.cindy-harness/experts/${slug}`,
    name: slug,
    description: '',
    agent: 'hermes',
    tools: [],
    skills: [],
    memory: false,
    tags: [],
    prompt: 'p',
    skillFiles: [],
    ...extra,
  },
});

describe('Hermes expert picker (ROADMAP 3.2a)', () => {
  it('offers Hermes experts and lists broken or non-Hermes ones as unpickable', () => {
    const options = buildExpertOptions([
      expert('code-reviewer', { name: 'Code Reviewer', model: 'local-backup', description: 'Reviews diffs' }),
      expert('codex-one', { name: 'Codex One', agent: 'codex' }),
      { slug: 'broken', dir: '/x/broken', error: 'frontmatter "name" is required' },
    ]);
    expect(options).toEqual([
      {
        slug: 'code-reviewer',
        label: 'Code Reviewer',
        disabled: false,
        title: 'Reviews diffs\nModel route: local-backup\n/home/o/.cindy-harness/experts/code-reviewer',
      },
      { slug: 'codex-one', label: 'Codex One (codex)', disabled: true, title: 'Configured for codex; current agent is hermes.' },
      { slug: 'broken', label: 'broken (broken)', disabled: true, title: 'frontmatter "name" is required' },
    ]);

    const html = renderToStaticMarkup(
      <HermesExpertPickerView options={options} value="code-reviewer" onChange={() => undefined} />,
    );
    expect(html).toContain('data-testid="hermes-expert-picker"');
    expect(html).toContain('<option value="">No expert</option>');
    expect(html).toMatch(/<option value="codex-one" disabled=""/);
    expect(html).toMatch(/<option value="code-reviewer"[^>]*selected=""/);
  });

  it('offers experts matching the active vendor (ROADMAP 3.2)', () => {
    const options = buildExpertOptions([
      expert('code-reviewer', { name: 'Code Reviewer', agent: 'hermes' }),
      expert('codex-one', { name: 'Codex One', agent: 'codex', description: 'Codex helper' }),
    ], 'codex');
    expect(options).toEqual([
      { slug: 'code-reviewer', label: 'Code Reviewer (hermes)', disabled: true, title: 'Configured for hermes; current agent is codex.' },
      {
        slug: 'codex-one',
        label: 'Codex One',
        disabled: false,
        title: 'Codex helper\n/home/o/.cindy-harness/experts/codex-one',
      },
    ]);
  });

  it('renders nothing when there are no experts, so the toolbar is unchanged', () => {
    expect(renderToStaticMarkup(<HermesExpertPickerView options={[]} value={null} onChange={() => undefined} />)).toBe('');
  });

  it('imported agents are pickable when they run on the vendor, blocked tools are named (ROADMAP 12.1)', () => {
    const options = buildImportedAgentOptions([
      importedAgent('Read, Grep'),
      importedAgent('Read, WebSearch', { name: 'Web Agent' }),
    ]);
    expect(options[0]).toEqual({
      slug: 'imported:claude-user:reviewer.md',
      label: 'Imported Reviewer (imported · claude-user)',
      disabled: false,
      title: 'Reviews.\nDeclared model: opus (not mapped; the session keeps its own model)\n/home/o/.claude/agents/reviewer.md',
    });
    expect(options[1].disabled).toBe(true);
    expect(options[1].title).toContain('WebSearch');
    // The blocked agent runs on Claude Code.
    const claude = buildImportedAgentOptions([importedAgent('Read, WebSearch')], 'claude-code');
    expect(claude[0].disabled).toBe(false);
    // A malformed file is listed but never pickable.
    const broken = buildImportedAgentOptions([
      parseImportedAgent('---\nname: [unclosed\n---\nBody.', { source: 'qwen-user', absolutePath: '/x/bad.md', relPath: 'bad.md' }),
    ]);
    expect(broken[0].disabled).toBe(true);
    expect(broken[0].label).toContain('(broken)');
  });

  it('header chip shows imported · source · name and the foreign file path (ROADMAP 12.1)', () => {
    const html = renderToStaticMarkup(
      <HermesExpertLabelView
        binding={{
          sessionId: 's1',
          slug: 'imported:claude-user:reviewer.md',
          dir: '/home/o/.claude/agents/reviewer.md',
          name: 'Imported Reviewer',
          imported: { source: 'claude-user', absolutePath: '/home/o/.claude/agents/reviewer.md' },
        }}
      />,
    );
    expect(html).toContain('data-testid="hermes-session-expert"');
    expect(html).toContain('imported · claude-user · Imported Reviewer');
    expect(html).toContain('/home/o/.claude/agents/reviewer.md');
  });

  it('header chip names the expert and shows its folder; a broken expert stays visible', () => {
    const html = renderToStaticMarkup(
      <HermesExpertLabelView binding={{ sessionId: 's1', slug: 'code-reviewer', dir: '/e/code-reviewer', name: 'Code Reviewer', model: 'local-backup' }} />,
    );
    expect(html).toContain('data-testid="hermes-session-expert"');
    expect(html).toContain('>Code Reviewer</span>');
    expect(html).toContain('Model route: local-backup');
    expect(html).toContain('/e/code-reviewer');

    const broken = renderToStaticMarkup(
      <HermesExpertLabelView binding={{ sessionId: 's1', slug: 'code-reviewer', dir: '/e/code-reviewer', error: 'expert.md is missing' }} />,
    );
    expect(broken).toContain('code-reviewer (broken)');
    expect(broken).toContain('expert.md is missing');
    expect(renderToStaticMarkup(<HermesExpertLabelView binding={null} />)).toBe('');
  });

  describe('resolveExpertDraftModel', () => {
    it('returns empty string for empty or whitespace-only model', () => {
      expect(resolveExpertDraftModel('')).toBe('');
      expect(resolveExpertDraftModel('   ')).toBe('');
    });

    it('returns model directly when no routing is available or route is not found', () => {
      expect(resolveExpertDraftModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
      expect(resolveExpertDraftModel('local-custom', { routes: {} })).toBe('local-custom');
    });

    it('resolves route name to target model when defined in routing.routes', () => {
      const routing = {
        routes: {
          'local-small': { model: 'qwen3-8b' },
          'gemma-local': { model: 'google/gemma-4-26b-a4b-qat' },
        },
      };
      expect(resolveExpertDraftModel('local-small', routing)).toBe('qwen3-8b');
      expect(resolveExpertDraftModel('gemma-local', routing)).toBe('google/gemma-4-26b-a4b-qat');
    });
  });

  describe('HermesExpertPicker auto-model selection (ROADMAP 3.2)', () => {
    let mockList: any;
    let mockGetPending: any;
    let mockSetPending: any;
    let mockOnChanged: any;
    let mockOnSessionEvent: any;
    let mockGetRouting: any;

    beforeEach(() => {
      mockList = vi.fn().mockResolvedValue([
        expert('code-reviewer', { name: 'Code Reviewer', model: 'local-small' }),
        expert('plain-expert', { name: 'Plain Expert' }),
        expert('analyst', { name: 'Analyst', model: 'deepseek-v4-pro' }),
      ]);
      mockGetPending = vi.fn().mockResolvedValue(null);
      mockSetPending = vi.fn().mockResolvedValue('ok');
      mockOnChanged = vi.fn().mockReturnValue(() => undefined);
      mockOnSessionEvent = vi.fn().mockReturnValue(() => undefined);
      mockGetRouting = vi.fn().mockResolvedValue({
        routes: {
          'local-small': { model: 'qwen3-8b' },
        },
      });

      window.electronAPI = {
        maker: {
          experts: {
            list: mockList,
            getPending: mockGetPending,
            setPending: mockSetPending,
            onChanged: mockOnChanged,
            onSessionEvent: mockOnSessionEvent,
          },
          importedAgents: {
            list: vi.fn().mockResolvedValue({ agents: [importedAgent('Read, Grep')], capped: false }),
            onChanged: vi.fn().mockReturnValue(() => undefined),
          },
          providers: {
            getRouting: mockGetRouting,
          },
        },
      } as any;
    });

    afterEach(() => {
      cleanup();
      delete (window as any).electronAPI;
    });

    it('auto-selects resolved expert model on mount when an expert is pending', async () => {
      mockGetPending.mockResolvedValue('code-reviewer');
      const onSelectModel = vi.fn();

      render(<HermesExpertPicker onSelectModel={onSelectModel} />);

      await waitFor(() => {
        expect(onSelectModel).toHaveBeenCalledWith('qwen3-8b');
      });
    });

    it('auto-selects expert model when expert selection changes in the picker', async () => {
      const onSelectModel = vi.fn();
      render(<HermesExpertPicker onSelectModel={onSelectModel} />);

      await waitFor(() => {
        expect(screen.getByTestId('hermes-expert-picker')).toBeTruthy();
      });

      // Select 'analyst' (model: deepseek-v4-pro)
      fireEvent.change(screen.getByTestId('hermes-expert-picker'), { target: { value: 'analyst' } });

      await waitFor(() => {
        expect(mockSetPending).toHaveBeenCalledWith('analyst');
        expect(onSelectModel).toHaveBeenCalledWith('deepseek-v4-pro');
      });
    });

    it('does not call onSelectModel when an expert has no configured model', async () => {
      const onSelectModel = vi.fn();
      render(<HermesExpertPicker onSelectModel={onSelectModel} />);

      await waitFor(() => {
        expect(screen.getByTestId('hermes-expert-picker')).toBeTruthy();
      });

      fireEvent.change(screen.getByTestId('hermes-expert-picker'), { target: { value: 'plain-expert' } });

      await waitFor(() => {
        expect(mockSetPending).toHaveBeenCalledWith('plain-expert');
      });
      expect(onSelectModel).not.toHaveBeenCalled();
    });

    it('does not clobber user manual model change on re-render', async () => {
      mockGetPending.mockResolvedValue('code-reviewer');
      const onSelectModel = vi.fn();

      const { rerender } = render(<HermesExpertPicker onSelectModel={onSelectModel} />);

      await waitFor(() => {
        expect(onSelectModel).toHaveBeenCalledTimes(1);
        expect(onSelectModel).toHaveBeenCalledWith('qwen3-8b');
      });

      // User subsequently changed model manually in the draft -> re-renders picker
      rerender(<HermesExpertPicker onSelectModel={onSelectModel} />);

      // onSelectModel should not be called again because the expert slug did not change
      expect(onSelectModel).toHaveBeenCalledTimes(1);
    });

    it('clears applied tracking when switching back to No expert', async () => {
      const onSelectModel = vi.fn();
      render(<HermesExpertPicker onSelectModel={onSelectModel} />);

      await waitFor(() => {
        expect(screen.getByTestId('hermes-expert-picker')).toBeTruthy();
      });

      // Pick code-reviewer
      fireEvent.change(screen.getByTestId('hermes-expert-picker'), { target: { value: 'code-reviewer' } });
      await waitFor(() => {
        expect(onSelectModel).toHaveBeenCalledWith('qwen3-8b');
      });

      // Switch to No expert
      fireEvent.change(screen.getByTestId('hermes-expert-picker'), { target: { value: '' } });
      await waitFor(() => {
        expect(mockSetPending).toHaveBeenCalledWith(null);
      });

      // Pick code-reviewer again -> should apply model again
      fireEvent.change(screen.getByTestId('hermes-expert-picker'), { target: { value: 'code-reviewer' } });
      await waitFor(() => {
        expect(onSelectModel).toHaveBeenCalledTimes(2);
      });
    });

    it('fallback model apply keys vendor prefs by the DB form (cc, not claude-code)', async () => {
      mockGetPending.mockResolvedValue('code-reviewer');
      render(<HermesExpertPicker activeVendor="claude-code" />);
      await waitFor(() => {
        expect(patchVendorPrefs).toHaveBeenCalledWith('cc', { model: 'qwen3-8b' });
      });
    });

    it('lists imported agents and picks one with the project dir, never applying its model (ROADMAP 12.1)', async () => {
      const onSelectModel = vi.fn();
      render(<HermesExpertPicker onSelectModel={onSelectModel} projectDir="/proj" />);

      await waitFor(() => {
        expect(screen.getByTestId('hermes-expert-picker')).toBeTruthy();
      });
      const select = screen.getByTestId('hermes-expert-picker') as HTMLSelectElement;
      const option = Array.from(select.options).find((o) => o.value === 'imported:claude-user:reviewer.md');
      expect(option?.textContent).toBe('Imported Reviewer (imported · claude-user)');

      fireEvent.change(select, { target: { value: 'imported:claude-user:reviewer.md' } });
      await waitFor(() => {
        expect(mockSetPending).toHaveBeenCalledWith('imported:claude-user:reviewer.md', '/proj');
      });
      expect(onSelectModel).not.toHaveBeenCalled();
    });
  });
});

describe('Hermes expert draft card (ROADMAP 3.8)', () => {
  it('shows the exact expert.md, where it goes, and Approve / Reject', async () => {
    const { HermesExpertDraftCardView } = await import('@/features/cc-agent/HermesExpertDraftCard');
    const html = renderToStaticMarkup(
      <HermesExpertDraftCardView
        request={{
          requestId: 'r1',
          sessionId: 's1',
          draft: { slug: 'uk-cold-email', name: 'UK Cold Email Writer', description: 'Writes cold emails.', tags: ['sales'], memory: false, prompt: 'p' },
          targetDir: '/home/o/.cindy-harness/experts/uk-cold-email',
          markdown: '---\nname: UK Cold Email Writer\n---\nYou write <b>cold</b> emails.\n',
          createdAt: 0,
          expiresAt: 1,
        }}
        busy={false}
        note=""
        onNoteChange={() => undefined}
        onDecide={() => undefined}
      />,
    );
    expect(html).toContain('New expert draft: UK Cold Email Writer');
    expect(html).toContain('/home/o/.cindy-harness/experts/uk-cold-email/expert.md');
    expect(html).toContain('You write &lt;b&gt;cold&lt;/b&gt; emails.');
    expect(html).toContain('session model (no route set)');
    expect(html).toContain('data-testid="hermes-expert-draft-approve"');
    expect(html).toContain('data-testid="hermes-expert-draft-reject"');
  });

  it('does not duplicate Model/Memory/Tags in header dl when model is set, letting YAML preview show them without repeating', async () => {
    const { HermesExpertDraftCardView } = await import('@/features/cc-agent/HermesExpertDraftCard');
    const html = renderToStaticMarkup(
      <HermesExpertDraftCardView
        request={{
          requestId: 'r2',
          sessionId: 's2',
          draft: { slug: 'uk-fm', name: 'UK FM Writer', description: 'Writes.', model: 'deepseek-v4-pro', tags: ['sales'], memory: true, prompt: 'p' },
          targetDir: '/home/o/.cindy-harness/experts/uk-fm',
          markdown: '---\nname: UK FM Writer\nmodel: deepseek-v4-pro\nmemory: true\ntags:\n  - sales\n---\nPrompt\n',
          createdAt: 0,
          expiresAt: 1,
        }}
        busy={false}
        note=""
        onNoteChange={() => undefined}
        onDecide={() => undefined}
      />,
    );
    expect(html).toContain('Writes');
    expect(html).toContain('/home/o/.cindy-harness/experts/uk-fm/expert.md');
    // Header dl does not repeat Model/Memory/Tags rows since markdown YAML preview already displays them
    expect(html).not.toMatch(/<dt[^>]*>Memory<\/dt>/);
    expect(html).not.toMatch(/<dt[^>]*>Tags<\/dt>/);
    expect(html).not.toMatch(/<dt[^>]*>Model<\/dt>/);
  });
});
