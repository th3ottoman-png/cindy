// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@/i18n';
import { AgentActionsBlock } from '@/components/chat/AgentActionsBlock';
import type { ChatMessage } from '@/lib/makerChatStore';
import { resetResponsePreferencesForTests, writeResponsePreferences } from '@/lib/responsePreferences';

function toolCall(clientId: string, toolName: string, toolInput: unknown): ChatMessage {
  return { clientId, role: 'tool_use', content: '', toolName, toolInput } as ChatMessage;
}

const CALLS = [
  toolCall('t1', 'Bash', { command: 'pwd' }),
  toolCall('t2', 'Bash', { command: 'ls -1 | head -5' }),
];
const RESULTS = new Map([
  ['t1', '/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy'],
  ['t2', 'apps\npackages\nscripts'],
]);

function renderBlock() {
  return render(
    <AgentActionsBlock renderItemKey="actions-block-test" toolCalls={CALLS} resultMap={RESULTS} />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetResponsePreferencesForTests();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetResponsePreferencesForTests();
});

describe('response style in the transcript', () => {
  it('ships concise: the tool block starts closed', () => {
    const { container } = renderBlock();
    const header = container.querySelector('button[aria-expanded]');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the block and its rows when the style is detailed', () => {
    writeResponsePreferences({ responseStyle: 'detailed' });
    const { container } = renderBlock();
    const header = container.querySelector('button[aria-expanded]');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    // The row bodies come with it: the command is on screen without a click.
    expect(screen.getAllByText(/pwd|ls -1/).length).toBeGreaterThan(0);
  });

  it('re-renders a mounted conversation when the owner switches style — no remount', () => {
    const { container } = renderBlock();
    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      writeResponsePreferences({ responseStyle: 'detailed' });
    });
    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      writeResponsePreferences({ responseStyle: 'concise' });
    });
    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  });
});
