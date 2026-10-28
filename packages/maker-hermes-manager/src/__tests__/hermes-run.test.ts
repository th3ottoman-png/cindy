import { describe, expect, it } from 'vitest';

import { buildHermesArgs, isInvalidResumeFailure, type HermesRunResult } from '../hermes-run.js';

function result(patch: Partial<HermesRunResult> = {}): HermesRunResult {
  return { code: 1, signal: null, sawResult: true, stderrTail: '', ...patch };
}

const LOST_SESSION = "No session found matching 'local-abc'. Use 'hermes sessions list' to see available sessions, or pass -c <name> --create-if-missing to start a new session with that title.";

describe('buildHermesArgs', () => {
  it('forwards --resume only for a non-empty id', () => {
    const base = { hermesBin: 'hermes', hermesHome: '/tmp/home', cwd: '/tmp', text: 'hi' };
    expect(buildHermesArgs({ ...base, resumeHermesSessionId: 'local-abc' }))
      .toContain('local-abc');
    expect(buildHermesArgs({ ...base, resumeHermesSessionId: '' }))
      .not.toContain('--resume');
  });
});

describe('isInvalidResumeFailure', () => {
  it('recognizes the documented missing-session result error', () => {
    expect(isInvalidResumeFailure(result({
      resultEvent: { exit_code: 1, error: LOST_SESSION },
    }))).toBe(true);
  });

  it('recognizes the same message when only stderr carries it', () => {
    expect(isInvalidResumeFailure(result({ stderrTail: `Error: ${LOST_SESSION}\n` }))).toBe(true);
  });

  it('ignores a successful run', () => {
    expect(isInvalidResumeFailure(result({
      code: 0,
      resultEvent: { exit_code: 0, error: LOST_SESSION },
    }))).toBe(false);
  });

  it('ignores unrelated crashes so they still surface', () => {
    expect(isInvalidResumeFailure(result({
      resultEvent: { exit_code: 1, error: 'invalid api key' },
      stderrTail: 'simulated hermes crash',
    }))).toBe(false);
    expect(isInvalidResumeFailure(result({ spawnError: 'ENOENT', stderrTail: LOST_SESSION })))
      .toBe(false);
  });
});
