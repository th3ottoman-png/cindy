/**
 * ROADMAP 13.5: what the session manifest strip's web-search chip says. Pure, so the wording
 * is unit-tested; the daemon owns the count (see main/maker-ipc/webBudget.ts).
 */

import type { WebBudgetView } from '../../../main/maker-ipc/webBudget';

export type WebBudgetChipState = 'ok' | 'near' | 'reached' | 'no-cap' | 'not-enforced';

export interface WebBudgetChip {
  label: string;
  title: string;
  state: WebBudgetChipState;
}

/** Null hides the chip (no daemon answer: nothing to say, nothing to guess). */
export function webBudgetChip(view: WebBudgetView | null | undefined): WebBudgetChip | null {
  if (!view || !view.available) return null;
  const file = view.file || '~/.cindy-harness/web-budget.yaml';
  const tools = view.toolNames.length > 0 ? view.toolNames.join(', ') : 'none';
  const problems = view.errors.length > 0 ? ` File problems (defaults used): ${view.errors.join('; ')}.` : '';
  if (view.max === 0) {
    return {
      label: 'web no cap',
      title: `No web-search cap: max_searches_per_session is 0 in ${file}.${problems}`,
      state: 'no-cap',
    };
  }
  if (!view.enforced) {
    return {
      label: `web –/${view.max}`,
      title:
        `Web-search cap ${view.max} per session (${tools}) is not enforced in this session: Default mode `
        + `and chat-only run Hermes without hooks. It applies in Full access and Auto-review. Edit ${file}.${problems}`,
      state: 'not-enforced',
    };
  }
  const reached = view.used >= view.max;
  const near = !reached && view.used >= Math.ceil(view.max * 0.8);
  return {
    label: `web ${view.used}/${view.max}`,
    title:
      `${view.used} of ${view.max} web calls used in this session (${tools}).`
      + (reached ? ' Further web calls are blocked with a reason the agent can read.' : '')
      + ` Resets on a new session or /clear. Edit ${file}.${problems}`,
    state: reached ? 'reached' : near ? 'near' : 'ok',
  };
}
