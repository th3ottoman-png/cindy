// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScreenShareToggleView } from '../ScreenShareToggle';

describe('ScreenShareToggle', () => {
  it('renders disabled state with default label and icon', () => {
    const onToggle = vi.fn();
    render(<ScreenShareToggleView enabled={false} onToggle={onToggle} />);

    const btn = screen.getByTestId('screen-share-toggle');
    expect(btn.getAttribute('data-active')).toBe('false');
    expect(btn.textContent).toContain('Screen-Share');
  });

  it('renders active state with privacy active badge', () => {
    const onToggle = vi.fn();
    render(<ScreenShareToggleView enabled={true} onToggle={onToggle} />);

    const btn = screen.getByTestId('screen-share-toggle');
    expect(btn.getAttribute('data-active')).toBe('true');
    expect(btn.textContent).toContain('Privacy Active');
  });

  it('triggers onToggle callback when clicked', () => {
    const onToggle = vi.fn();
    render(<ScreenShareToggleView enabled={false} onToggle={onToggle} />);

    fireEvent.click(screen.getByTestId('screen-share-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
