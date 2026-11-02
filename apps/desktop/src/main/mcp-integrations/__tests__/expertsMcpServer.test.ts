import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadExperts } from '@cindy/maker-core/experts';

import type { ExpertDraftDecision } from '../../maker-ipc/expertDraftConfirm';
import { createExpertsMcpServer, DRAFT_EXPERT_TOOL, SAVE_EXPERT_MEMORY_TOOL, type ExpertsMcpDeps } from '../expertsMcpServer';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'experts-mcp-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const args = {
  slug: 'uk-cold-email',
  name: 'UK Cold Email Writer',
  description: 'Writes short B2B cold emails for UK buyers.',
  prompt: 'You write cold emails. Keep them under 120 words.',
};

function deps(over: Partial<ExpertsMcpDeps> = {}): ExpertsMcpDeps & { confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn(async (): Promise<ExpertDraftDecision> => ({ approved: true }));
  return {
    getSessionContext: () => ({ agentKind: 'hermes', sessionId: 's1' }),
    rootDir: () => root,
    sessionMayDraft: (id) => id === 's1',
    memoryTarget: () => null,
    confirm,
    ...over,
  } as ExpertsMcpDeps & { confirm: ReturnType<typeof vi.fn> };
}

async function call(d: ExpertsMcpDeps, input: Record<string, unknown> = args, tool = DRAFT_EXPERT_TOOL) {
  const server = createExpertsMcpServer(d);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'experts-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    const result = await client.callTool({ name: tool, arguments: input });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

describe('cindy_experts draft_expert (ROADMAP 3.8)', () => {
  it('approve writes a loadable expert and reports saved', async () => {
    const d = deps();
    const res = await call(d);
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ status: 'saved', slug: 'uk-cold-email' });
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      targetDir: path.join(root, 'uk-cold-email'),
      markdown: expect.stringContaining('name: UK Cold Email Writer'),
    }));
    const [entry] = loadExperts(root);
    expect(entry.expert).toMatchObject({ name: 'UK Cold Email Writer', agent: 'hermes', tools: [] });
  });

  it('reject writes nothing and returns the owner note', async () => {
    const d = deps({ confirm: vi.fn(async () => ({ approved: false, reason: 'rejected', note: 'make it shorter' } as const)) });
    const res = await call(d);
    expect(res.body).toEqual({ status: 'rejected', message: 'The owner rejected the draft. Nothing was written.', ownerNote: 'make it shorter' });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('no answer writes nothing', async () => {
    const res = await call(deps({ confirm: vi.fn(async () => ({ approved: false, reason: 'timeout' } as const)) }));
    expect(res.body.status).toBe('no_answer');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses a session not started as an expert creator, without asking the owner', async () => {
    const d = deps({ sessionMayDraft: () => false });
    const res = await call(d);
    expect(res).toMatchObject({ isError: true, body: { errorCode: 'NOT_EXPERT_CREATOR' } });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it('refuses non-Hermes callers and calls with no session', async () => {
    for (const ctx of [{ agentKind: 'pi', sessionId: 's1' }, { agentKind: 'hermes', sessionId: undefined }, undefined]) {
      const d = deps({ getSessionContext: () => ctx });
      const res = await call(d);
      expect(res).toMatchObject({ isError: true, body: { errorCode: 'NO_SESSION_CONTEXT' } });
      expect(d.confirm).not.toHaveBeenCalled();
    }
  });

  it('sends invalid drafts and taken slugs back to the model without asking the owner', async () => {
    const d = deps();
    const bad = await call(d, { ...args, slug: '../x' });
    expect(bad).toMatchObject({ isError: true, body: { status: 'invalid' } });
    fs.mkdirSync(path.join(root, 'uk-cold-email'));
    const taken = await call(d);
    expect(taken).toMatchObject({ isError: true, body: { status: 'invalid' } });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it('does not overwrite an expert that appeared while the owner was deciding', async () => {
    const d = deps({
      confirm: vi.fn(async () => {
        fs.mkdirSync(path.join(root, 'uk-cold-email'));
        fs.writeFileSync(path.join(root, 'uk-cold-email', 'expert.md'), 'hand made');
        return { approved: true } as const;
      }),
    });
    const res = await call(d);
    expect(res).toMatchObject({ isError: true, body: { status: 'not_written', reason: 'exists' } });
    expect(fs.readFileSync(path.join(root, 'uk-cold-email', 'expert.md'), 'utf8')).toBe('hand made');
  });
});

describe('cindy_experts save_expert_memory (ROADMAP 3.4b)', () => {
  const memDir = () => path.join(root, 'mem');
  const memDeps = (over: Partial<ExpertsMcpDeps> = {}) =>
    deps({ memoryTarget: (id) => (id === 's1' ? { dir: memDir(), memory: true } : null), ...over });
  const save = (d: ExpertsMcpDeps, note: unknown) => call(d, { note }, SAVE_EXPERT_MEMORY_TOOL);

  beforeEach(() => {
    fs.mkdirSync(memDir());
  });

  it('appends one dated note to memory.md of the session\'s expert, keeping what is there', async () => {
    fs.writeFileSync(path.join(memDir(), 'memory.md'), '# hand notes\n');
    const res = await save(memDeps(), 'Owner prefers tabs.');
    expect(res).toMatchObject({ isError: false, body: { status: 'saved', file: path.join(memDir(), 'memory.md') } });
    const text = fs.readFileSync(path.join(memDir(), 'memory.md'), 'utf8');
    expect(text.startsWith('# hand notes\n')).toBe(true);
    expect(text).toMatch(/\n## \d{4}-\d{2}-\d{2}T[^\n]+\n\nOwner prefers tabs\.\n$/);
  });

  it('refuses a session whose expert has no memory, and non-Hermes callers, writing nothing', async () => {
    const other = await save(memDeps({ getSessionContext: () => ({ agentKind: 'hermes', sessionId: 's2' }) }), 'x');
    expect(other).toMatchObject({ isError: true, body: { status: 'refused', errorCode: 'NO_EXPERT_MEMORY' } });
    const pi = await save(memDeps({ getSessionContext: () => ({ agentKind: 'pi', sessionId: 's1' }) }), 'x');
    expect(pi).toMatchObject({ isError: true, body: { errorCode: 'NO_SESSION_CONTEXT' } });
    expect(fs.existsSync(path.join(memDir(), 'memory.md'))).toBe(false);
  });

  it('sends empty and oversized notes back to the model', async () => {
    const empty = await save(memDeps(), '   ');
    expect(empty).toMatchObject({ isError: true, body: { status: 'invalid', reason: 'empty' } });
    const long = await save(memDeps(), 'y'.repeat(5000));
    expect(long).toMatchObject({ isError: true, body: { status: 'invalid', reason: 'too-long' } });
    expect(fs.existsSync(path.join(memDir(), 'memory.md'))).toBe(false);
  });

  it('keeps draft_expert closed to a memory-only expert', async () => {
    const d = memDeps({ sessionMayDraft: () => false });
    const res = await call(d);
    expect(res).toMatchObject({ isError: true, body: { errorCode: 'NOT_EXPERT_CREATOR' } });
  });
});
