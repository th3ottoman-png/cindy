import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionTeammatesStore, type SessionTeammateRecord } from '../sessionTeammates';

function record(over: Partial<SessionTeammateRecord> = {}): SessionTeammateRecord {
  return {
    rosterId: 'expert:historian',
    name: 'Historian',
    workerId: 'worker-1',
    workerSessionId: 'session-worker-1',
    teamId: 'team-1',
    joinedAt: '2026-11-13T00:00:00.000Z',
    ...over,
  };
}

describe('createSessionTeammatesStore (ROADMAP 12.3, ADR 0011)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-teammates-'));
    file = path.join(dir, 'session-teammates.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('joins, finds and lists a teammate', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    expect(store.find('lead-1', 'expert:historian')).toMatchObject({ workerSessionId: 'session-worker-1' });
    expect(store.list('lead-1')).toHaveLength(1);
    expect(store.list('lead-2')).toEqual([]);
  });

  it('one worker per teammate: re-joining the same roster id replaces the record', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    store.join('lead-1', record({ workerId: 'worker-2', workerSessionId: 'session-worker-2' }));
    const list = store.list('lead-1');
    expect(list).toHaveLength(1);
    expect(list[0].workerSessionId).toBe('session-worker-2');
  });

  it('keeps distinct roster ids side by side', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    store.join('lead-1', record({ rosterId: 'imported:claude-user:geographer.md', name: 'Geographer', workerId: 'w2', workerSessionId: 's2' }));
    expect(store.list('lead-1')).toHaveLength(2);
  });

  it('remove reports whether a record existed', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    expect(store.remove('lead-1', 'expert:historian')).toBe(true);
    expect(store.remove('lead-1', 'expert:historian')).toBe(false);
    expect(store.list('lead-1')).toEqual([]);
  });

  it('removeByWorkerSession returns the removed record', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    expect(store.removeByWorkerSession('lead-1', 'session-worker-1')).toMatchObject({ rosterId: 'expert:historian' });
    expect(store.removeByWorkerSession('lead-1', 'session-worker-1')).toBeNull();
  });

  it('persists across instances and leaves no temp files', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    const reopened = createSessionTeammatesStore({ file });
    expect(reopened.find('lead-1', 'expert:historian')).toMatchObject({ name: 'Historian' });
    expect(fs.readdirSync(dir)).toEqual(['session-teammates.json']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a corrupt file yields an empty registry, not a crash, and accepts new joins', () => {
    fs.writeFileSync(file, '{"version":1,"leads":{truncated');
    const store = createSessionTeammatesStore({ file });
    expect(store.list('lead-1')).toEqual([]);
    store.join('lead-1', record());
    expect(store.list('lead-1')).toHaveLength(1);
  });

  it('drops malformed records on read instead of crashing', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      leads: {
        'lead-1': [
          record(),
          { rosterId: 'not a roster id', name: 'x', workerId: 'w', workerSessionId: 's', teamId: 't', joinedAt: 'now' },
          { rosterId: 'expert:ok' },
          'junk',
        ],
      },
    }));
    const store = createSessionTeammatesStore({ file });
    const list = store.list('lead-1');
    expect(list).toHaveLength(1);
    expect(list[0].rosterId).toBe('expert:historian');
  });

  it('refuses to join an invalid roster id', () => {
    const store = createSessionTeammatesStore({ file });
    expect(() => store.join('lead-1', record({ rosterId: 'bogus' }))).toThrow(/roster/i);
  });
});
