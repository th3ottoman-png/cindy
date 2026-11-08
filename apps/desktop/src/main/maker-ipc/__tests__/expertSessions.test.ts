import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import {
  EXPERT_MEMORY_PREAMBLE_CHARS,
  ExpertSessionStore,
  PENDING_EXPERT_TTL_MS,
  buildExpertPreamble,
  createRouteMatcher,
  type RouteMatcher,
} from '../expertSessions';
import { registerExpertsHandlers, type ExpertsHandlerHandle } from '../expertsHandlers';
import { IpcHarness } from './helpers/ipcHarness';

let dir: string;
let root: string;
let bindingsFile: string;
let handle: ExpertsHandlerHandle | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-sessions-'));
  root = path.join(dir, 'experts');
  bindingsFile = path.join(dir, 'expert-sessions.json');
  fs.mkdirSync(root);
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeExpert(slug: string, frontmatter: string, body = 'You review code.'): void {
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  fs.writeFileSync(path.join(root, slug, 'expert.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

const anyRoute: RouteMatcher = () => ({ ok: true });

describe('ExpertSessionStore (ROADMAP 3.2a)', () => {
  it('binds the pending pick to the first fresh session that sends, then clears it', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer\nagent: hermes');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    const events: unknown[] = [];
    store.onChange((e) => events.push(e));
    store.setPending('code-reviewer');

    const preamble = store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'qwen3-8b' }, anyRoute);
    expect(preamble).toContain('[Cindy expert: Code Reviewer]');
    expect(preamble).toContain('You review code.');
    expect(store.getPending()).toBeNull();
    expect(events).toEqual([
      { type: 'pending', slug: 'code-reviewer' },
      { type: 'bound', sessionId: 's1', slug: 'code-reviewer' },
      { type: 'pending', slug: null },
    ]);
    // A second session gets nothing: the pick was spent.
    expect(store.resolveFirstTurnPreamble({ sessionId: 's2', model: 'qwen3-8b' }, anyRoute)).toBeNull();
  });

  it('keeps the binding on disk, so a new store (app restart) still shows and applies it', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer');
    new ExpertSessionStore({ rootDir: root, bindingsFile }).setPending('code-reviewer');
    const first = new ExpertSessionStore({ rootDir: root, bindingsFile });
    expect(first.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute)).toBeNull();

    first.setPending('code-reviewer');
    first.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute);
    const raw = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    expect(raw.sessions.s1.slug).toBe('code-reviewer');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const restarted = new ExpertSessionStore({ rootDir: root, bindingsFile });
    expect(restarted.describeBinding('s1')).toMatchObject({ slug: 'code-reviewer', name: 'Code Reviewer' });
    expect(restarted.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute)).toContain('Code Reviewer');
  });

  it('ignores a pick older than the time limit', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer');
    let now = 1_000;
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile, now: () => now });
    store.setPending('code-reviewer');
    now += PENDING_EXPERT_TTL_MS + 1;
    expect(store.getPending()).toBeNull();
    expect(store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute)).toBeNull();
  });

  it('fails closed with what to fix when the bound expert breaks, is not Hermes, or is on another route', () => {
    writeExpert('broken', 'agent: hermes');
    writeExpert('codex-one', 'name: Codex One\nagent: codex');
    writeExpert('routed', 'name: Routed\nmodel: local-backup');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });

    store.setPending('broken');
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'a', model: 'm' }, anyRoute))
      .toThrow(/Expert "broken" cannot be loaded: frontmatter "name" is required\. Fix .*expert\.md/);
    // The binding stays, so the header shows the broken expert instead of hiding it.
    expect(store.describeBinding('a')).toMatchObject({ slug: 'broken', error: expect.stringContaining('"name"') });

    store.setPending('codex-one');
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'b', model: 'm' }, anyRoute))
      .toThrow('is set to agent "codex", but this session is running on "hermes"');
    const codexPreamble = store.resolveFirstTurnPreamble({ sessionId: 'b', model: 'm', agent: 'codex' }, anyRoute);
    expect(codexPreamble).toContain('[Cindy expert: Codex One]');

    store.setPending('routed');
    const wrongRoute: RouteMatcher = (route, model) => ({ ok: false, message: `wants ${route}, has ${model}` });
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'c', model: 'gemma' }, wrongRoute))
      .toThrow('Expert "Routed": wants local-backup, has gemma');
  });

  it('refuses slugs that are not plain folder names', () => {
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    for (const bad of ['../outside', 'a/b', '.hidden', '', 'a..b']) {
      expect(() => store.setPending(bad)).toThrow('invalid expert');
    }
  });

  it('builds a preamble that names the expert and marks where the owner message starts', () => {
    expect(buildExpertPreamble({ name: 'Code Reviewer', prompt: '  Be careful.\n' })).toBe(
      '[Cindy expert: Code Reviewer]\nFor this whole session, act as the expert described below.\n\nBe careful.\n\n'
      + "[End of expert instructions. The owner's first message follows.]",
    );
  });
});

