import { describe, expect, it } from 'vitest';

import {
  nextTurnSuggestionKey,
  suggestNextTurn,
  SUGGESTION_MAX_LABEL,
} from '../next-turn-suggestion';

describe('suggestNextTurn', () => {
  it('takes the backticked command from a Next action line', () => {
    const suggestion = suggestNextTurn(
      [
        'Phase 8.4 is committed as `63a32c673d`.',
        '',
        '**Next action (1 min):** say `go 8.1` for the Library workspace, about 3 h build plus 30 min gates.',
      ].join('\n'),
    );

    expect(suggestion).not.toBeNull();
    expect(suggestion?.text).toBe('go 8.1');
    expect(suggestion?.reason).toBe('next-action');
    expect(suggestion?.sourceLine).toContain('Next action');
  });

  it('stays silent when the next action is a UI instruction with no sendable command', () => {
    const suggestion = suggestNextTurn(
      'Next action (2 min): in the running dev app, click the new `Capabilities` sidebar row and type `vault`.',
    );

    expect(suggestion).toBeNull();
  });

  it('accepts a short next action with no backticks', () => {
    const suggestion = suggestNextTurn(
      'Next action: pick Row 7.3 for the next session, about 45 min of build',
    );

    expect(suggestion?.text).toBe('pick Row 7.3 for the next session, about 45 min of build');
    expect(suggestion?.reason).toBe('next-action');
  });

  it('uses a trailing question when there is no next-action line', () => {
    const suggestion = suggestNextTurn(
      ['The suite is green on the current tree.', 'Do you want the sharded form instead?'].join('\n'),
    );

    expect(suggestion?.reason).toBe('question');
    expect(suggestion?.text).toBe('Do you want the sharded form instead?');
  });

  it('ignores a question inside a fenced code block', () => {
    const suggestion = suggestNextTurn(
      ['All checks passed.', '```', '// is this done?', 'const x = 1;', '```'].join('\n'),
    );

    expect(suggestion).toBeNull();
  });

  it('keeps scanning after a closed fence', () => {
    const suggestion = suggestNextTurn(
      ['```', 'const x = 1;', '```', 'Should I ship this now?'].join('\n'),
    );

    expect(suggestion?.text).toBe('Should I ship this now?');
  });

  it('reads an offer that is not phrased as a question', () => {
    const suggestion = suggestNextTurn(
      ['That is everything for 9.1.', 'Let me know if you want the sharded gate instead.'].join('\n'),
    );

    expect(suggestion?.reason).toBe('offer');
    expect(suggestion?.text).toBe('Let me know if you want the sharded gate instead.');
  });

  it('offers the first entry of a closing menu', () => {
    const suggestion = suggestNextTurn(
      ['Two routes from here.', '', 'Which do you want?', '1. Ship 8.5 now', '2. Fix 7.4 first'].join(
        '\n',
      ),
    );

    expect(suggestion?.reason).toBe('option');
    expect(suggestion?.text).toBe('Ship 8.5 now');
  });

  it('does not treat a bare list as a menu', () => {
    const suggestion = suggestNextTurn(['Files changed:', '- one.ts', '- two.ts'].join('\n'));

    expect(suggestion).toBeNull();
  });

  it('returns null for a plain completion report', () => {
    expect(
      suggestNextTurn('Gates are green. The commit is pushed and the tree is clean.'),
    ).toBeNull();
  });

  it('returns null for empty or missing text', () => {
    expect(suggestNextTurn('')).toBeNull();
    expect(suggestNextTurn('   \n  ')).toBeNull();
    expect(suggestNextTurn(null)).toBeNull();
    expect(suggestNextTurn(undefined)).toBeNull();
  });

  it('rejects a long paragraph even when it ends in a question mark', () => {
    const long = `${'This is a long explanatory sentence about the gate method, '.repeat(4)}is that acceptable?`;
    expect(suggestNextTurn(long)).toBeNull();
  });

  it('rejects a bare URL', () => {
    expect(suggestNextTurn('Next action: https://example.test/run')).toBeNull();
  });

  it('honours a tighter maxLength', () => {
    expect(suggestNextTurn('Next action: run the whole sharded gate set again', { maxLength: 10 })).toBeNull();
  });

  it('ellipsises a long label but keeps the full text', () => {
    const text = 'continue with the next roadmap row and report back with the gate numbers now';
    const suggestion = suggestNextTurn(`Next action: ${text}`);
    expect(suggestion?.text).toBe(text);
    expect(suggestion?.label.length).toBeLessThanOrEqual(SUGGESTION_MAX_LABEL);
    expect(suggestion?.label.endsWith('…')).toBe(true);
  });

  it('keeps a stable key per suggestion', () => {
    const suggestion = suggestNextTurn('Next action: `go 9.2`');
    expect(suggestion && nextTurnSuggestionKey(suggestion)).toBe('next-action:go 9.2');
  });

  it('prefers the last backticked command in the line', () => {
    const suggestion = suggestNextTurn(
      'Next action: if the diff looks wrong, say `revert 8.4` then `go 9.2`',
    );
    expect(suggestion?.text).toBe('go 9.2');
  });

  it('strips emphasis and list markers from the suggestion', () => {
    const suggestion = suggestNextTurn('Next action: - **Ship it**');
    expect(suggestion?.text).toBe('Ship it');
  });
});
