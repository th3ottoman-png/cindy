// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const insertPromptIntoComposer = vi.fn(
  (_detail: { targetSessionId: string; text: string }) => true,
);
vi.mock('@/lib/composerActionsBus', () => ({
  insertPromptIntoComposer: (detail: { targetSessionId: string; text: string }) =>
    insertPromptIntoComposer(detail),
}));

import { TurnAuditPanel } from '../TurnAuditPanel';
import { ChatInventoryTabBody } from '../ChatInventoryTabBody';

const SUMMARY = {
  sessionId: 's1',
  turnAudit: true,
  audit: {
    progress: 60,
    auditedTurns: 1,
    decisions: [{ text: 'Cache session reads in Redis', why: 'Reads dominate', turn: 1 }],
    assumptions: [
      {
        text: 'Redis is running on the default port 6379',
        confidence: 60,
        low: true,
        verify: 'redis-cli -p 6379 ping',
        turn: 1,
      },
      { text: 'Node 22 is installed', confidence: 95, low: false, turn: 1 },
    ],
    lowConfidenceCount: 1,
  },
};

function mockApi(summary: unknown) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      turnAudit: { summary: vi.fn(async () => summary) },
      chatInventory: { get: vi.fn(async () => ({ ok: false, error: 'n/a in test' })) },
    },
  };
}

describe('TurnAuditPanel (ROADMAP 11.10)', () => {
  beforeEach(() => {
    insertPromptIntoComposer.mockClear();
    mockApi(SUMMARY);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows progress, decisions, and an amber pill only on assumptions below 80%', async () => {
    render(<TurnAuditPanel sessionId="s1" />);
    expect(await screen.findByText('Redis is running on the default port 6379')).toBeTruthy();
    expect(screen.getByTestId('turn-audit-progress').textContent).toContain('60%');
    expect(screen.getByText('Cache session reads in Redis')).toBeTruthy();
    const pills = screen.getAllByTestId('assumption-low-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toContain('Confidence: 60%');
    expect(screen.getByText('Node 22 is installed')).toBeTruthy();
  });

  it('1-click verify prefills the session composer with the assumption and its check', async () => {
    render(<TurnAuditPanel sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Verify: Redis is running/ }));
    expect(insertPromptIntoComposer).toHaveBeenCalledTimes(1);
    const detail = insertPromptIntoComposer.mock.calls[0][0];
    expect(detail.targetSessionId).toBe('s1');
    expect(detail.text).toContain('Redis is running on the default port 6379');
    expect(detail.text).toContain('redis-cli -p 6379 ping');
  });

  it('says how to turn the audit on when it is off and nothing was audited', async () => {
    mockApi({
      sessionId: 's1',
      turnAudit: false,
      audit: {
        progress: null,
        auditedTurns: 0,
        decisions: [],
        assumptions: [],
        lowConfidenceCount: 0,
      },
    });
    render(<TurnAuditPanel sessionId="s1" />);
    expect(await screen.findByText(/Turn audit is off/)).toBeTruthy();
  });

  it('is reachable from the In This Chat tab as "Audit & Assumptions"', async () => {
    render(
      <ChatInventoryTabBody
        {...({
          ctx: { sessionId: 's1' },
          state: {},
          setState: () => undefined,
        } as unknown as React.ComponentProps<typeof ChatInventoryTabBody>)}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Audit & Assumptions/ }));
    await waitFor(() => expect(screen.getByTestId('turn-audit-panel')).toBeTruthy());
    expect(await screen.findByText('Redis is running on the default port 6379')).toBeTruthy();
  });
});