describe('createRouteMatcher (ROADMAP 3.2a)', () => {
  const routes: Record<string, { model: string; baseUrl: string; providerId?: string }> = {
    'local-backup': { model: 'qwen3-8b', baseUrl: 'http://127.0.0.1:1234/v1', providerId: 'lmstudio-local' },
    'qwen3-8b': { model: 'qwen3-8b', baseUrl: 'http://127.0.0.1:1234/v1', providerId: 'lmstudio-local' },
    'qwen3:8b': { model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434/v1', providerId: 'ollama-local' },
  };
  const match = createRouteMatcher((m) => routes[m] ?? null);

  it('accepts the session model that resolves to the route', () => {
    expect(match('local-backup', 'qwen3-8b')).toEqual({ ok: true });
  });

  it('names the model to pick on a mismatch, without switching anything', () => {
    const result = match('local-backup', 'qwen3:8b');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('runs on route "local-backup" (lmstudio-local/qwen3-8b)');
    expect(!result.ok && result.message).toContain('Pick qwen3-8b in the model menu');
    // The Hermes home route never satisfies a routed expert.
    expect(match('local-backup', 'hermes-default').ok).toBe(false);
  });

  it('reports a route missing from routing.yaml', () => {
    const result = match('nope', 'qwen3-8b');
    expect(!result.ok && result.message).toContain('"nope" is not in ~/.cindy-harness/routing.yaml');
  });
});

describe('experts session IPC (ROADMAP 3.2a)', () => {
  it('sets and reads the pending pick, describes bindings, and pushes store events', async () => {
    writeExpert('code-reviewer', 'name: Code Reviewer\nmodel: local-backup');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted, broadcast, sessions: store });

    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_GET_PENDING)).toBeNull();
    await harness.invoke(MAKER_INVOKE.EXPERTS_SET_PENDING, 'code-reviewer');
    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_GET_PENDING)).toBe('code-reviewer');
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_SESSION_EVENT, { type: 'pending', slug: 'code-reviewer' });
    await expect(harness.invoke(MAKER_INVOKE.EXPERTS_SET_PENDING, '../x')).rejects.toThrow('invalid expert slug');

    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_SESSION_BINDING, 's1')).toBeNull();
    store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'qwen3-8b' }, () => ({ ok: true }));
    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_SESSION_BINDING, 's1')).toEqual({
      sessionId: 's1',
      slug: 'code-reviewer',
      dir: path.join(root, 'code-reviewer'),
      name: 'Code Reviewer',
      model: 'local-backup',
    });
    expect(assertTrusted).toHaveBeenCalledTimes(6);

    handle.dispose();
    handle = undefined;
    broadcast.mockClear();
    store.setPending(null);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('expert creator gate (ROADMAP 3.8)', () => {
  it('allows a tool only for a session bound to a Hermes expert that lists it', () => {
    writeExpert('expert-creator', 'name: Expert Creator\ntools: [draft_expert]');
    writeExpert('code-reviewer', 'name: Code Reviewer');
    writeExpert('codex-creator', 'name: Codex Creator\nagent: codex\ntools: [draft_expert]');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });

    store.setPending('expert-creator');
    // Before the first send only the tool-list check may look at the pending pick.
    expect(store.expertAllowsTool('s1', 'draft_expert')).toBe(false);
    expect(store.expertAllowsTool('s1', 'draft_expert', { includePending: true })).toBe(true);
    store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute);
    expect(store.expertAllowsTool('s1', 'draft_expert')).toBe(true);
    expect(store.expertAllowsTool('s1', 'other_tool')).toBe(false);

    store.setPending('code-reviewer');
    store.resolveFirstTurnPreamble({ sessionId: 's2', model: 'm' }, anyRoute);
    expect(store.expertAllowsTool('s2', 'draft_expert')).toBe(false);

    fs.writeFileSync(bindingsFile, JSON.stringify({ version: 1, sessions: { s3: { slug: 'codex-creator', boundAt: 'x' } } }));
    expect(store.expertAllowsTool('s3', 'draft_expert')).toBe(false);
    expect(store.expertAllowsTool('nobody', 'draft_expert', { includePending: true })).toBe(false);
  });

  it('enforces tools.yaml allow and deny policies for tools and mcp servers (ROADMAP 3.2b)', () => {
    writeExpert('scoped-expert', 'name: Scoped Expert\ntools: [frontmatter_tool]');
    fs.writeFileSync(
      path.join(root, 'scoped-expert', 'tools.yaml'),
      `tools:
  allow: [read_project_file, frontmatter_tool]
  deny: [frontmatter_tool]
mcp_servers:
  allow: [cindy_project_reader, cindy_docs]
  deny: [cindy_docs]
`,
    );
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.setPending('scoped-expert');
    store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute);

    // Tools: read_project_file allowed; frontmatter_tool denied (deny wins); unlisted bash blocked
    expect(store.expertAllowsTool('s1', 'read_project_file')).toBe(true);
    expect(store.expertAllowsTool('s1', 'frontmatter_tool')).toBe(false);
    expect(store.expertAllowsTool('s1', 'bash')).toBe(false);

    // MCP servers: cindy_project_reader allowed; cindy_docs denied (deny wins); unlisted cindy_browser blocked
    expect(store.expertAllowsMcpServer('s1', 'cindy_project_reader')).toBe(true);
    expect(store.expertAllowsMcpServer('s1', 'cindy_docs')).toBe(false);
    expect(store.expertAllowsMcpServer('s1', 'cindy_browser')).toBe(false);

    // Non-expert session allows all MCP servers by default
    expect(store.expertAllowsMcpServer('unbound-sess', 'cindy_browser')).toBe(true);
  });
});

