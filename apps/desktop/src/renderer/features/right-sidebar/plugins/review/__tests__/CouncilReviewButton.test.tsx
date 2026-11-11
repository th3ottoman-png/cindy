// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CouncilReviewButton } from '../CouncilReviewButton';

const councilOptions = vi.fn();

beforeEach(() => {
  councilOptions.mockReset().mockResolvedValue({ reviewers: [], selection: [] });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { gitReview: { councilOptions, councilRun: vi.fn() } },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CouncilReviewButton', () => {
  it('renders the header variant with a label the owner can actually read', () => {
    render(<CouncilReviewButton sessionId="s1" variant="header" />);
    const button = screen.getByTestId('council-review-button-header');
    expect(button.textContent).toContain('councilReview.button');
    expect(button.getAttribute('title')).toBe('councilReview.buttonTooltip');
  });

  it('renders the toolbar variant', () => {
    render(<CouncilReviewButton sessionId="s1" />);
    expect(screen.getByTestId('council-review-button-toolbar')).toBeTruthy();
  });

  it('opens the dialog and reads the catalogue when clicked', async () => {
    const user = userEvent.setup();
    render(<CouncilReviewButton sessionId="s1" variant="header" />);
    expect(councilOptions).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('council-review-button-header'));
    await waitFor(() => expect(councilOptions).toHaveBeenCalledTimes(1));
    expect(screen.getByText('councilReview.title')).toBeTruthy();
  });

  it('does not open when disabled', async () => {
    const user = userEvent.setup();
    render(<CouncilReviewButton sessionId="s1" enabled={false} />);
    await user.click(screen.getByTestId('council-review-button-toolbar'));
    expect(councilOptions).not.toHaveBeenCalled();
  });
});
