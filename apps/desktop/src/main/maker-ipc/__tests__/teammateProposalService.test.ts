/**
 * ROADMAP 12.3b (ADR 0011 §4): propose-only "may bring in others".
 * The bridge tool records proposals; the owner confirms from the strip;
 * the confirmed entry joins the SAME lead as a second worker (depth 1).
 */

import { describe, expect, it, vi } from 'vitest';

import { createTeammateProposalService, type TeammateProposalDeps } from '../teammateProposalService';
import { createSessionTeammatesStore, type SessionTeammateRecord } from '../sessionTeammates';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeDeps(over: Partial<TeammateProposalDeps> = {}): TeammateProposalDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-proposal-svc-'));
  const base: TeammateProposalDeps = {
    getLeadSnapshot: vi.fn(async () => ({
      agentKind: 'hermes',
      workingDir: '/tmp/project',
      permissionMode: 'bypassPermissions',
      orcaRole: null,
      remoteHostId: null,
      source: null,
    })),
    resolveRosterEntry: vi.fn(() => ({ ok: true as const, name: 'Geographer', file: '/tmp/experts/geographer/expert.md' })),
    getActiveTeam: vi.fn(async () => ({ id: 'team-1' })),
    startTeam: vi.fn(async () => ({ ok: true as const, teamId: 'team-1' })),
    createWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-2', workerSessionId: 'session-worker-2' })),
    dispatchToWorker: vi.fn(async () => ({ ok: true as const })),
    buildJoinPrompt: vi.fn(async (_lead: string, question: string) => 'JOIN PROMPT: ' + question),
    store: createSessionTeammatesStore({ file: path.join(dir, 'session-teammates.json') }),
  };
  return { ...base, ...over };
}

function historian(over: Partial<SessionTeammateRecord> = {}): SessionTeammateRecord {
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

const PROPOSE = {
  leadSessionId: 'lead-1',
  workerSessionId: 'session-worker-1',
  workerId: 'worker-1',
  rosterId: 'expert:geographer',
  reason: 'Needs maps for the trade routes.',
};

describe('canPropose', () => {
  it('is false when the worker is not a joined teammate', async () => {
    const deps = makeDeps();
    const svc = createTeammateProposalService(deps);
    expect(await svc.canPropose({ leadSessionId: 'lead-1', workerSessionId: 'session-worker-1' })).toBe(false);
  });

  it('is false by default and when explicitly off (fail closed)', async () => {
    const deps = makeDeps();
    deps.store.join('lead-1', historian());
    const svc = createTeammateProposalService(deps);
    expect(await svc.canPropose({ leadSessionId: 'lead-1', workerSessionId: 'session-worker-1' })).toBe(false);
    deps.store.setMayPropose('lead-1', 'expert:historian', false);
    expect(await svc.canPropose({ leadSessionId: 'lead-1', workerSessionId: 'session-worker-1' })).toBe(false);
  });

  it('is true only after the owner opts the teammate in', async () => {
    const deps = makeDeps();
    deps.store.join('lead-1', historian());
    deps.store.setMayPropose('lead-1', 'expert:historian', true);
    const svc = createTeammateProposalService(deps);
    expect(await svc.canPropose({ leadSessionId: 'lead-1', workerSessionId: 'session-worker-1' })).toBe(true);
  });
});

describe('recordProposal', () => {
  it('refuses a caller that is not a joined teammate', async () => {
    const deps = makeDeps();
    const svc = createTeammateProposalService(deps);
    const out = await svc.recordProposal(PROPOSE);
    expect(out).toMatchObject({ ok: false });
    expect(deps.store.listProposals('lead-1')).toEqual([]);
  });

  it('refuses when mayPropose is off', async () => {
    const deps = makeDeps();
    deps.store.join('lead-1', historian());
    const svc = createTeammateProposalService(deps);
    const out = await svc.recordProposal(PROPOSE);
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.message).toMatch(/enable|opt/i);
  });

  it('refuses a malformed roster id', async () => {
    const deps = makeDeps();
    deps.store.join('lead-1', historian({ mayPropose: true }));
    const svc = createTeammateProposalService(deps);
    const out = await svc.recordProposal({ ...PROPOSE, rosterId: 'bogus' });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.message).toContain('bogus');
  });

  it('refuses a target that is already a teammate', async () => {
    const deps = makeDeps();
    deps.store.join('lead-1', historian({ mayPropose: true }));
    deps.store.join('lead-1', historian({ rosterId: 'expert:geographer', name: 'Geographer', workerId: 'w9', workerSessionId: 's9' }));
    const svc = createTeammateProposalService(deps);
    const out = await svc.recordProposal(PROPOSE);
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.message).toMatch(/already/i);
  });

  it('refuses an entry that cannot run as a Hermes worker, naming the blocker', async () => {
    const deps = makeDeps({
      resolveRosterEntry: vi.fn(() => ({ ok: false as const, message: 'Imported agent "X" cannot run on "hermes". Tools that block it: WebSearch.' })),
    });
    deps.store.join('lead-1', historian({ mayPropose: true }));
    const svc = createTeammateProposalService(deps);
    const out = await svc.recordProposal({ ...PROPOSE, rosterId: 'imported:claude-user:x.md' });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.message).toContain('WebSearch');
  });

  it('records the proposal with names, broadcasts, and replaces a pending duplicate', async () => {
    const onChanged = vi.fn();
    const deps = makeDeps({ onTeammatesChanged: onChanged });
    deps.store.join('lead-1', historian({ mayPropose: true }));
    const svc = createTeammateProposalService(deps);
    const first = await svc.recordProposal(PROPOSE);
    expect(first.ok).toBe(true);
    const list = deps.store.listProposals('lead-1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      rosterId: 'expert:geographer',
      name: 'Geographer',
      reason: 'Needs maps for the trade routes.',
      proposedByRosterId: 'expert:historian',
      proposedByName: 'Historian',
      proposedByWorkerSessionId: 'session-worker-1',
    });
    expect(onChanged).toHaveBeenCalledWith('lead-1');
    const second = await svc.recordProposal({ ...PROPOSE, reason: 'Better reason.' });
    expect(second.ok).toBe(true);
    const after = deps.store.listProposals('lead-1');
    expect(after).toHaveLength(1);
    expect(after[0].reason).toBe('Better reason.');
  });
});