describe('expert draft IPC (ROADMAP 3.8)', () => {
  it('lists waiting drafts, settles them, and pushes draft events', async () => {
    const { ExpertDraftConfirm } = await import('../expertDraftConfirm');
    const drafts = new ExpertDraftConfirm({ timeoutMs: 60_000 });
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted, broadcast, drafts });

    const wait = drafts.request({
      sessionId: 's1',
      draft: { slug: 'x-y', name: 'X', description: 'd', tags: [], memory: false, prompt: 'p' },
      targetDir: path.join(root, 'x-y'),
      markdown: 'md',
    });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_DRAFT_EVENT, expect.objectContaining({ type: 'request' }));
    const listed = (await harness.invoke(MAKER_INVOKE.EXPERTS_DRAFT_LIST, 's1')) as Array<{ requestId: string }>;
    expect(listed).toHaveLength(1);
    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_DRAFT_LIST, 'other')).toEqual([]);
    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_DRAFT_DECIDE, 'nope', { approved: true })).toBe(false);
    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_DRAFT_DECIDE, listed[0].requestId, { approved: false, note: 'no' })).toBe(true);
    await expect(wait).resolves.toEqual({ approved: false, reason: 'rejected', note: 'no' });
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.EXPERTS_DRAFT_EVENT, expect.objectContaining({ type: 'settled', outcome: 'rejected' }));
    expect(assertTrusted).toHaveBeenCalledTimes(4);
  });
});

