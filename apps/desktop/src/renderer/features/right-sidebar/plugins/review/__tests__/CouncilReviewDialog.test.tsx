// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CouncilReviewDialog } from '../CouncilReviewDialog';

const councilOptions = vi.fn();
const councilRun = vi.fn();

const OPTIONS = {
  reviewers: [
    { providerId: 'lmstudio-local', model: 'qwen3-8b', local: true },
    { providerId: 'lmstudio-local', model: 'gemma-4-26b', local: true },
    { providerId: 'tokenhub', model: 'hunyuan-t1', local: false },
    { providerId: 'tokenhub', model: 'glm-5', local: false },
  ],
  selection: [],
};

const verdict = (over: Record<string, unknown> = {}) => ({
  findings: [
    {
      id: 'src/app.ts#10#missing-null',
      file: 'src/app.ts',
      line: 10,
      severity: 'major',
      title: 'Missing null check',
      detail: 'user may be undefined',
      suggestion: 'if (!user) return;',
      agreedBy: [
        { providerId: 'lmstudio-local', model: 'qwen3-8b' },
        { providerId: 'tokenhub', model: 'hunyuan-t1' },
      ],
      agreement: 2,
      of: 2,
    },
  ],
  outcomes: [
    { reviewer: { providerId: 'lmstudio-local', model: 'qwen3-8b' }, status: 'ok' },
    { reviewer: { providerId: 'tokenhub', model: 'hunyuan-t1' }, status: 'ok' },
  ],
  usableReviewers: 2,
  failedReviewers: 0,
  ...over,
});

beforeEach(() => {
  councilOptions.mockReset().mockResolvedValue(OPTIONS);
  councilRun.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { gitReview: { councilOptions, councilRun } },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const renderDialog = (): void => {
  render(<CouncilReviewDialog open sessionId="s1" onOpenChange={() => {}} />);
};

describe('CouncilReviewDialog', () => {
  it('lists the live catalogue once the options load', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeTruthy());
    expect(screen.getByText('gemma-4-26b')).toBeTruthy();
    expect(screen.getByText('hunyuan-t1')).toBeTruthy();
    expect(screen.getByText('glm-5')).toBeTruthy();
    expect(councilOptions).toHaveBeenCalledTimes(1);
  });

  it('caps the selection at three reviewers before dispatching', async () => {
    const user = userEvent.setup();
    councilRun.mockResolvedValue({
      ok: true,
      verdict: verdict(),
      available: OPTIONS.reviewers,
      selection: [],
      selectionPersisted: true,
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeTruthy());

    for (const model of ['qwen3-8b', 'gemma-4-26b', 'hunyuan-t1', 'glm-5']) {
      await user.click(screen.getByText(model));
    }
    await user.click(screen.getByText('councilReview.run'));

    await waitFor(() => expect(councilRun).toHaveBeenCalledTimes(1));
    const payload = councilRun.mock.calls[0]?.[0] as { reviewers: { model: string }[] };
    expect(payload.reviewers).toHaveLength(3);
    expect(payload.reviewers.map((r) => r.model)).toEqual(['qwen3-8b', 'gemma-4-26b', 'hunyuan-t1']);
  });

  it('renders the consensus finding with its denominator', async () => {
    const user = userEvent.setup();
    councilRun.mockResolvedValue({
      ok: true,
      verdict: verdict(),
      available: OPTIONS.reviewers,
      selection: [],
      selectionPersisted: true,
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeTruthy());
    await user.click(screen.getByText('qwen3-8b'));
    await user.click(screen.getByText('councilReview.run'));

    await waitFor(() => expect(screen.getByText('Missing null check')).toBeTruthy());
    expect(screen.getByText('src/app.ts:10')).toBeTruthy();
    expect(screen.getByText('if (!user) return;')).toBeTruthy();
    expect(screen.getByText('councilReview.agreed')).toBeTruthy();
  });

  it('names a reviewer that failed and keeps it out of the denominator', async () => {
    const user = userEvent.setup();
    councilRun.mockResolvedValue({
      ok: true,
      verdict: verdict({
        findings: [],
        outcomes: [
          { reviewer: { providerId: 'lmstudio-local', model: 'qwen3-8b' }, status: 'ok' },
          {
            reviewer: { providerId: 'tokenhub', model: 'hunyuan-t1' },
            status: 'failed',
            reason: 'unparseable',
          },
        ],
        usableReviewers: 1,
        failedReviewers: 1,
      }),
      available: OPTIONS.reviewers,
      selection: [],
      selectionPersisted: false,
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeTruthy());
    await user.click(screen.getByText('qwen3-8b'));
    await user.click(screen.getByText('councilReview.run'));

    await waitFor(() => expect(screen.getByText('councilReview.reviewerFailed')).toBeTruthy());
    expect(screen.getByText('councilReview.notRemembered')).toBeTruthy();
    expect(screen.getByText('councilReview.noFindings')).toBeTruthy();
  });

  it('shows host validation errors instead of pretending a review ran', async () => {
    const user = userEvent.setup();
    councilRun.mockResolvedValue({ ok: false, errors: ['nothing to review: this scope has no changed files'] });
    renderDialog();
    await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeTruthy());
    await user.click(screen.getByText('qwen3-8b'));
    await user.click(screen.getByText('councilReview.run'));

    await waitFor(() => expect(
      screen.getByText('nothing to review: this scope has no changed files'),
    ).toBeTruthy());
  });

  it('does not dispatch when nothing is selected', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeTruthy());
    await user.click(screen.getByText('councilReview.run'));
    expect(councilRun).not.toHaveBeenCalled();
  });
});
