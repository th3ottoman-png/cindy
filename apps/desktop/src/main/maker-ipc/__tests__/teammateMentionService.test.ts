import { describe, expect, it, vi } from 'vitest';

import { createTeammateMentionService, type TeammateMentionDeps } from '../teammateMentionService';
import { createSessionTeammatesStore } from '../sessionTeammates';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeDeps(over: Partial<TeammateMentionDeps> = {}): TeammateMentionDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mention-svc-'));
  const base: TeammateMentionDeps = {
    getLeadSnapshot: vi.fn(async () => ({
      agentKind: 'hermes',
      workingDir: '/tmp/project',
      permissionMode: 'bypassPermissions',
      orcaRole: null,
      remoteHostId: null,
      source: null,
    })),
    resolveRosterEntry: vi.fn(() => ({ ok: true as const, name: 'Historian', file: '/tmp/experts/historian/expert.md' })),
    getActiveTeam: vi.fn(async () => null),
    startTeam: vi.fn(async () => ({ ok: true as const, teamId: 'team-1' })),
    listWorkers: vi.fn(async () => []),
    createWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1', workerSessionId: 'session-worker-1' })),
    dispatchToWorker: vi.fn(async () => ({ ok: true as const })),
    buildJoinPrompt: vi.fn(async (_lead: string, question: string) => 'JOIN PROMPT: ' + question),
    store: createSessionTeammatesStore({ file: path.join(dir, 'session-teammates.json') }),
    isTeammateSendAllowed: () => true,
  };
  return { ...base, ...over };
}

