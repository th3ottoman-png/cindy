// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationRow } from '@cindy/maker-core/operations-rail';

import { OperationsRailTabBody } from '../OperationsRailTabBody';
import { openOperationsRailTab } from '../../../lib/openOperationsRailTab';
import { onRequestRightSidebarVisibility } from '../../../lib/sidebarCommands';

const MOCK_ROWS: OperationRow[] = [
  {
    kind: 'turn',
    id: 'session-turn-1',
    title: 'Code review task',
    status: 'running',
    detail: 'Reading file: packages/core.ts',
    atMs: Date.now() - 5000,
    actions: ['cancel', 'open'],
  },
  {
    kind: 'schedule',
    id: 'nightly-eval',
    title: 'Nightly Evaluation',
    status: 'scheduled',
    detail: 'last run 2h ago - Cindy/Research/Nightly.md',
    atMs: Date.now() + 600000,
    actions: ['run-now', 'open'],
  },
];

describe('OperationsRailTabBody', () => {
  let listMock: ReturnType<typeof vi.fn>;
  let cancelMock: ReturnType<typeof vi.fn>;
  let replayMock: ReturnType<typeof vi.fn>;
  let dryRunMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listMock = vi.fn(async () => ({
      rows: MOCK_ROWS,
      summary: [
        { kind: 'turn', count: 1, running: 1 },
        { kind: 'schedule', count: 1, running: 0 },
      ],
      hasRunning: true,
    }));
    cancelMock = vi.fn(async () => ({ ok: true }));
    replayMock = vi.fn(async () => ({ ok: true }));
    dryRunMock = vi.fn(async () => ({
      status: 'success',
      at: Date.now(),
      dryRun: true,
      output: 'Simulation complete. 0 bytes written to vault.',
    }));

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        operations: {
          list: listMock,
          cancel: cancelMock,
          replay: replayMock,
          dryRunSchedule: dryRunMock,
          onChanged: vi.fn(() => () => {}),
        },
        scheduledSessions: {
          runNow: vi.fn(async () => ({ status: 'success' })),
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders operations rail header, summary chips, and active operation cards', async () => {
    render(
      <BrowserRouter>
        <OperationsRailTabBody ctx={{ sessionId: 'test-session' } as any} />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/OPERATIONS RAIL/i)).toBeTruthy();
      expect(screen.getAllByText(/Active/i).length).toBeGreaterThan(0);
      expect(screen.getByText('Code review task')).toBeTruthy();
      expect(screen.getByText('Nightly Evaluation')).toBeTruthy();
      expect(screen.getByText('Reading file: packages/core.ts')).toBeTruthy();
    });
  });

  it('triggers cancel action when Cancel button is clicked', async () => {
    render(
      <BrowserRouter>
        <OperationsRailTabBody ctx={{ sessionId: 'test-session' } as any} />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeTruthy();
    });

    const cancelButton = screen.getByText('Cancel');
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith({
        kind: 'turn',
        id: 'session-turn-1',
      });
    });
  });

  it('triggers dry-run when Dry-Run button is clicked', async () => {
    render(
      <BrowserRouter>
        <OperationsRailTabBody ctx={{ sessionId: 'test-session' } as any} />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Dry-Run')).toBeTruthy();
    });

    const dryRunButton = screen.getByText('Dry-Run');
    fireEvent.click(dryRunButton);

    await waitFor(() => {
      expect(dryRunMock).toHaveBeenCalledWith({
        id: 'nightly-eval',
      });
    });
  });

  it('openOperationsRailTab adds or focuses singleton tab and requests sidebar open', async () => {
    let requested: { visibility: string; opts: any } | null = null;
    const unsub = onRequestRightSidebarVisibility((vis, opts) => {
      requested = { visibility: vis, opts };
    });

    try {
      await openOperationsRailTab('session-abc');
      expect(requested).toEqual({
        visibility: 'open',
        opts: { sessionId: 'session-abc' },
      });
    } finally {
      unsub();
    }
  });
});