describe('expert memory in sessions (ROADMAP 3.4b)', () => {
  it('puts the saved notes and the save tool into the first-turn preamble only when memory is on', () => {
    writeExpert('mem', 'name: Mem\nmemory: true');
    fs.writeFileSync(path.join(root, 'mem', 'memory.md'), '## 2026-11-01T00:00:00.000Z\n\nowner prefers tabs\n');
    writeExpert('plain', 'name: Plain');
    fs.writeFileSync(path.join(root, 'plain', 'memory.md'), 'notes of a memory-off expert\n');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });

    store.setPending('mem');
    const withMemory = store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute) ?? '';
    expect(withMemory).toContain('owner prefers tabs');
    expect(withMemory).toContain('save_expert_memory');
    // The notes sit inside the expert block, before the owner's first message.
    expect(withMemory.indexOf('owner prefers tabs')).toBeLessThan(withMemory.indexOf('[End of expert instructions.'));

    store.setPending('plain');
    const without = store.resolveFirstTurnPreamble({ sessionId: 's2', model: 'm' }, anyRoute) ?? '';
    expect(without).not.toContain('notes of a memory-off expert');
    expect(without).not.toContain('save_expert_memory');
  });

  it('says when there are no notes yet and keeps only the newest notes within the limit', () => {
    writeExpert('mem', 'name: Mem\nmemory: true');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.setPending('mem');
    expect(store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute)).toContain('(no notes yet)');

    const filler = 'x'.repeat(EXPERT_MEMORY_PREAMBLE_CHARS);
    fs.writeFileSync(
      path.join(root, 'mem', 'memory.md'),
      `## 2026-01-01T00:00:00.000Z\n\nOLDEST NOTE ${filler}\n\n## 2026-11-01T00:00:00.000Z\n\nNEWEST NOTE\n`,
    );
    store.setPending('mem');
    const cut = store.resolveFirstTurnPreamble({ sessionId: 's2', model: 'm' }, anyRoute) ?? '';
    expect(cut).toContain('NEWEST NOTE');
    expect(cut).not.toContain('OLDEST NOTE');
    expect(cut).toContain('older notes were left out');
  });

  it('gives the toolsets lock of the bound expert, or the pending pick when asked (ROADMAP 3.10)', () => {
    writeExpert('advisor', 'name: Advisor\nagent: hermes\ntoolsets: [web, clarify]');
    writeExpert('code-reviewer', 'name: Code Reviewer\nagent: hermes');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    expect(store.expertToolsets('fresh')).toBeNull();
    store.setPending('advisor');
    expect(store.expertToolsets('fresh')).toBeNull();
    expect(store.expertToolsets('fresh', { includePending: true })).toEqual(['web', 'clarify']);
    store.bindSession('bound', 'advisor');
    expect(store.expertToolsets('bound')).toEqual(['web', 'clarify']);
    store.bindSession('plain', 'code-reviewer');
    expect(store.expertToolsets('plain')).toBeNull();
  });

  it('refuses a first turn whose launch lock differs from the expert lock, in either direction (ROADMAP 3.10)', () => {
    writeExpert('advisor', 'name: Advisor\nagent: hermes\ntoolsets: [web, clarify]');
    writeExpert('code-reviewer', 'name: Code Reviewer\nagent: hermes');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    // Picked after the session started unlocked: the lock was never applied, so no turn may run.
    store.bindSession('late', 'advisor');
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'late', model: 'm' }, anyRoute))
      .toThrow(/locks this chat/);
    store.bindSession('loose', 'code-reviewer');
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'loose', model: 'm', toolsets: ['web'] }, anyRoute))
      .toThrow(/locks this chat|toolsets/);
    store.bindSession('ok', 'advisor');
    expect(store.resolveFirstTurnPreamble({ sessionId: 'ok', model: 'm', toolsets: ['clarify', 'web'] }, anyRoute))
      .toContain('[Cindy expert: Advisor]');
  });

  it('gives a memory target only for a Hermes expert with memory on (pending only when asked)', () => {
    writeExpert('mem', 'name: Mem\nmemory: true');
    writeExpert('plain', 'name: Plain');
    writeExpert('codex-mem', 'name: Codex Mem\nagent: codex\nmemory: true');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });

    store.setPending('mem');
    expect(store.expertMemoryTarget('s1')).toBeNull();
    expect(store.expertMemoryTarget('s1', { includePending: true })).toEqual({ dir: path.join(root, 'mem'), memory: true });
    store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute);
    expect(store.expertMemoryTarget('s1')).toEqual({ dir: path.join(root, 'mem'), memory: true });

    store.setPending('plain');
    store.resolveFirstTurnPreamble({ sessionId: 's2', model: 'm' }, anyRoute);
    expect(store.expertMemoryTarget('s2')).toBeNull();

    fs.writeFileSync(bindingsFile, JSON.stringify({ version: 1, sessions: { s3: { slug: 'codex-mem', boundAt: 'x' } } }));
    expect(store.expertMemoryTarget('s3')).toBeNull();
    expect(store.expertMemoryTarget('nobody')).toBeNull();
  });
});

