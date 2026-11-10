// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionHandoffButton, SessionHandoffButtonView } from '../SessionHandoffButton';

describe('SessionHandoffButton', () => {
  it('renders idle state with Clean Handoff label', () => {
    const onClick = vi.fn();
    render(
      <SessionHandoffButtonView
        isCompacting={false}
        statusMessage={null}
        onClick={onClick}
      />,
    );

    const btn = screen.getByTestId('session-handoff-button');
    expect(btn.textContent).toContain('Clean Handoff');
  });

  it('renders compacting state when active', () => {
    const onClick = vi.fn();
    render(
      <SessionHandoffButtonView
        isCompacting={true}
        statusMessage="Compacting…"
        onClick={onClick}
      />,
    );

    const btn = screen.getByTestId('session-handoff-button') as HTMLButtonElement;
    expect(btn.textContent).toContain('Compacting…');
    expect(btn.disabled).toBe(true);
  });

  it('clicks handoff button and executes handoff API, prefilling draft', async () => {
    const executeHandoffApi = vi.fn().mockResolvedValue({
      ok: true,
      prompt: '# Session Continuation & Handoff\n\n- [ ] Next task',
      title: 'Continued Task',
      workingDir: '/workspace/cindy',
      model: 'deepseek-v4-pro',
    });

    const onHandoffTriggered = vi.fn();

    render(
      <SessionHandoffButton
        sessionId="sess-test-123"
        executeHandoffApi={executeHandoffApi}
        onHandoffTriggered={onHandoffTriggered}
      />,
    );

    const btn = screen.getByTestId('session-handoff-button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(executeHandoffApi).toHaveBeenCalledWith({ sessionId: 'sess-test-123' });
      expect(onHandoffTriggered).toHaveBeenCalled();
    });

    expect(screen.getByTestId('session-handoff-button').textContent).toContain('✓ Handoff Ready!');
  });
});
