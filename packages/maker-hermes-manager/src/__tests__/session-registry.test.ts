import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionRegistry } from '../session-registry.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionRegistry persistence', () => {
  it('starts empty and warns when the registry file is truncated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-registry-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, '[{"sessionId":"unfinished"');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const registry = new SessionRegistry(file);

    expect(registry.list()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('session registry');
  });
});
