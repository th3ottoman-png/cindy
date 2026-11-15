import { describe, expect, it } from 'vitest';

import { UNAVAILABLE_WEB_BUDGET, readWebBudget, toWebBudgetView } from '../webBudget';

describe('web-budget IPC bridge (ROADMAP 13.5)', () => {
  it('asks the daemon with the stable daemon session id (1.14) and narrows the answer', async () => {
    const asked: string[] = [];
    const view = await readWebBudget('abc-123', async (id) => {
      asked.push(id);
      return {
        sessionId: id,
        used: 2,
        max: 2,
        toolNames: ['web_search', 7],
        errors: [],
        file: '/f',
        enforced: true,
      };
    });
    expect(asked).toEqual(['cindy-abc-123']);
    expect(view).toEqual({
      available: true,
      used: 2,
      max: 2,
      toolNames: ['web_search'],
      errors: [],
      file: '/f',
      enforced: true,
    });
  });

  it('a missing daemon, an old daemon, a bad id or a malformed answer reads as unavailable', async () => {
    expect(
      await readWebBudget('s', async () => {
        throw new Error('Method not found');
      }),
    ).toEqual(UNAVAILABLE_WEB_BUDGET);
    expect(await readWebBudget('', async () => ({ used: 1, max: 1 }))).toEqual(
      UNAVAILABLE_WEB_BUDGET,
    );
    expect(await readWebBudget(42, async () => ({ used: 1, max: 1 }))).toEqual(
      UNAVAILABLE_WEB_BUDGET,
    );
    expect(toWebBudgetView({ used: '1', max: 2 })).toEqual(UNAVAILABLE_WEB_BUDGET);
    expect(toWebBudgetView(null)).toEqual(UNAVAILABLE_WEB_BUDGET);
    expect(toWebBudgetView({ used: 1, max: 3 }).enforced).toBe(false);
  });
});