describe('createTeammateMentionService (ROADMAP 12.3, ADR 0011)', () => {
  it('passes non-mention messages through untouched', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    expect(await svc.applyTeammateMentions('lead-1', 'plain message')).toBeNull();
    expect(await svc.applyTeammateMentions('lead-1', { type: 'user', content: 'structured' })).toBeNull();
    expect(await svc.applyTeammateMentions('lead-1', { text: 'structured', images: [], files: [] })).toBeNull();
    expect(await svc.applyTeammateMentions('lead-1', '@expert:historian turn attachment')).toBeNull();
    expect(deps.startTeam).not.toHaveBeenCalled();
  });

  it('rewrites the composer wire shape {text, images, files} keeping attachments', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    const out = await svc.applyTeammateMentions('lead-1', {
      text: '@agent:expert:historian what happened?',
      images: [{ path: '/tmp/x.png' }],
      files: [],
      slashCommandRanges: [],
    }) as { text: string; images: unknown[]; slashCommandRanges: unknown[] };
    expect(out.text).toContain('what happened?');
    expect(out.text).toContain('Historian');
    expect(out.text).not.toContain('@agent:');
    expect(out.images).toEqual([{ path: '/tmp/x.png' }]);
    expect(out.slashCommandRanges).toEqual([]);
    expect(deps.dispatchToWorker).toHaveBeenCalledWith(expect.objectContaining({ message: 'JOIN PROMPT: what happened?' }));
  });

  it('rewrites the coordinator block shape, keeping non-text blocks', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    const out = await svc.applyTeammateMentions('lead-1', {
      type: 'user',
      content: [
        { type: 'text', text: '@agent:expert:historian look at this' },
        { type: 'image', path: '/tmp/x.png' },
      ],
    }) as { type: string; content: Array<{ type: string; text?: string; path?: string }> };
    expect(out.type).toBe('user');
    expect(out.content[0].text).toContain('look at this');
    expect(out.content[0].text).not.toContain('@agent:');
    expect(out.content[1]).toEqual({ type: 'image', path: '/tmp/x.png' });
  });

  it('orca inter-agent messages pass through even when they quote a mention', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    const quoted = 'JOIN PROMPT: excerpt says @agent:expert:historian hi --- End of excerpt ---';
    expect(await svc.applyTeammateMentions('worker-1', quoted, { persistUserMessage: { origin: { kind: 'orca' } } })).toBeNull();
    expect(deps.getLeadSnapshot).not.toHaveBeenCalled();
    expect(deps.dispatchToWorker).not.toHaveBeenCalled();
  });

  it('auto-resume replays never dispatch twice', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    expect(await svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi', { autoResume: true })).toBeNull();
    expect(await svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi', { persistUserMessage: { autoResume: true } })).toBeNull();
    expect(deps.dispatchToWorker).not.toHaveBeenCalled();
  });

  it('rewrites the legacy {type:user, content} shape', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    const out = await svc.applyTeammateMentions('lead-1', { type: 'user', content: '@agent:expert:historian go' }) as { type: string; content: string };
    expect(out.type).toBe('user');
    expect(out.content).toContain('go');
    expect(out.content).not.toContain('@agent:');
  });

  it('refuses a malformed mention before anything starts', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    await expect(svc.applyTeammateMentions('lead-1', '@agent:oops do it')).rejects.toThrow(/oops/);
    expect(deps.startTeam).not.toHaveBeenCalled();
    expect(deps.createWorker).not.toHaveBeenCalled();
  });

  it('refuses when the roster entry cannot run as a Hermes worker, before any team', async () => {
    const deps = makeDeps({
      resolveRosterEntry: vi.fn(() => ({ ok: false as const, message: 'Imported agent "X" cannot run on "hermes". Tools that block it: WebSearch.' })),
    });
    const svc = createTeammateMentionService(deps);
    await expect(svc.applyTeammateMentions('lead-1', '@agent:imported:claude-user:x.md hi')).rejects.toThrow(/WebSearch/);
    expect(deps.startTeam).not.toHaveBeenCalled();
  });

  it('refuses a lead below Full access (worker modes are binary; never escalate)', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) {
      const deps = makeDeps({
        getLeadSnapshot: vi.fn(async () => ({
          agentKind: 'hermes', workingDir: '/tmp/project', permissionMode: mode,
          orcaRole: null, remoteHostId: null, source: null,
        })),
      });
      const svc = createTeammateMentionService(deps);
      await expect(svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi')).rejects.toThrow(/Full access|Auto/);
      expect(deps.startTeam).not.toHaveBeenCalled();
    }
  });

  it('refuses worker leads, remote leads and bot sessions', async () => {
    for (const over of [
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
      const svc = createTeammateMentionService(deps);
      await expect(svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi')).rejects.toThrow();
      expect(deps.startTeam).not.toHaveBeenCalled();
    }
  });

  it('refuses when the send does not come from this computer', async () => {
    const deps = makeDeps({ isTeammateSendAllowed: () => false });
    const svc = createTeammateMentionService(deps);
    await expect(svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi')).rejects.toThrow(/this computer/i);
  });

  it('first mention: starts the team, creates the worker, dispatches the join prompt, rewrites the lead message', async () => {
    const onChanged = vi.fn();
    const deps = makeDeps({ onTeammatesChanged: onChanged });
    const svc = createTeammateMentionService(deps);
    const out = await svc.applyTeammateMentions('lead-1', '@agent:expert:historian what happened in 1923?');
    expect(deps.startTeam).toHaveBeenCalledWith('lead-1', 'bypassPermissions');
    expect(deps.createWorker).toHaveBeenCalledWith(expect.objectContaining({
      leadSessionId: 'lead-1',
      teamId: 'team-1',
      rosterId: 'expert:historian',
      workerPermissionMode: 'bypassPermissions',
    }));
    expect(deps.buildJoinPrompt).toHaveBeenCalledWith('lead-1', 'what happened in 1923?');
    expect(deps.dispatchToWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      targetSessionId: 'session-worker-1',
      message: 'JOIN PROMPT: what happened in 1923?',
    });
    expect(out).toContain('what happened in 1923?');
    expect(out).toContain('Historian');
    expect(out).not.toContain('@agent:');
    expect(deps.store.find('lead-1', 'expert:historian')).toMatchObject({ workerSessionId: 'session-worker-1', teamId: 'team-1' });
    expect(onChanged).toHaveBeenCalledWith('lead-1');
  });

  it('second mention reuses the same worker and sends plain text (no second excerpt)', async () => {
    const deps = makeDeps({
      getActiveTeam: vi.fn(async () => ({ id: 'team-1' })),
      listWorkers: vi.fn(async () => [{ id: 'worker-1', sessionId: 'session-worker-1', label: 'historian', status: 'idle' }]),
    });
    deps.store.join('lead-1', {
      rosterId: 'expert:historian', name: 'Historian', workerId: 'worker-1',
      workerSessionId: 'session-worker-1', teamId: 'team-1', joinedAt: '2026-11-13T00:00:00.000Z',
    });
    const svc = createTeammateMentionService(deps);
    const out = await svc.applyTeammateMentions('lead-1', '@agent:expert:historian and in 1924?');
    expect(deps.startTeam).not.toHaveBeenCalled();
    expect(deps.createWorker).not.toHaveBeenCalled();
    expect(deps.buildJoinPrompt).not.toHaveBeenCalled();
    expect(deps.dispatchToWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      targetSessionId: 'session-worker-1',
      message: 'and in 1924?',
    });
    expect(out).toContain('and in 1924?');
  });

  it('a stale registry record (worker gone from the team) creates a fresh worker', async () => {
    const deps = makeDeps({
      getActiveTeam: vi.fn(async () => ({ id: 'team-1' })),
      listWorkers: vi.fn(async () => []),
      createWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-2', workerSessionId: 'session-worker-2' })),
    });
    deps.store.join('lead-1', {
      rosterId: 'expert:historian', name: 'Historian', workerId: 'worker-1',
      workerSessionId: 'session-worker-1', teamId: 'team-0', joinedAt: '2026-11-13T00:00:00.000Z',
    });
    const svc = createTeammateMentionService(deps);
    await svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi again');
    expect(deps.createWorker).toHaveBeenCalledTimes(1);
    expect(deps.store.find('lead-1', 'expert:historian')).toMatchObject({ workerSessionId: 'session-worker-2' });
    expect(deps.dispatchToWorker).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'session-worker-2' }));
  });

  it('dedupes repeated mentions of the same roster id into one dispatch', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    await svc.applyTeammateMentions('lead-1', '@agent:expert:historian one @agent:expert:historian two');
    expect(deps.createWorker).toHaveBeenCalledTimes(1);
    expect(deps.dispatchToWorker).toHaveBeenCalledTimes(1);
  });

  it('dispatches to each distinct teammate when several are mentioned', async () => {
    let n = 0;
    const deps = makeDeps({
      createWorker: vi.fn(async () => {
        n += 1;
        return { ok: true as const, workerId: 'worker-' + n, workerSessionId: 'session-worker-' + n };
      }),
    });
    const svc = createTeammateMentionService(deps);
    const out = await svc.applyTeammateMentions('lead-1', '@agent:expert:historian @agent:imported:claude-user:geographer.md compare');
    expect(deps.createWorker).toHaveBeenCalledTimes(2);
    expect(deps.dispatchToWorker).toHaveBeenCalledTimes(2);
    expect(out).toContain('compare');
  });

  it('a failed worker creation refuses the whole send', async () => {
    const deps = makeDeps({
      createWorker: vi.fn(async () => ({ ok: false as const, message: 'hard limit 4 reached' })),
    });
    const svc = createTeammateMentionService(deps);
    await expect(svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi')).rejects.toThrow(/hard limit/);
    expect(deps.dispatchToWorker).not.toHaveBeenCalled();
  });

  it('a failed dispatch refuses the whole send', async () => {
    const deps = makeDeps({
      dispatchToWorker: vi.fn(async () => ({ ok: false as const, message: 'worker queue paused' })),
    });
    const svc = createTeammateMentionService(deps);
    await expect(svc.applyTeammateMentions('lead-1', '@agent:expert:historian hi')).rejects.toThrow(/queue paused/);
  });

  it('falls back to the plain question when the lead has no history to excerpt', async () => {
    const deps = makeDeps({ buildJoinPrompt: vi.fn(async () => null) });
    const svc = createTeammateMentionService(deps);
    await svc.applyTeammateMentions('lead-1', '@agent:expert:historian first ever message');
    expect(deps.dispatchToWorker).toHaveBeenCalledWith(expect.objectContaining({ message: 'first ever message' }));
  });

  it('an empty question after stripping still joins with the default handoff question', async () => {
    const deps = makeDeps();
    const svc = createTeammateMentionService(deps);
    const out = await svc.applyTeammateMentions('lead-1', '@agent:expert:historian');
    expect(deps.buildJoinPrompt).toHaveBeenCalledWith('lead-1', '');
    expect(out).toContain('Historian');
  });
});
