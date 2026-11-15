/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import type { ShellLimitsView } from '../../../../main/maker-ipc/shellLimits';
import { ShellLimitsChip } from '../ShellLimitsChip';

const view = (over: Partial<ShellLimitsView> = {}): ShellLimitsView => ({
  timeoutSeconds: 300,
  errors: [],
  file: '/h/.cindy-harness/shell-limits.yaml',
  exists: true,
  ...over,
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('ShellLimitsChip', () => {
  it('shows the limit the daemon writes into session homes', async () => {
    const get = vi.fn().mockResolvedValue(view());
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { shellLimits: { get } } };
    render(<ShellLimitsChip />);
    expect((await screen.findByTestId('manifest-shell-limits')).textContent).toBe('shell 300s');
    expect(screen.getByTestId('manifest-shell-limits').getAttribute('data-state')).toBe('on');
    expect(screen.getByTestId('manifest-shell-limits').getAttribute('title')).toContain(
      '/h/.cindy-harness/shell-limits.yaml',
    );
  });

  it('re-reads the file while shown, so a hand edit reaches the strip', async () => {
    const get = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(view({ timeoutSeconds: 0 }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { shellLimits: { get } } };
    render(<ShellLimitsChip pollMs={20} />);
    expect((await screen.findByTestId('manifest-shell-limits')).textContent).toBe('shell 300s');
    await waitFor(() =>
      expect(screen.getByTestId('manifest-shell-limits').textContent).toBe('shell default'),
    );
    expect(screen.getByTestId('manifest-shell-limits').getAttribute('data-state')).toBe('off');
  });

  it('marks a rejected file instead of showing a plausible number', async () => {
    const get = vi.fn().mockResolvedValue(view({ errors: ['timeout_seconds: "soon" is not a whole number'] }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { shellLimits: { get } } };
    render(<ShellLimitsChip />);
    await waitFor(() =>
      expect(screen.getByTestId('manifest-shell-limits').getAttribute('data-state')).toBe('error'),
    );
  });

  it('renders nothing without the host API', async () => {
    const { container } = render(<ShellLimitsChip />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
});
