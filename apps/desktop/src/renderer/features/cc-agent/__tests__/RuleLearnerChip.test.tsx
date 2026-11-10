// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RuleLearnerChip, RuleLearnerChipView } from '../RuleLearnerChip';
import type { CorrectionDetection, SaveRuleResult } from '@cindy/maker-core/rule-learner';

describe('RuleLearnerChip', () => {
  it('renders nothing when no correction is detected', () => {
    const readSnapshot = vi.fn().mockReturnValue({
      messages: [{ role: 'user', content: 'What is the current git status?' }],
    });
    const detectCorrectionApi = vi.fn().mockResolvedValue({
      isCorrection: false,
      suggestedRuleText: '',
      suggestedTitle: '',
      slug: '',
    });

    const { container } = render(
      <RuleLearnerChip
        sessionId="session-1"
        readSnapshot={readSnapshot}
        detectCorrectionApi={detectCorrectionApi}
        pollMs={100}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('surfaces chip with options when correction is detected', async () => {
    const readSnapshot = vi.fn().mockReturnValue({
      messages: [{ role: 'user', content: "No, don't use yarn. We use pnpm lockfile." }],
    });
    const detectCorrectionApi = vi.fn().mockResolvedValue({
      isCorrection: true,
      matchedPattern: 'negative_imperative',
      suggestedRuleText: "No, don't use yarn. We use pnpm lockfile.",
      suggestedTitle: "Don't use yarn",
      slug: 'dont-use-yarn',
    });

    render(
      <RuleLearnerChip
        sessionId="session-1"
        readSnapshot={readSnapshot}
        detectCorrectionApi={detectCorrectionApi}
        pollMs={100}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('rule-learner-chip')).toBeTruthy();
    });

    expect(screen.getByText('Save rule: "Don\'t use yarn"?')).toBeTruthy();
    expect(screen.getByTestId('rule-learner-save-vault')).toBeTruthy();
    expect(screen.getByTestId('rule-learner-save-soul')).toBeTruthy();
  });

  it('clicks Vault to save rule and shows status feedback', async () => {
    const saveRuleApi = vi.fn().mockResolvedValue({
      success: true,
      filePath: '/vault/Cindy/Rules/dont-use-yarn.md',
      content: '# Rule',
      target: 'vault',
    });

    const detection: CorrectionDetection = {
      isCorrection: true,
      suggestedRuleText: "No, don't use yarn.",
      suggestedTitle: "Don't use yarn",
      slug: 'dont-use-yarn',
    };

    const onSave = vi.fn();
    const onDismiss = vi.fn();

    const { rerender } = render(
      <RuleLearnerChipView
        detection={detection}
        savingTarget={null}
        statusMessage={null}
        onSave={onSave}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('rule-learner-save-vault'));
    expect(onSave).toHaveBeenCalledWith('vault');

    rerender(
      <RuleLearnerChipView
        detection={detection}
        savingTarget={null}
        statusMessage="Saved to Vault"
        onSave={onSave}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId('rule-learner-status').textContent).toContain('Saved to Vault');
  });

  it('clicks SOUL.md to save rule', async () => {
    const detection: CorrectionDetection = {
      isCorrection: true,
      suggestedRuleText: 'Always quote paths.',
      suggestedTitle: 'Always quote paths',
      slug: 'always-quote-paths',
    };

    const onSave = vi.fn();
    const onDismiss = vi.fn();

    render(
      <RuleLearnerChipView
        detection={detection}
        savingTarget={null}
        statusMessage={null}
        onSave={onSave}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('rule-learner-save-soul'));
    expect(onSave).toHaveBeenCalledWith('soul');
  });

  it('dismisses chip when dismiss button clicked', async () => {
    const readSnapshot = vi.fn().mockReturnValue({
      messages: [{ role: 'user', content: 'Wrong! That was incorrect.' }],
    });
    const detectCorrectionApi = vi.fn().mockResolvedValue({
      isCorrection: true,
      suggestedRuleText: 'Wrong! That was incorrect.',
      suggestedTitle: 'That was incorrect',
      slug: 'that-was-incorrect',
    });

    render(
      <RuleLearnerChip
        sessionId="session-1"
        readSnapshot={readSnapshot}
        detectCorrectionApi={detectCorrectionApi}
        pollMs={100}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('rule-learner-chip')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('rule-learner-dismiss'));

    await waitFor(() => {
      expect(screen.queryByTestId('rule-learner-chip')).toBeNull();
    });
  });
});