describe('ask-expert handoff IPC (ROADMAP 3.6b)', () => {
  const source = {
    title: 'Route planning',
    agent: 'hermes',
    model: 'deepseek-v4-pro',
    rows: [
      { role: 'user', content: JSON.stringify({ text: 'Plan my sales route for SW1A, E1, N1' }), createdAt: 1 },
      { role: 'tool_use', content: { toolName: 'read_file', input: { path: '/x' } }, createdAt: 2 },
      { role: 'tool_result', content: 'PAYLOAD', createdAt: 3 },
      { role: 'assistant', content: 'Start at E1, then N1, then SW1A.', createdAt: 4 },
    ],
  };

  function setup(handoffSource = vi.fn(async (id: string) => (id === 'src' ? source : null))) {
    writeExpert('code-reviewer', 'name: Code Reviewer');
    writeExpert('routed-expert', 'name: Routed Expert\nagent: hermes\nmodel: local-backup');
    writeExpert('codex-one', 'name: Codex One\nagent: codex');
    writeExpert('broken', 'agent: hermes');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    const broadcast = vi.fn();
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted: vi.fn(), broadcast, sessions: store, handoffSource });
    return { store, broadcast, harness, handoffSource };
  }

  it('builds the first message from the stored session and makes the expert the pending pick', async () => {
    const { store, broadcast, harness } = setup();
    const res = await harness.invoke(MAKER_INVOKE.EXPERTS_HANDOFF, { sessionId: 'src', slug: 'code-reviewer' }) as {
      ok: true; slug: string; prompt: string; includedMessages: number;
    };
    expect(res).toMatchObject({ ok: true, slug: 'code-reviewer', includedMessages: 2 });
    expect(res.prompt).toContain('"Route planning" (agent hermes, model deepseek-v4-pro)');
    expect(res.prompt).toContain('Owner: Plan my sales route for SW1A, E1, N1');
    expect(res.prompt).toContain('Assistant: Start at E1, then N1, then SW1A.\n(tools used: read_file)');
    expect(res.prompt).not.toContain('PAYLOAD');
    expect(store.getPending()).toBe('code-reviewer');
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_SESSION_EVENT, { type: 'pending', slug: 'code-reviewer' });

    const routedRes = await harness.invoke(MAKER_INVOKE.EXPERTS_HANDOFF, { sessionId: 'src', slug: 'routed-expert' }) as {
      ok: true; slug: string; model?: string;
    };
    expect(routedRes).toMatchObject({ ok: true, slug: 'routed-expert', model: 'local-backup' });
    expect(store.getPending()).toBe('routed-expert');
  });

  it('refuses without touching the pending pick: bad slug, broken or non-Hermes expert, unknown or empty session', async () => {
    const empty = { ...source, rows: [{ role: 'tool_result', content: 'x', createdAt: 1 }] };
    const { store, harness, handoffSource } = setup(vi.fn(async (id: string) => (id === 'src' ? source : id === 'empty' ? empty : null)));
    const ask = (sessionId: string, slug: string) => harness.invoke(MAKER_INVOKE.EXPERTS_HANDOFF, { sessionId, slug });

    expect(await ask('src', '../x')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await ask('src', 'broken')).toMatchObject({ ok: false, reason: 'expert-unavailable' });
    expect(await ask('src', 'codex-one')).toMatchObject({ ok: false, reason: 'expert-unavailable', message: expect.stringContaining('Hermes') });
    expect(await ask('src', 'missing')).toMatchObject({ ok: false, reason: 'expert-unavailable' });
    expect(await ask('nope', 'code-reviewer')).toMatchObject({ ok: false, reason: 'no-session' });
    expect(await ask('empty', 'code-reviewer')).toMatchObject({ ok: false, reason: 'no-messages' });
    expect(await ask('', 'code-reviewer')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(store.getPending()).toBeNull();
    // The expert is checked before any session data is read.
    expect(handoffSource.mock.calls.map((c) => c[0])).toEqual(['nope', 'empty']);
  });
});

