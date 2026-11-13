import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  attachHermesFailureDetail,
  pickFailureLine,
  readHermesLogFailureLine,
  describeHermesRunFailure,
} from '../run-failure.js';

const dirs: string[] = [];

function makeHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-failure-'));
  dirs.push(home);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(home, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return home;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('pickFailureLine', () => {
  it('returns the last error-shaped line, stripped of pid and decoration', () => {
    const text = [
      'Traceback (most recent call last):',
      '  File "/x/y.py", line 1, in <module>',
      '    raise AuthError(...)',
      "[pid 94503] hermes_cli.auth_constants.AuthError: Unknown provider 'lmstudio-local'. Check 'hermes model' for available providers, or run 'hermes doctor' to diagnose config issues.",
      '',
    ].join('\n');
    expect(pickFailureLine(text)).toBe(
      "hermes_cli.auth_constants.AuthError: Unknown provider 'lmstudio-local'. Check 'hermes model' for available providers, or run 'hermes doctor' to diagnose config issues.",
    );
  });

  it('ignores the CLI stderr noise a doomed launch leaves behind', () => {
    const text = [
      '\u26a0 install out of sync (ffmpeg: not installed or outdated) \u2014 run `hermes pm install`',
      "Session: local-53c02c2b",
      '',
      'session_id: local-53c02c2b',
    ].join('\n');
    expect(pickFailureLine(text)).toBeUndefined();
  });

  it('returns nothing rather than a bare word when the text carries no failure', () => {
    expect(pickFailureLine('all good\nDone.')).toBeUndefined();
    expect(pickFailureLine('   \n\n')).toBeUndefined();
  });

  it('truncates a very long cause and collapses ansi escapes', () => {
    const line = '\u001b[31mError: ' + 'x'.repeat(900);
    const picked = pickFailureLine(line);
    expect(picked).toBeDefined();
    expect(picked).not.toContain('\u001b');
    expect((picked ?? '').length).toBeLessThanOrEqual(400);
  });
});

describe('readHermesLogFailureLine', () => {
  it('reads the tail of the managed worker log in the given home', () => {
    const home = makeHome({
      'logs/managed-worker.log':
        '[pid 1] starting\n[pid 94503] hermes_cli.auth_constants.AuthError: Unknown provider \'x\'.\n',
    });
    expect(readHermesLogFailureLine(home)).toContain("AuthError: Unknown provider 'x'");
  });

  it('is silent when the home has no worker log', () => {
    expect(readHermesLogFailureLine(makeHome({}))).toBeUndefined();
  });

  it('only reads the tail, so an old cause cannot outrun a newer empty log', () => {
    const home = makeHome({
      'logs/managed-worker.log': 'Error: stale failure from a previous turn\n' + 'y'.repeat(64 * 1024) + '\n',
    });
    expect(readHermesLogFailureLine(home)).toBeUndefined();
  });
});

describe('describeHermesRunFailure', () => {
  it('prefers the worker log, which is where a failed worker writes the real cause', () => {
    const home = makeHome({
      'logs/managed-worker.log': 'hermes_cli.auth_constants.AuthError: Unknown provider \'x\'.\n',
    });
    expect(describeHermesRunFailure(home, 'session_id: local-1\n')).toContain('Unknown provider');
  });

  it('falls back to the child stderr tail when the home logged nothing', () => {
    expect(describeHermesRunFailure(makeHome({}), 'Error: gateway refused the connection\n'))
      .toBe('Error: gateway refused the connection');
  });

  it('returns undefined when neither side carries a cause', () => {
    expect(describeHermesRunFailure(makeHome({}), 'session_id: local-1\n')).toBeUndefined();
  });
});

describe('describeHermesRunFailure staleness guard', () => {
  it('ignores a worker log that predates the run it would explain', () => {
    const home = makeHome({
      'logs/managed-worker.log': "hermes_cli.auth_constants.AuthError: Unknown provider 'old'.\n",
    });
    const future = Date.now() + 60_000;
    expect(describeHermesRunFailure(home, '', { notBeforeMs: future })).toBeUndefined();
    expect(readHermesLogFailureLine(home, { notBeforeMs: future })).toBeUndefined();
  });

  it('accepts a worker log written during the run', () => {
    const home = makeHome({
      'logs/managed-worker.log': "hermes_cli.auth_constants.AuthError: Unknown provider 'now'.\n",
    });
    expect(describeHermesRunFailure(home, '', { notBeforeMs: Date.now() - 60_000 }))
      .toContain("Unknown provider 'now'");
  });
});

describe('attachHermesFailureDetail', () => {
  it('fills a failing result that names only an exit code', () => {
    const home = makeHome({
      'logs/managed-worker.log': "hermes_cli.auth_constants.AuthError: Unknown provider 'x'.\n",
    });
    const event = { type: 'result', exit_code: 1, text: 'Worker execution is unknown.' };
    const out = attachHermesFailureDetail(event, home) as Record<string, unknown>;
    expect(out.error).toContain("Unknown provider 'x'");
    // Forward-compatible: everything the CLI did send is preserved.
    expect(out.text).toBe('Worker execution is unknown.');
    expect(out.exit_code).toBe(1);
  });

  it('never overwrites an error the CLI already reported', () => {
    const home = makeHome({
      'logs/managed-worker.log': "hermes_cli.auth_constants.AuthError: Unknown provider 'x'.\n",
    });
    const event = { type: 'result', exit_code: 1, error: 'rate limited' };
    expect(attachHermesFailureDetail(event, home)).toBe(event);
  });

  it('leaves a successful result, other event types and junk alone', () => {
    const home = makeHome({
      'logs/managed-worker.log': "hermes_cli.auth_constants.AuthError: Unknown provider 'x'.\n",
    });
    const ok = { type: 'result', exit_code: 0, text: 'done' };
    expect(attachHermesFailureDetail(ok, home)).toBe(ok);
    const text = { type: 'text', text: 'hi' };
    expect(attachHermesFailureDetail(text, home)).toBe(text);
    expect(attachHermesFailureDetail(null, home)).toBeNull();
  });

  it('leaves the result untouched when no cause can be found', () => {
    const event = { type: 'result', exit_code: 1 };
    expect(attachHermesFailureDetail(event, makeHome({}))).toBe(event);
  });
});
