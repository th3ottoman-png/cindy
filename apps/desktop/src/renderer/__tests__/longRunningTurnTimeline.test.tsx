// @vitest-environment jsdom

/**
 * ROADMAP 5.3b: the long-running panel must appear only past the threshold,
 * render a live tool-call timeline with elapsed time, and expose a cancel
 * control that leaves an observable terminal state.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  snap: {
    agentStatus: { isRunning: false, startedAt: null as number | null },
    turnStoppedByUser: false,
    error: null as string | null,
    recoverableError: null as string | null,
    messages: [] as Array<{
      role: string;
      toolUseId?: string;
      toolName?: string;
      createdAt?: string;
    }>,
  },
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { getSnapshot: () => store.snap },
}));

import {
  LongRunningTurnTimeline,
  LongRunningTurnTimelineView,
} from '@/features/cc-agent/LongRunningTurnTimeline';
import { buildTurnTimeline } from '@cindy/maker-core/turn-timeline';

const START = 1_700_000_000_000;
const iso = (at: number) => new Date(at).toISOString();

function resetStore() {
  store.snap = {
    agentStatus: { isRunning: false, startedAt: null },
    turnStoppedByUser: false,
    error: null,
    recoverableError: null,
    messages: [],
  };
}

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
  vi.setSystemTime(START + 3_000);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LongRunningTurnTimelineView', () => {
  it('renders elapsed time, tool spans and an enabled cancel button', () => {
    const timeline = buildTurnTimeline({
      turnStartedAt: START,
      now: START + 125_000,
      state: 'running',
      toolEvents: [
        { kind: 'started', toolUseId: 'a', toolName: 'read_file', at: START + 100 },
        { kind: 'completed', toolUseId: 'a', at: START + 900 },
        { kind: 'started', toolUseId: 'b', toolName: 'write_file', at: START + 1_000 },
      ],
    });
    const onCancel = vi.fn();
    const { container } = render(
      <LongRunningTurnTimelineView timeline={timeline} onCancel={onCancel} />,
    );
    expect(screen.getByTestId('long-running-turn-elapsed').textContent).toBe('02:05');
    expect(screen.getByTestId('long-running-turn-summary').textContent).toContain('Running');
    expect(container.querySelectorAll('[data-testid^="tool-timeline-span-"]')).toHaveLength(2);
    expect(screen.getByTestId('tool-timeline-span-a').getAttribute('data-span-state')).toBe('completed');
    expect(screen.getByTestId('tool-timeline-span-b').getAttribute('data-span-state')).toBe('running');
    expect(screen.getByTestId('tool-timeline-span-b').textContent).toContain('(active)');
    const cancel = screen.getByTestId('long-running-turn-cancel');
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables cancel in cancelling and terminal states', () => {
    const make = (state: 'cancelling' | 'cancelled') =>
      buildTurnTimeline({ turnStartedAt: START, now: START + 125_000, state, toolEvents: [] });
    const { unmount } = render(
      <LongRunningTurnTimelineView timeline={make('cancelling')} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('long-running-turn-timeline').getAttribute('data-state')).toBe('cancelling');
    expect(screen.getByTestId('long-running-turn-cancel').hasAttribute('disabled')).toBe(true);
    unmount();
    render(<LongRunningTurnTimelineView timeline={make('cancelled')} onCancel={vi.fn()} />);
    expect(screen.getByTestId('long-running-turn-timeline').getAttribute('data-state')).toBe('cancelled');
    expect(screen.getByTestId('long-running-turn-cancel').hasAttribute('disabled')).toBe(true);
  });
});

describe('LongRunningTurnTimeline container', () => {
  it('stays hidden before the threshold and appears after it', () => {
    store.snap.agentStatus = { isRunning: true, startedAt: START };
    const { container } = render(
      <LongRunningTurnTimeline sessionId="s1" onCancel={vi.fn()} />,
    );
    expect(container.querySelector('[data-testid="long-running-turn-timeline"]')).toBeNull();
    act(() => {
      vi.setSystemTime(START + 120_000);
      vi.advanceTimersByTime(1_000);
    });
    const panel = container.querySelector('[data-testid="long-running-turn-timeline"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('data-long-running')).toBe('true');
    expect(panel?.getAttribute('data-state')).toBe('running');
  });

  it('renders live spans and leaves a cancelled state after the cancel control', () => {
    store.snap = {
      agentStatus: { isRunning: true, startedAt: START },
      turnStoppedByUser: false,
      error: null,
      recoverableError: null,
      messages: [
        { role: 'tool_use', toolUseId: 'a', toolName: 'read_file', createdAt: iso(START + 100) },
        { role: 'tool_result', toolUseId: 'a', createdAt: iso(START + 600) },
        { role: 'tool_use', toolUseId: 'b', toolName: 'write_file', createdAt: iso(START + 800) },
      ],
    };
    const onCancel = vi.fn(() => {
      // Production stopSession flips the store optimistically.
      store.snap.agentStatus = { isRunning: false, startedAt: null };
      store.snap.turnStoppedByUser = true;
    });
    const { container } = render(
      <LongRunningTurnTimeline sessionId="s1" onCancel={onCancel} longRunningAfterMs={0} />,
    );
    expect(container.querySelectorAll('[data-testid^="tool-timeline-span-"]')).toHaveLength(2);
    expect(screen.getByTestId('long-running-turn-elapsed').textContent).toBe('00:03');

    fireEvent.click(screen.getByTestId('long-running-turn-cancel'));
    // Declare `cancelling` in the same frame: immediate feedback, and the
    // button disables at once so a second click cannot fire stopSession twice.
    expect(container.querySelector('[data-testid="long-running-turn-timeline"]')?.getAttribute('data-state')).toBe('cancelling');
    expect(screen.getByTestId('long-running-turn-cancel').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('long-running-turn-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    const panel = container.querySelector('[data-testid="long-running-turn-timeline"]');
    expect(panel?.getAttribute('data-state')).toBe('cancelled');
    expect(screen.getByTestId('long-running-turn-cancel').hasAttribute('disabled')).toBe(true);
  });

  it('recovers when Stop is refused so the user can try again', () => {
    store.snap = {
      agentStatus: { isRunning: true, startedAt: START },
      turnStoppedByUser: false,
      error: null,
      recoverableError: null,
      messages: [],
    };
    // A refused stop (for example a remote session that is unavailable) does
    // not flip the store. The panel must not get stuck on "Cancelling".
    const onCancel = vi.fn();
    const { container } = render(
      <LongRunningTurnTimeline sessionId="s1" onCancel={onCancel} longRunningAfterMs={0} />,
    );
    fireEvent.click(screen.getByTestId('long-running-turn-cancel'));
    expect(container.querySelector('[data-testid="long-running-turn-timeline"]')?.getAttribute('data-state')).toBe('cancelling');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.querySelector('[data-testid="long-running-turn-timeline"]')?.getAttribute('data-state')).toBe('running');
    expect(screen.getByTestId('long-running-turn-cancel').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByTestId('long-running-turn-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
