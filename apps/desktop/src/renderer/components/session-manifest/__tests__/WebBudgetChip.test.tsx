/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import type { WebBudgetView } from '../../../../main/maker-ipc/webBudget';
import { WebBudgetChip } from '../WebBudgetChip';
import { webBudgetChip } from '../webBudgetChipText';

const view = (over: Partial<WebBudgetView> = {}): WebBudgetView => ({
  available: true,
  used: 0,
  max: 50,
  toolNames: ['web_search', 'web_extract'],
  errors: [],
  file: '/h/.cindy-harness/web-budget.yaml',
  enforced: true,
  ...over,
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('web-budget chip wording (ROADMAP 13.5)', () => {
  it('shows used/max and the state', () => {
    expect(webBudgetChip(view({ used: 12 }))).toMatchObject({ label: 'web 12/50', state: 'ok' });
    expect(webBudgetChip(view({ used: 40 }))?.state).toBe('near');
    const reached = webBudgetChip(view({ used: 2, max: 2 }));
    expect(reached).toMatchObject({ label: 'web 2/2', state: 'reached' });
    expect(reached?.title).toMatch(/blocked with a reason/);
    expect(reached?.title).toContain('/h/.cindy-harness/web-budget.yaml');
  });

  it('says plainly when the cap is off or not enforced, and lists file problems', () => {
    expect(webBudgetChip(view({ max: 0 }))).toMatchObject({ label: 'web no cap', state: 'no-cap' });
    const safe = webBudgetChip(view({ enforced: false, max: 5 }));
    expect(safe).toMatchObject({ label: 'web –/5', state: 'not-enforced' });
    expect(safe?.title).toMatch(/Default mode/);
    expect(webBudgetChip(view({ errors: ['unknown key "x" (ignored)'] }))?.title).toContain(
      'unknown key "x"',
    );
  });

  it('hides when the daemon gave no answer', () => {
    expect(webBudgetChip(null)).toBeNull();
    expect(webBudgetChip(view({ available: false }))).toBeNull();
  });
});

describe('WebBudgetChip', () => {
  it('reads the count for its session and re-reads it while shown', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(view({ used: 1, max: 2 }))
      .mockResolvedValue(view({ used: 2, max: 2 }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { webBudget: { get } } };
    render(<WebBudgetChip sessionId="s-1" pollMs={20} />);
    expect((await screen.findByTestId('manifest-web-budget')).textContent).toBe('web 1/2');
    await waitFor(() =>
      expect(screen.getByTestId('manifest-web-budget').textContent).toBe('web 2/2'),
    );
    expect(screen.getByTestId('manifest-web-budget').getAttribute('data-state')).toBe('reached');
    expect(get).toHaveBeenCalledWith('s-1');
  });

  it('renders nothing without the host API or with an unavailable answer', async () => {
    const { container } = render(<WebBudgetChip sessionId="s-1" />);
    expect(container.innerHTML).toBe('');
    cleanup();
    const get = vi.fn().mockResolvedValue(view({ available: false }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { webBudget: { get } } };
    const second = render(<WebBudgetChip sessionId="s-2" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(second.container.querySelector('[data-testid="manifest-web-budget"]')).toBeNull();
  });
});
