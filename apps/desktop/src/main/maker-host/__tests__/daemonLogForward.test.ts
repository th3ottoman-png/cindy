import { describe, expect, it } from 'vitest';

import {
  createDaemonLogForwarder,
  drainDaemonLogLines,
  isReportableDaemonLogLine,
} from '../daemon-log-forward.js';

describe('isReportableDaemonLogLine', () => {
  it('keeps the daemon warn and error markers', () => {
    expect(isReportableDaemonLogLine('[hermes-mgr][warn] Hermes run failed {')).toBe(true);
    expect(isReportableDaemonLogLine('[hermes-mgr][error] boom')).toBe(true);
    expect(isReportableDaemonLogLine('  [hermes-mgr][warn] padded  ')).toBe(true);
  });

  it('drops info/debug chatter and the child CLI’s own output', () => {
    expect(isReportableDaemonLogLine('[hermes-mgr][info] manager started')).toBe(false);
    expect(isReportableDaemonLogLine('[hermes-mgr][debug] x')).toBe(false);
    expect(isReportableDaemonLogLine('hermes chat: starting')).toBe(false);
    expect(isReportableDaemonLogLine('')).toBe(false);
  });
});

describe('drainDaemonLogLines', () => {
  it('returns complete lines and keeps the unterminated tail', () => {
    expect(drainDaemonLogLines('[a] 1\n[b] 2\n[c] par')).toEqual({
      lines: ['[a] 1', '[b] 2'],
      rest: '[c] par',
    });
  });

  it('strips a CRLF carriage return and handles a buffer with no newline', () => {
    expect(drainDaemonLogLines('x\r\n')).toEqual({ lines: ['x'], rest: '' });
    expect(drainDaemonLogLines('only')).toEqual({ lines: [], rest: 'only' });
  });
});

describe('createDaemonLogForwarder', () => {
  it('forwards a WARN split across two chunks exactly once', () => {
    const seen: string[] = [];
    const forward = createDaemonLogForwarder((line) => seen.push(line));
    forward('[hermes-mgr][warn] Herm');
    expect(seen).toEqual([]);
    forward('es run failed {\n');
    expect(seen).toEqual(['[hermes-mgr][warn] Hermes run failed {']);
  });

  it('forwards several reportable lines and skips the rest in one chunk', () => {
    const seen: string[] = [];
    const forward = createDaemonLogForwarder((line) => seen.push(line));
    forward(
      '[hermes-mgr][info] started\n[hermes-mgr][warn] a\nnoise\n[hermes-mgr][error] b\n',
    );
    expect(seen).toEqual(['[hermes-mgr][warn] a', '[hermes-mgr][error] b']);
  });

  it('bounds one line so a stack trace cannot swallow the log', () => {
    const seen: string[] = [];
    const forward = createDaemonLogForwarder((line) => seen.push(line));
    forward(`[hermes-mgr][error] ${'x'.repeat(10_000)}\n`);
    expect(seen).toHaveLength(1);
    expect(seen[0].length).toBeLessThanOrEqual(4_000);
  });
});
