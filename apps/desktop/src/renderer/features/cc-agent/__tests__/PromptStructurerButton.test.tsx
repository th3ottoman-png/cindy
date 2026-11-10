// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromptStructurerButton, PromptStructurerButtonView } from '../PromptStructurerButton';
import type { StructuredPromptResult } from '@cindy/maker-core/prompt-structurer';

describe('PromptStructurerButton', () => {
  it('renders disabled when draft is empty', () => {
    const draftIo = {
      getDraft: vi.fn().mockReturnValue(undefined),
      saveDraft: vi.fn(),
    };

    render(
      <PromptStructurerButton
        draftKey="session-1"
        draftIo={draftIo}
      />,
    );

    const btn = screen.getByTestId('prompt-structurer-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders enabled when draft has text', () => {
    const draftIo = {
      getDraft: vi.fn().mockReturnValue({
        text: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Hey I want to build screen redaction' }],
            },
          ],
        },
        attachments: [],
      }),
      saveDraft: vi.fn(),
    };

    render(
      <PromptStructurerButton
        draftKey="session-1"
        draftIo={draftIo}
      />,
    );

    const btn = screen.getByTestId('prompt-structurer-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('clicks button to refine draft and saves structured result to draft store', async () => {
    const fakeDraft = {
      text: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hey so basically we need to add feature X. Avoid cloud.' }],
          },
        ],
      },
      attachments: [],
    };

    const saveDraftMock = vi.fn();
    const draftIo = {
      getDraft: vi.fn().mockReturnValue(fakeDraft),
      saveDraft: saveDraftMock,
    };

    const mockRefine: StructuredPromptResult = {
      raw: 'Hey so basically we need to add feature X. Avoid cloud.',
      structuredMarkdown: '## Goal\nAdd feature X\n\n## Guardrails & Constraints\n- Avoid cloud.',
      sections: {
        goal: 'Add feature X',
        context: '',
        guardrails: ['Avoid cloud.'],
        doneCriteria: [],
      },
    };

    const refineApi = vi.fn().mockResolvedValue(mockRefine);

    render(
      <PromptStructurerButton
        draftKey="session-1"
        draftIo={draftIo}
        refineApi={refineApi}
      />,
    );

    const btn = screen.getByTestId('prompt-structurer-button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(refineApi).toHaveBeenCalledWith('Hey so basically we need to add feature X. Avoid cloud.');
    });

    expect(saveDraftMock).toHaveBeenCalledTimes(1);
    const savedArg = saveDraftMock.mock.calls[0][1];
    expect(savedArg.focusAtEnd).toBe(true);
    expect(savedArg.text).toBeDefined();
  });

  it('triggers refinement via Cmd+Shift+P keyboard shortcut', async () => {
    const fakeDraft = {
      text: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Fix the failing tests.' }],
          },
        ],
      },
      attachments: [],
    };

    const saveDraftMock = vi.fn();
    const draftIo = {
      getDraft: vi.fn().mockReturnValue(fakeDraft),
      saveDraft: saveDraftMock,
    };

    const refineApi = vi.fn().mockResolvedValue({
      raw: 'Fix the failing tests.',
      structuredMarkdown: '## Goal\nFix the failing tests.',
      sections: { goal: 'Fix the failing tests', context: '', guardrails: [], doneCriteria: [] },
    });

    render(
      <PromptStructurerButton
        draftKey="session-1"
        draftIo={draftIo}
        refineApi={refineApi}
      />,
    );

    // Fire Cmd+Shift+P
    fireEvent.keyDown(window, {
      key: 'p',
      metaKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(refineApi).toHaveBeenCalledWith('Fix the failing tests.');
    });
    expect(saveDraftMock).toHaveBeenCalled();
  });
});
