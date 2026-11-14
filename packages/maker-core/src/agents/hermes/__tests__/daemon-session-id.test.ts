import { describe, expect, it } from 'vitest';

import { hermesDaemonSessionId } from '../daemon-session-id.js';

describe('hermesDaemonSessionId (ROADMAP 1.14)', () => {
  it('gives one Cindy conversation the same daemon session on every app start', () => {
    const first = hermesDaemonSessionId('ef62593b');
    const second = hermesDaemonSessionId('ef62593b');
    expect(first).toBe(second);
    expect(first).toContain('ef62593b');
  });

  it('keeps two conversations apart', () => {
    expect(hermesDaemonSessionId('ef62593b')).not.toBe(hermesDaemonSessionId('5be0ad2a'));
  });

  it('namespaces the id so it can never collide with a legacy per-start UUID record', () => {
    const legacy = '003e6a90-5fa5-4ae5-a74e-0f6d4d216966';
    expect(hermesDaemonSessionId(legacy)).not.toBe(legacy);
    expect(hermesDaemonSessionId(legacy).startsWith('cindy-')).toBe(true);
  });

  it('stays a single filesystem-safe path component', () => {
    for (const hostile of ['../../etc/passwd', 'a/b\\c', 'with space', '..', '.']) {
      const id = hermesDaemonSessionId(hostile);
      expect(id.startsWith('cindy-')).toBe(true);
      expect(id).not.toContain('/');
      expect(id).not.toContain('\\');
      expect(id).not.toContain(' ');
    }
  });

  it('falls back to a unique id when there is no Cindy conversation to key on', () => {
    const ids = [
      hermesDaemonSessionId(undefined),
      hermesDaemonSessionId(null),
      hermesDaemonSessionId(''),
      hermesDaemonSessionId('   '),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toContain('cindy-');
  });
});
