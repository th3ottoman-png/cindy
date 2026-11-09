// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MarkdownDiffBlock } from '../MarkdownDiffBlock';

const SAMPLE_DIFF = `diff --git a/src/calculator.ts b/src/calculator.ts
--- a/src/calculator.ts
+++ b/src/calculator.ts
@@ -1,4 +1,5 @@
 export function multiply(a: number, b: number): number {
-  return a * 0;
+  // Correct multiplication logic
+  return a * b;
 }
`;

describe('MarkdownDiffBlock Interactive Visual Card', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders interactive diff card with file path and stats badges', () => {
    render(<MarkdownDiffBlock raw={SAMPLE_DIFF} />);

    // Header renders file path
    const card = screen.getByTestId('interactive-diff-card');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('src/calculator.ts');

    // Stats badge shows +2 and -1
    const addBadge = screen.getByTestId('diff-stat-additions');
    expect(addBadge.textContent).toBe('+2');
    const delBadge = screen.getByTestId('diff-stat-deletions');
    expect(delBadge.textContent).toBe('-1');

    // Content container renders
    const content = screen.getByTestId('diff-card-content');
    expect(content.textContent).toContain('export function multiply');
    expect(content.textContent).toContain('return a * 0;');
    expect(content.textContent).toContain('return a * b;');
  });

  it('toggles between Unified and Split (side-by-side) view modes', () => {
    render(<MarkdownDiffBlock raw={SAMPLE_DIFF} />);

    const unifiedBtn = screen.getByTestId('diff-mode-unified');
    const splitBtn = screen.getByTestId('diff-mode-split');

    expect(unifiedBtn.getAttribute('aria-pressed')).toBe('true');
    expect(splitBtn.getAttribute('aria-pressed')).toBe('false');

    // Switch to Split mode
    fireEvent.click(splitBtn);
    expect(unifiedBtn.getAttribute('aria-pressed')).toBe('false');
    expect(splitBtn.getAttribute('aria-pressed')).toBe('true');

    // Content still contains changes
    const content = screen.getByTestId('diff-card-content');
    expect(content.textContent).toContain('return a * 0;');
    expect(content.textContent).toContain('return a * b;');

    // Switch back to Unified mode
    fireEvent.click(unifiedBtn);
    expect(unifiedBtn.getAttribute('aria-pressed')).toBe('true');
    expect(splitBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('collapses and expands the diff body on chevron click', () => {
    render(<MarkdownDiffBlock raw={SAMPLE_DIFF} />);

    // Initially expanded
    expect(screen.queryByTestId('diff-card-content')).not.toBeNull();

    // Collapse
    const collapseBtn = screen.getByRole('button', { name: /collapse diff/i });
    fireEvent.click(collapseBtn);

    // Body is hidden
    expect(screen.queryByTestId('diff-card-content')).toBeNull();

    // Expand again
    const expandBtn = screen.getByRole('button', { name: /expand diff/i });
    fireEvent.click(expandBtn);

    // Body is visible again
    expect(screen.queryByTestId('diff-card-content')).not.toBeNull();
  });

  it('opens and closes fullscreen inspection dialog', () => {
    render(<MarkdownDiffBlock raw={SAMPLE_DIFF} />);

    // Initially no fullscreen modal dialog
    expect(screen.queryByRole('dialog')).toBeNull();

    // Click fullscreen button
    const fullscreenBtn = screen.getByTestId('diff-card-fullscreen');
    fireEvent.click(fullscreenBtn);

    // Dialog appears with file title
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-label')).toContain('src/calculator.ts');

    // Click close in dialog
    const closeBtn = screen.getByTestId('diff-fullscreen-close');
    fireEvent.click(closeBtn);

    // Dialog is removed
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies diff content to clipboard with feedback', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    render(<MarkdownDiffBlock raw={SAMPLE_DIFF} />);

    const copyBtn = screen.getByTestId('diff-card-copy');
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(writeTextMock).toHaveBeenCalledWith(SAMPLE_DIFF);
    expect(copyBtn.getAttribute('aria-label')).toBe('Copied');
  });
});
