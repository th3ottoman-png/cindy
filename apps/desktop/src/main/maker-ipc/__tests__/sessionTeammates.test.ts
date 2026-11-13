import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionTeammatesStore, type SessionTeammateProposal, type SessionTeammateRecord } from '../sessionTeammates';

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

describe('createSessionTeammatesStore: mayPropose + proposals (ROADMAP 12.3b)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-teammates-prop-'));
    file = path.join(dir, 'session-teammates.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function proposal(over: Partial<SessionTeammateProposal> = {}): SessionTeammateProposal {
    return {
      id: 'prop-1',
      rosterId: 'expert:geographer',
      name: 'Geographer',
      reason: 'Needs maps for the trade routes.',
      proposedByRosterId: 'expert:historian',
      proposedByName: 'Historian',
      proposedByWorkerSessionId: 'session-worker-1',
      createdAt: '2026-11-13T01:00:00.000Z',
      ...over,
    };
  }

  it('mayPropose defaults off and toggles persistently', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    expect(store.find('lead-1', 'expert:historian')?.mayPropose).toBeUndefined();
    expect(store.setMayPropose('lead-1', 'expert:historian', true)).toBe(true);
    const reopened = createSessionTeammatesStore({ file });
    expect(reopened.find('lead-1', 'expert:historian')?.mayPropose).toBe(true);
    expect(reopened.setMayPropose('lead-1', 'expert:historian', false)).toBe(true);
    expect(createSessionTeammatesStore({ file }).find('lead-1', 'expert:historian')?.mayPropose).toBe(false);
  });

  it('setMayPropose reports false for a teammate that is not joined', () => {
    const store = createSessionTeammatesStore({ file });
    expect(store.setMayPropose('lead-1', 'expert:historian', true)).toBe(false);
  });

  it('adds, lists and persists proposals per lead', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    store.addProposal('lead-1', proposal());
    expect(store.listProposals('lead-1')).toHaveLength(1);
    expect(store.listProposals('lead-2')).toEqual([]);
    const reopened = createSessionTeammatesStore({ file });
    expect(reopened.listProposals('lead-1')[0]).toMatchObject({ rosterId: 'expert:geographer', proposedByName: 'Historian' });
    expect(fs.readdirSync(dir)).toEqual(['session-teammates.json']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('one pending proposal per target: a newer proposal replaces the older', () => {
    const store = createSessionTeammatesStore({ file });
    store.addProposal('lead-1', proposal());
    store.addProposal('lead-1', proposal({ id: 'prop-2', reason: 'Better reason.' }));
    const list = store.listProposals('lead-1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'prop-2', reason: 'Better reason.' });
  });

  it('removeProposal reports whether a proposal existed', () => {
    const store = createSessionTeammatesStore({ file });
    store.addProposal('lead-1', proposal());
    expect(store.removeProposal('lead-1', 'prop-1')).toBe(true);
    expect(store.removeProposal('lead-1', 'prop-1')).toBe(false);
    expect(store.listProposals('lead-1')).toEqual([]);
  });

  it('joining the proposed target clears its pending proposal', () => {
    const store = createSessionTeammatesStore({ file });
    store.addProposal('lead-1', proposal());
    store.join('lead-1', record({ rosterId: 'expert:geographer', name: 'Geographer', workerId: 'w2', workerSessionId: 's2' }));
    expect(store.listProposals('lead-1')).toEqual([]);
  });

  it('removing a teammate clears the proposals it made', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    store.addProposal('lead-1', proposal());
    store.addProposal('lead-1', proposal({ id: 'prop-other', rosterId: 'expert:writer', proposedByWorkerSessionId: 'session-worker-9' }));
    store.remove('lead-1', 'expert:historian');
    const left = store.listProposals('lead-1');
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe('prop-other');
  });

  it('removeByWorkerSession also clears the proposals it made', () => {
    const store = createSessionTeammatesStore({ file });
    store.join('lead-1', record());
    store.addProposal('lead-1', proposal());
    store.removeByWorkerSession('lead-1', 'session-worker-1');
    expect(store.listProposals('lead-1')).toEqual([]);
  });

  it('drops malformed proposals on read instead of crashing', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      leads: { 'lead-1': [record()] },
      proposals: {
        'lead-1': [
          proposal(),
          { id: 'bad', rosterId: 'not a roster id' },
          { id: 'no-reason', rosterId: 'expert:x', name: 'X', proposedByRosterId: 'expert:historian', proposedByName: 'H', proposedByWorkerSessionId: 's', createdAt: 'now' },
          'junk',
        ],
      },
    }));
    const store = createSessionTeammatesStore({ file });
    const list = store.listProposals('lead-1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('prop-1');
  });

  it('reads a 12.3a file without a proposals key', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, leads: { 'lead-1': [record()] } }));
    const store = createSessionTeammatesStore({ file });
    expect(store.list('lead-1')).toHaveLength(1);
    expect(store.listProposals('lead-1')).toEqual([]);
    store.addProposal('lead-1', proposal());
    expect(store.listProposals('lead-1')).toHaveLength(1);
  });

  it('refuses to add a proposal with an invalid target roster id', () => {
    const store = createSessionTeammatesStore({ file });
    expect(() => store.addProposal('lead-1', proposal({ rosterId: 'bogus' }))).toThrow(/roster/i);
  });
});