describe('Orca worker as an expert (ROADMAP 3.9a, ADR 0008)', () => {
  it('checks a worker expert: loadable Hermes only, with its model route', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer\nagent: hermes\nmodel: deepseek-route');
    writeExpert('plain', 'name: Plain\nagent: hermes');
    writeExpert('codex-one', 'name: Codex One\nagent: codex');
    writeExpert('broken', 'name: [unclosed');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    expect(store.checkWorkerExpert('code-reviewer')).toEqual({ ok: true, model: 'deepseek-route' });
    expect(store.checkWorkerExpert('plain')).toEqual({ ok: true });
    expect(store.checkWorkerExpert('codex-one')).toMatchObject({ ok: false, message: expect.stringContaining('hermes') });
    expect(store.checkWorkerExpert('broken')).toMatchObject({ ok: false });
    expect(store.checkWorkerExpert('missing')).toMatchObject({ ok: false });
    expect(store.checkWorkerExpert('../x')).toMatchObject({ ok: false });
  });

  it('binds a worker session directly, without touching the pending pick', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer\nagent: hermes');
    writeExpert('research-analyst', 'name: Research Analyst\nagent: hermes');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.setPending('research-analyst');
    const events: unknown[] = [];
    store.onChange((e) => events.push(e));

    store.bindSession('worker-1', 'code-reviewer');
    expect(events).toEqual([{ type: 'bound', sessionId: 'worker-1', slug: 'code-reviewer' }]);
    expect(store.getPending()).toBe('research-analyst');
    expect(new ExpertSessionStore({ rootDir: root, bindingsFile }).getBoundSlug('worker-1')).toBe('code-reviewer');
    const preamble = store.resolveFirstTurnPreamble({ sessionId: 'worker-1', model: 'hermes-default' }, anyRoute);
    expect(preamble).toContain('[Cindy expert: Code Reviewer]');
    expect(store.getPending()).toBe('research-analyst');
    expect(() => store.bindSession('worker-2', '../escape')).toThrow();
  });
});