describe('decideProposal', () => {
  async function pending(deps: TeammateProposalDeps) {
    deps.store.join('lead-1', historian({ mayPropose: true }));
    const svc = createTeammateProposalService(deps);
    const out = await svc.recordProposal(PROPOSE);
    if (!out.ok) throw new Error('setup failed');
    return { svc, proposalId: out.proposalId };
  }

  it('refuses an unknown proposal', async () => {
    const deps = makeDeps();
    const svc = createTeammateProposalService(deps);
    await expect(svc.decideProposal('lead-1', 'nope', 'confirm')).rejects.toThrow(/proposal/i);
  });

  it('dismiss removes the proposal and tells the proposer, without creating anything', async () => {
    const onChanged = vi.fn();
    const deps = makeDeps({ onTeammatesChanged: onChanged });
    const { svc, proposalId } = await pending(deps);
    await svc.decideProposal('lead-1', proposalId, 'dismiss');
    expect(deps.store.listProposals('lead-1')).toEqual([]);
    expect(deps.createWorker).not.toHaveBeenCalled();
    expect(deps.dispatchToWorker).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'session-worker-1',
      message: expect.stringContaining('declined'),
    }));
    expect(onChanged).toHaveBeenCalledWith('lead-1');
  });

  it('confirm joins the target as a second worker on the same lead, with the reason as its task', async () => {
    const onChanged = vi.fn();
    const deps = makeDeps({ onTeammatesChanged: onChanged });
    const { svc, proposalId } = await pending(deps);
    await svc.decideProposal('lead-1', proposalId, 'confirm');
    expect(deps.startTeam).not.toHaveBeenCalled(); // team already active
    expect(deps.createWorker).toHaveBeenCalledWith(expect.objectContaining({
      leadSessionId: 'lead-1',
      teamId: 'team-1',
      rosterId: 'expert:geographer',
      workerPermissionMode: 'bypassPermissions',
      workingDir: '/tmp/project',
    }));
    expect(deps.store.find('lead-1', 'expert:geographer')).toMatchObject({
      workerId: 'worker-2',
      workerSessionId: 'session-worker-2',
      name: 'Geographer',
    });
    const joinDispatch = (deps.dispatchToWorker as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { targetSessionId: string; message: string })
      .find((call) => call.targetSessionId === 'session-worker-2');
    expect(joinDispatch?.message).toContain('JOIN PROMPT:');
    expect(joinDispatch?.message).toContain('Needs maps for the trade routes.');
    expect(joinDispatch?.message).toContain('Historian');
    expect(deps.store.listProposals('lead-1')).toEqual([]);
    const proposerNote = (deps.dispatchToWorker as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { targetSessionId: string; message: string })
      .find((call) => call.targetSessionId === 'session-worker-1');
    expect(proposerNote?.message).toContain('Geographer');
    expect(onChanged).toHaveBeenCalledWith('lead-1');
  });

  it('confirm starts the team when none is active', async () => {
    const deps = makeDeps({ getActiveTeam: vi.fn(async () => null) });
    const { svc, proposalId } = await pending(deps);
    await svc.decideProposal('lead-1', proposalId, 'confirm');
    expect(deps.startTeam).toHaveBeenCalledWith('lead-1', 'bypassPermissions');
  });

  it('confirm re-checks the permission ceiling and lead guards (never escalate)', async () => {
    for (const over of [
      { permissionMode: 'default' },
      { permissionMode: 'acceptEdits' },
      { permissionMode: 'plan' },
      { permissionMode: 'auto' },
      { orcaRole: 'worker' },
      { remoteHostId: 'host-2' },
      { source: 'bot' },
    ]) {
      const deps = makeDeps({
        getLeadSnapshot: vi.fn(async () => ({
          agentKind: 'hermes', workingDir: '/tmp/project', permissionMode: 'bypassPermissions',
          orcaRole: null, remoteHostId: null, source: null, ...over,
        })),
      });
      const { svc, proposalId } = await pending(deps);
      await expect(svc.decideProposal('lead-1', proposalId, 'confirm')).rejects.toThrow();
      expect(deps.createWorker).not.toHaveBeenCalled();
      expect(deps.store.listProposals('lead-1')).toHaveLength(1);
    }
  });

  it('confirm refuses when the entry became unavailable since the proposal', async () => {
    const deps = makeDeps();
    const { svc, proposalId } = await pending(deps);
    (deps.resolveRosterEntry as ReturnType<typeof vi.fn>).mockReturnValue({ ok: false, message: 'Expert "geographer" cannot be loaded.' });
    await expect(svc.decideProposal('lead-1', proposalId, 'confirm')).rejects.toThrow(/cannot be loaded/);
    expect(deps.createWorker).not.toHaveBeenCalled();
  });

  it('confirm refuses when the target joined in the meantime', async () => {
    const deps = makeDeps();
    const { svc, proposalId } = await pending(deps);
    deps.store.join('lead-1', historian({ rosterId: 'expert:geographer', name: 'Geographer', workerId: 'w9', workerSessionId: 's9' }));
    // join() prunes the proposal, so re-add it to simulate a stale pending row.
    deps.store.addProposal('lead-1', {
      id: proposalId, rosterId: 'expert:geographer', name: 'Geographer', reason: 'x',
      proposedByRosterId: 'expert:historian', proposedByName: 'Historian',
      proposedByWorkerSessionId: 'session-worker-1', createdAt: 'now',
    });
    await expect(svc.decideProposal('lead-1', proposalId, 'confirm')).rejects.toThrow(/already/i);
    expect(deps.createWorker).not.toHaveBeenCalled();
  });

  it('a failed dispatch still leaves the joined teammate visible; the proposal is consumed', async () => {
    const deps = makeDeps({
      dispatchToWorker: vi.fn(async (params: { targetSessionId: string }) =>
        params.targetSessionId === 'session-worker-2'
          ? { ok: false as const, message: 'worker dispatch failed' }
          : { ok: true as const }),
    });
    const { svc, proposalId } = await pending(deps);
    await expect(svc.decideProposal('lead-1', proposalId, 'confirm')).rejects.toThrow(/dispatch failed/);
    // join() prunes the proposal: the target IS joined now, so confirming again would be wrong.
    expect(deps.store.listProposals('lead-1')).toEqual([]);
    expect(deps.store.find('lead-1', 'expert:geographer')).not.toBeNull();
  });

  it('a failed proposer notification does not fail the confirm', async () => {
    const deps = makeDeps({
      dispatchToWorker: vi.fn(async (params: { targetSessionId: string }) =>
        params.targetSessionId === 'session-worker-1'
          ? { ok: false as const, message: 'proposer busy' }
          : { ok: true as const }),
    });
    const { svc, proposalId } = await pending(deps);
    await expect(svc.decideProposal('lead-1', proposalId, 'confirm')).resolves.toMatchObject({ ok: true });
    expect(deps.store.find('lead-1', 'expert:geographer')).not.toBeNull();
  });
});
