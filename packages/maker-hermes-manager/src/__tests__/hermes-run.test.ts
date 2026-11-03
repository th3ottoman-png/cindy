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

  it('passes toolsets as one sorted -t value, and no -t without them (ROADMAP 3.10)', () => {
    const base = { hermesBin: 'hermes', hermesHome: '/tmp/home', cwd: '/tmp', text: 'hi' };
    // Hermes compares the -t string of a resume with the launch exactly, so order must be stable.
    const args = buildHermesArgs({ ...base, toolsets: ['web', 'clarify'] });
    expect(args[args.indexOf('-t') + 1]).toBe('clarify,web');
    expect(buildHermesArgs(base)).not.toContain('-t');
    expect(buildHermesArgs({ ...base, toolsets: [] })).not.toContain('-t');
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
