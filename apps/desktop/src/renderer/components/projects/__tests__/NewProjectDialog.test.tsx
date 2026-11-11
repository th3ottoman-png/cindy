// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from '../NewProjectDialog';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/state/newMakerDraft', () => ({
  patchDraft: vi.fn(),
  patchNewMakerDraft: vi.fn(),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (text: string) => ({ type: 'doc', text }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

describe('NewProjectDialog', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    window.electronAPI = {
      showOpenDirectoryDialog: vi.fn().mockResolvedValue({ canceled: false, path: '/workspace/test-proj' }),
      createProject: vi.fn().mockResolvedValue({
        ok: true,
        projectKey: 'local:/workspace/test-proj',
        workingDir: '/workspace/test-proj',
        name: 'test-proj',
        createdFiles: ['IDEA.md', '.gitignore'],
      }),
    } as any;
  });

  afterEach(cleanup);

  it('renders dialog with prefilled default path and name', () => {
    render(
      <NewProjectDialog
        open={true}
        onOpenChange={vi.fn()}
        defaultPath="/Users/turko/Cindy-Hermes"
      />,
    );

    expect(screen.getByText('New project')).toBeTruthy();
    expect(screen.getByText('Name a workspace and add one or more folders.')).toBeTruthy();
    expect(screen.getByDisplayValue('Cindy-Hermes')).toBeTruthy();
    expect(screen.getByText('/Users/turko/Cindy-Hermes')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
  });

  it('clicking idea template pill populates the textarea and name', () => {
    render(
      <NewProjectDialog
        open={true}
        onOpenChange={vi.fn()}
        defaultPath=""
      />,
    );

    const flashcardsBtn = screen.getByRole('button', { name: /Flashcards/i });
    fireEvent.click(flashcardsBtn);

    const textarea = screen.getByPlaceholderText("What's this project about? (saved to IDEA.md)") as HTMLTextAreaElement;
    expect(textarea.value).toContain('flashcard application');
  });

  it('submits form, calls createProject API, and navigates', async () => {
    const onProjectCreated = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <NewProjectDialog
        open={true}
        onOpenChange={onOpenChange}
        defaultPath="/Users/turko/Cindy-Hermes"
        onProjectCreated={onProjectCreated}
      />,
    );

    const createBtn = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(window.electronAPI.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Cindy-Hermes',
          primaryPath: '/Users/turko/Cindy-Hermes',
          initGit: true,
          createIdeaFile: true,
          createGitIgnore: true,
        }),
      );
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith('/cc-agent/new');
  });
});
