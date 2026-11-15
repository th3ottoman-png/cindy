import { describe, expect, it } from 'vitest';

import { parseShellTimeoutNotice, shellTimeoutLabel } from '../shellLimitNotice.js';

describe('parseShellTimeoutNotice', () => {
  it('reads the bracketed marker Hermes prints at the limit', () => {
    expect(parseShellTimeoutNotice('done\n[Command timed out after 5s]')).toEqual({ seconds: 5 });
  });

  it('reads the backend-error sentence', () => {
    expect(parseShellTimeoutNotice('Command timed out after 300 seconds')).toEqual({ seconds: 300 });
  });

  it('finds the marker inside a JSON result', () => {
    expect(parseShellTimeoutNotice(JSON.stringify({ output: '[Command timed out after 30s]' }))).toEqual({
      seconds: 30,
    });
  });

  it('returns null for an ordinary result', () => {
    expect(parseShellTimeoutNotice('total 12\ndrwxr-xr-x  3 turko staff')).toBeNull();
  });

  it('returns null for a result that mentions a timeout without a number', () => {
    expect(parseShellTimeoutNotice('Command timed out after a while')).toBeNull();
  });

  it('returns null for an empty or missing result', () => {
    expect(parseShellTimeoutNotice('')).toBeNull();
    expect(parseShellTimeoutNotice(undefined)).toBeNull();
    expect(parseShellTimeoutNotice(null)).toBeNull();
  });

  it('rejects a zero-second marker', () => {
    expect(parseShellTimeoutNotice('[Command timed out after 0s]')).toBeNull();
  });

  it('labels the badge in seconds', () => {
    expect(shellTimeoutLabel({ seconds: 5 })).toBe('stopped at 5 s');
  });
});
