// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseImportedAgent } from '@cindy/maker-core/imported-agents';

import { AgentDetailDrawer } from '../AgentDetailDrawer';
import { NewAgentForm, buildCreatorBrief } from '../NewAgentForm';
import { buildRosterRows } from '../agentsRosterModel';

const importedRow = buildRosterRows([], [
  parseImportedAgent('---\nname: Historian\ndescription: History.\n---\nYou are history.', {
    source: 'claude-user',
    absolutePath: '/home/o/.claude/agents/historian.md',
    relPath: 'historian.md',
  }),
])[0];

let mockSave: ReturnType<typeof vi.fn>;
let mockCopy: ReturnType<typeof vi.fn>;
let mockSetPending: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockSave = vi.fn().mockResolvedValue({ ok: true, slug: 'form-agent', dir: '/x', file: '/x/expert.md', hash: 'h' });
  mockCopy = vi.fn().mockResolvedValue({ ok: true, slug: 'historian', dir: '/x', file: '/x/expert.md' });
  mockSetPending = vi.fn().mockResolvedValue('expert-creator');
  window.electronAPI = {
    maker: {
      experts: { save: mockSave, setPending: mockSetPending },
      importedAgents: { copyToExpert: mockCopy },
    },
    showItemInFolder: vi.fn().mockResolvedValue({ success: true }),
  } as any;
});
afterEach(() => {
  cleanup();
  delete (window as any).electronAPI;
});

describe('buildCreatorBrief', () => {
  it('carries every form field to the expert creator', () => {
    const brief = buildCreatorBrief({
      name: 'Form Agent',
      description: 'Does form things.',
      agent: 'claude-code',
      model: 'local-small',
      maxConcurrent: 2,
      prompt: 'You are a form agent.',
    });
    expect(brief).toContain('Name: Form Agent');
    expect(brief).toContain('When other agents should bring it in: Does form things.');
    expect(brief).toContain('Program: claude-code');
    expect(brief).toContain('Model route: local-small');
    expect(brief).toContain('Conversations at once: 2');
    expect(brief).toContain('You are a form agent.');
  });

  it('marks empty fields for the creator to propose', () => {
    const brief = buildCreatorBrief({ name: '', description: '', agent: 'hermes', model: '', maxConcurrent: 1, prompt: '' });
    expect(brief).toContain('(choose a good name)');
    expect(brief).toContain('inherit the session model');
  });
});

describe('NewAgentForm', () => {
  const rows = buildRosterRows([], []);

  it('saves through EXPERTS_SAVE create-from-form with the derived slug', async () => {
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <NewAgentForm rows={rows} routes={{ 'local-small': { model: 'qwen3-8b' } }} workingDir={null} onClose={() => undefined} onSaved={onSaved} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'Form Agent' } });
    fireEvent.change(screen.getByTestId('new-agent-description'), { target: { value: 'Does form things.' } });
    fireEvent.change(screen.getByTestId('new-agent-prompt'), { target: { value: 'You are a form agent.' } });
    fireEvent.change(screen.getByTestId('new-agent-program'), { target: { value: 'claude-code' } });
    fireEvent.change(screen.getByTestId('new-agent-max-concurrent'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('new-agent-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('form-agent'));
    expect(mockSave).toHaveBeenCalledWith({
      op: 'create-from-form',
      slug: 'form-agent',
      fields: {
        name: 'Form Agent',
        description: 'Does form things.',
        agent: 'claude-code',
        maxConcurrent: 2,
        prompt: 'You are a form agent.',
      },
    });
  });

  it('shows the save refusal inline', async () => {
    mockSave.mockResolvedValue({ ok: false, reason: 'invalid', message: '"description" is required' });
    render(
      <MemoryRouter>
        <NewAgentForm rows={rows} routes={{}} workingDir={null} onClose={() => undefined} onSaved={() => undefined} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'Form Agent' } });
    fireEvent.click(screen.getByTestId('new-agent-save'));
    await waitFor(() => expect(screen.getByTestId('new-agent-result').textContent).toContain('"description" is required'));
  });

  it('Generate with model picks the expert creator and prefills the brief', async () => {
    const creatorRows = buildRosterRows([{
      slug: 'expert-creator',
      dir: '/x/expert-creator',
      expert: {
        slug: 'expert-creator', dir: '/x/expert-creator', name: 'Expert Creator', description: 'Creates experts.',
        agent: 'hermes', tools: ['draft_expert'], skills: [], memory: false, tags: [], prompt: 'p', skillFiles: [],
      },
    }], []);
    render(
      <MemoryRouter>
        <NewAgentForm rows={creatorRows} routes={{}} workingDir={null} onClose={() => undefined} onSaved={() => undefined} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'Form Agent' } });
    fireEvent.click(screen.getByTestId('new-agent-generate'));
    await waitFor(() => expect(mockSetPending).toHaveBeenCalledWith('expert-creator'));
  });
});

describe('AgentDetailDrawer', () => {
  it('copies an imported agent to the experts and reports the slug', async () => {
    render(
      <MemoryRouter>
        <AgentDetailDrawer row={importedRow} onClose={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('agent-detail-path').textContent).toBe('/home/o/.claude/agents/historian.md');
    fireEvent.click(screen.getByTestId('agent-detail-copy'));
    await waitFor(() => expect(screen.getByTestId('agent-copy-result').textContent).toContain('experts/historian'));
    expect(mockCopy).toHaveBeenCalledWith('imported:claude-user:historian.md');
  });
});
