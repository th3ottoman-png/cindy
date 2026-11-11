import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ChatOnlyHost } from '../chatOnly.js';

const dir = () => mkdtempSync(join(tmpdir(), 'cindy-chat-only-'));

describe('ChatOnlyHost', () => {
  it('is off for a session it has never seen, and for an empty id', () => {
    const host = new ChatOnlyHost({ file: join(dir(), 'chat-only.json') });
    expect(host.isChatOnly('s1')).toBe(false);
    expect(host.isChatOnly('')).toBe(false);
  });

  it('persists the flag so a restart still launches chat-only', () => {
    const file = join(dir(), 'chat-only.json');
    expect(new ChatOnlyHost({ file }).set('s1', true)).toEqual({ sessionId: 's1', chatOnly: true });
    // A second instance is what a restarted app builds: it must see the same answer.
    expect(new ChatOnlyHost({ file }).isChatOnly('s1')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ s1: true });
  });

  it('turning it off clears the entry instead of storing false', () => {
    const file = join(dir(), 'chat-only.json');
    const host = new ChatOnlyHost({ file });
    host.set('s1', true);
    host.set('s2', true);
    host.set('s1', false);
    expect(host.isChatOnly('s1')).toBe(false);
    expect(host.isChatOnly('s2')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ s2: true });
  });

  it('ignores a corrupt or hostile file rather than treating sessions as chat-only', () => {
    const file = join(dir(), 'chat-only.json');
    writeFileSync(file, '{ nope', 'utf8');
    expect(new ChatOnlyHost({ file }).isChatOnly('s1')).toBe(false);
    writeFileSync(file, JSON.stringify({ s1: 'yes', s2: 1, s3: true }), 'utf8');
    const host = new ChatOnlyHost({ file });
    expect(host.isChatOnly('s1')).toBe(false);
    expect(host.isChatOnly('s3')).toBe(true);
  });
});