describe('"Go ahead" IPC (ROADMAP 3.10c)', () => {
  const source = {
    title: 'Suggest tasks',
    agent: 'hermes',
    model: 'hermes-default',
    workingDir: '/projects/modoki',
    permissionMode: 'bypassPermissions',
    rows: [
      { role: 'user', content: JSON.stringify({ text: 'Suggest ways to save time' }), createdAt: 1 },
      { role: 'assistant', content: 'Option 1: a CSV normalizer.', createdAt: 2 },
      { role: 'user', content: JSON.stringify({ text: 'Option 1, go ahead' }), createdAt: 3 },
    ],
  };

  function setup(handoffSource = vi.fn(async (id: string) => (id === 'src' || id === 'plain' ? source : null))) {
    writeExpert('options-first', 'name: Options First\ntoolsets: [web]');
    writeExpert('code-reviewer', 'name: Code Reviewer');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.bindSession('src', 'options-first');
    store.bindSession('plain', 'code-reviewer');
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted: vi.fn(), broadcast: vi.fn(), sessions: store, handoffSource });
    return { store, harness, handoffSource };
  }

  it('shows the lock in the binding view so the header can offer Go ahead', () => {
    const { store } = setup();
    expect(store.describeBinding('src')).toMatchObject({ slug: 'options-first', toolsets: ['web'] });
    expect(store.describeBinding('plain')).not.toHaveProperty('toolsets');
  });

  it('builds a plain-task prompt from a locked session, keeps its folder and access, and clears the pending pick', async () => {
    const { store, harness } = setup();
    store.setPending('code-reviewer');
    const res = await harness.invoke(MAKER_INVOKE.EXPERTS_GO_AHEAD, { sessionId: 'src' }) as {
      ok: true; prompt: string; workingDir: string | null; permissionMode: string | null;
    };
    expect(res).toMatchObject({ ok: true, workingDir: '/projects/modoki', permissionMode: 'bypassPermissions' });
    expect(res.prompt.startsWith('Option picked: \n')).toBe(true);
    expect(res.prompt).toContain('Owner: Option 1, go ahead');
    expect(store.getPending()).toBeNull();
  });

  it('refuses an unlocked or unknown session without reading it or touching the pending pick', async () => {
    const { store, harness, handoffSource } = setup();
    store.setPending('code-reviewer');
    const go = (sessionId: unknown) => harness.invoke(MAKER_INVOKE.EXPERTS_GO_AHEAD, { sessionId });
    expect(await go('plain')).toMatchObject({ ok: false, reason: 'not-locked' });
    expect(await go('unbound')).toMatchObject({ ok: false, reason: 'not-locked' });
    expect(await go('')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await go(42)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(handoffSource).not.toHaveBeenCalled();
    expect(store.getPending()).toBe('code-reviewer');
  });
});

describe('ExpertSessionStore vault notes access (ROADMAP 5.1)', () => {
  it('evaluates vault access from tools.yaml mcp_servers.allow', () => {
    writeExpert('vault-researcher', 'name: Vault Researcher\nagent: hermes');
    fs.writeFileSync(
      path.join(root, 'vault-researcher', 'tools.yaml'),
      'mcp_servers:\n  allow:\n    - cindy_vault_notes\n',
    );
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.bindSession('s1', 'vault-researcher');

    expect(store.expertAllowsVaultTool('s1', 'read_note')).toBe(true);
    expect(store.expertAllowsVaultTool('s1', 'search_notes')).toBe(true);
    expect(store.expertAllowsVaultTool('s1', 'append_note')).toBe(true);
    expect(store.sessionHasVaultAccess('s1')).toBe(true);
  });

  it('honours strict tools.allow and tools.deny in tools.yaml', () => {
    writeExpert('read-only-vault', 'name: Read Only Vault\nagent: hermes');
    fs.writeFileSync(
      path.join(root, 'read-only-vault', 'tools.yaml'),
      'mcp_servers:\n  allow:\n    - cindy_vault_notes\ntools:\n  allow:\n    - read_note\n    - search_notes\n',
    );
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.bindSession('s1', 'read-only-vault');

    expect(store.expertAllowsVaultTool('s1', 'read_note')).toBe(true);
    expect(store.expertAllowsVaultTool('s1', 'search_notes')).toBe(true);
    expect(store.expertAllowsVaultTool('s1', 'append_note')).toBe(false);
    expect(store.sessionHasVaultAccess('s1')).toBe(true);
  });

  it('supports frontmatter tools: opt-in', () => {
    writeExpert('frontmatter-vault', 'name: FM Vault\nagent: hermes\ntools: [read_note]');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.bindSession('s1', 'frontmatter-vault');

    expect(store.expertAllowsVaultTool('s1', 'read_note')).toBe(true);
    expect(store.expertAllowsVaultTool('s1', 'append_note')).toBe(false);
    expect(store.sessionHasVaultAccess('s1')).toBe(true);
  });

  it('fails closed when not opted in or not an expert session', () => {
    writeExpert('plain', 'name: Plain\nagent: hermes');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    store.bindSession('s1', 'plain');

    expect(store.expertAllowsVaultTool('s1', 'read_note')).toBe(false);
    expect(store.sessionHasVaultAccess('s1')).toBe(false);
    expect(store.expertAllowsVaultTool('non-existent-session', 'read_note')).toBe(false);
    expect(store.sessionHasVaultAccess('non-existent-session')).toBe(false);
  });
});

