import { describe, expect, it } from 'vitest';

import type { ShellLimitsView } from '../../../../main/maker-ipc/shellLimits';

import { shellLimitsChip } from '../shellLimitsChipText';

function view(overrides: Partial<ShellLimitsView> = {}): ShellLimitsView {
  return {
    timeoutSeconds: 300,
    errors: [],
    file: '/Users/owner/.cindy-harness/shell-limits.yaml',
    exists: true,
    ...overrides,
  };
}

describe('shellLimitsChip', () => {
  it('renders nothing without a file path', () => {
    expect(shellLimitsChip(null)).toBeNull();
    expect(shellLimitsChip(view({ file: '' }))).toBeNull();
  });

  it('shows the limit in seconds', () => {
    const chip = shellLimitsChip(view());
    expect(chip?.label).toBe('shell 300s');
    expect(chip?.state).toBe('on');
    expect(chip?.title).toContain('stops after 300 s');
    expect(chip?.title).toContain('shell-limits.yaml');
  });

  it('says "default" when the limit is 0', () => {
    const chip = shellLimitsChip(view({ timeoutSeconds: 0 }));
    expect(chip?.label).toBe('shell default');
    expect(chip?.state).toBe('off');
    expect(chip?.title).toContain('180 s');
  });

  it('marks a file whose values were rejected', () => {
    const chip = shellLimitsChip(
      view({ errors: ['timeout_seconds: "soon" is not a whole number from 0 to 600; using 300'] }),
    );
    expect(chip?.state).toBe('error');
    expect(chip?.title).toContain('not a whole number');
  });

  it('says when the file has not been created yet', () => {
    const chip = shellLimitsChip(view({ exists: false }));
    expect(chip?.title).toContain('not created');
  });
});
