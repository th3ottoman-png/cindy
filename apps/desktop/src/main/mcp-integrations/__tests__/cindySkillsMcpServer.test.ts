import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVATE_SKILL_TOOL,
  ACTIVATE_SKILL_TOOL_SCHEMA,
  CINDY_SKILLS_MCP_SERVER_NAME,
  LIST_SKILLS_TOOL,
  SkillCatalogCache,
  createCindySkillsMcpServer,
  type CindySkillsMcpDeps,
} from '../cindySkillsMcpServer';

let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skills-mcp-')));
  root = path.join(base, 'skills');
  fs.mkdirSync(root);
  const dir = path.join(root, 'development', 'git-worktree');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: git-worktree\ndescription: Isolate feature branches in worktrees.\n---\n# Steps\n1. Add a worktree.\n');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'add.sh'), '#!/bin/sh\necho secret-not-in-context\n');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function deps(over: Partial<CindySkillsMcpDeps> = {}): CindySkillsMcpDeps {
  return {
    getSkillRoots: () => [root],
    getSessionContext: () => ({ agentKind: 'hermes', sessionId: 's1' }),
    nowMs: () => 1_000,
    ...over,
  };
}

async function call(d: CindySkillsMcpDeps, tool: string, input: Record<string, unknown> = {}) {
  const server = createCindySkillsMcpServer(d);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cindy-skills-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    const result = await client.callTool({ name: tool, arguments: input });
    return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0].text };
  } finally {
    await client.close();
  }
}

describe('cindy_skills MCP server (ROADMAP 11.1 Tier 2A)', () => {
  it('advertises exactly the two progressive-skill tools', async () => {
    const server = createCindySkillsMcpServer(deps());
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tools-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([ACTIVATE_SKILL_TOOL, LIST_SKILLS_TOOL].sort());
      const activate = tools.find((t) => t.name === ACTIVATE_SKILL_TOOL);
      expect(activate?.description).toBe(ACTIVATE_SKILL_TOOL_SCHEMA.description);
    } finally {
      await client.close();
    }
  });

  it('loads only the requested skill body, with paths but never script contents', async () => {
    const res = await call(deps(), ACTIVATE_SKILL_TOOL, { skill_slug: 'git-worktree' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('# Skill Activated: git-worktree (git-worktree)');
    expect(res.text).toContain('# Steps');
    expect(res.text).not.toContain('description: Isolate');
    expect(res.text).toContain('scripts/add.sh');
    expect(res.text).not.toContain('secret-not-in-context');
  });

  it('fails closed on an unknown slug and lists the available skills', async () => {
    const res = await call(deps(), ACTIVATE_SKILL_TOOL, { skill_slug: 'worktr' });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.text) as { errorCode: string; message: string; suggestions: string[] };
    expect(body.errorCode).toBe('UNKNOWN_SKILL');
    expect(body.message).toContain('not installed');
    expect(body.message).toContain('git-worktree');
  });

  it('fails closed without a session context', async () => {
    const res = await call(deps({ getSessionContext: () => undefined }), ACTIVATE_SKILL_TOOL, { skill_slug: 'git-worktree' });
    expect(res.isError).toBe(true);
    expect((JSON.parse(res.text) as { errorCode: string }).errorCode).toBe('NO_SESSION');
  });

  it('returns PERMISSION_DENIED for chat-only sessions on both tools', async () => {
    const d = deps({ isChatOnly: () => true });
    for (const tool of [ACTIVATE_SKILL_TOOL, LIST_SKILLS_TOOL]) {
      const res = await call(d, tool, tool === ACTIVATE_SKILL_TOOL ? { skill_slug: 'git-worktree' } : {});
      expect(res.isError).toBe(true);
      expect((JSON.parse(res.text) as { errorCode: string }).errorCode).toBe('PERMISSION_DENIED');
    }
  });

  it('list_skills returns the bounded manifest, not full bodies', async () => {
    const res = await call(deps(), LIST_SKILLS_TOOL);
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.text) as { totalSkills: number; estimatedDiscoveryTokens: number; manifest: string };
    expect(body.totalSkills).toBe(1);
    expect(body.manifest).toContain('<available_skills>');
    expect(body.manifest).not.toContain('# Steps');
    expect(body.estimatedDiscoveryTokens).toBeLessThan(1000);
  });

  it('the server name is the cindy_skills namespace', () => {
    expect(CINDY_SKILLS_MCP_SERVER_NAME).toBe('cindy_skills');
  });
});

describe('SkillCatalogCache', () => {
  it('reuses the catalog until a skill root changes, then rebuilds', () => {
    const cache = new SkillCatalogCache(deps());
    expect(cache.get()?.totalSkills).toBe(1);
    expect(cache.get()).toBe(cache.get());

    const added = path.join(root, 'development', 'new-skill');
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, 'SKILL.md'), '---\nname: new-skill\ndescription: freshly added\n---\nBody\n');
    fs.utimesSync(path.join(root, 'development'), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    expect(cache.get()?.totalSkills).toBe(2);
  });

  it('handles a missing root without throwing', () => {
    const cache = new SkillCatalogCache(deps({ getSkillRoots: () => [path.join(base, 'absent')] }));
    expect(cache.get()?.totalSkills).toBe(0);
  });
});
