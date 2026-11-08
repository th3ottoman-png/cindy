import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APPEND_NOTE_TOOL,
  createVaultNotesMcpServer,
  LIST_NOTES_TOOL,
  READ_NOTE_TOOL,
  SEARCH_NOTES_TOOL,
  SYNTHESIZE_VAULT_MEMORY_TOOL,
  type VaultNotesMcpDeps,
} from '../vaultNotesMcpServer';

let base: string;
let vault: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-notes-mcp-')));
  vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'note1.md'), 'Content of note one with keyword alpha\n');
  fs.writeFileSync(path.join(vault, 'sub', 'note2.md'), 'Content of note two with keyword beta\n');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function deps(over: Partial<VaultNotesMcpDeps> = {}): VaultNotesMcpDeps {
  return {
    getSessionContext: () => ({ agentKind: 'hermes', sessionId: 's1' }),
    getVaultDir: () => vault,
    sessionMayUse: () => true,
    ...over,
  };
}

async function call(d: VaultNotesMcpDeps, tool: string, input: Record<string, unknown> = {}) {
  const server = createVaultNotesMcpServer(d);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vault-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    const result = await client.callTool({ name: tool, arguments: input });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

describe('cindy_vault_notes MCP server (ROADMAP 5.1)', () => {
  it('reads notes inside the vault', async () => {
    const res = await call(deps(), READ_NOTE_TOOL, { path: 'note1.md' });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ ok: true, path: 'note1.md', truncated: false });
    expect(res.body.text).toContain('keyword alpha');
  });

  it('searches notes across the vault', async () => {
    const res = await call(deps(), SEARCH_NOTES_TOOL, { query: 'keyword' });
    expect(res.isError).toBe(false);
    expect(res.body.count).toBe(2);
    const hits = res.body.hits as Array<{ path: string }>;
    expect(hits.map((h) => h.path)).toEqual(expect.arrayContaining(['note1.md', 'sub/note2.md']));
  });

  it('appends notes inside the vault', async () => {
    const res = await call(deps(), APPEND_NOTE_TOOL, { path: 'daily.md', text: 'Daily reflection entry' });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ ok: true, path: 'daily.md', created: true });

    const content = fs.readFileSync(path.join(vault, 'daily.md'), 'utf8');
    expect(content).toContain('Daily reflection entry');
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T/);
  });

  it('lists notes inside the vault', async () => {
    const res = await call(deps(), LIST_NOTES_TOOL);
    expect(res.isError).toBe(false);
    expect(res.body.count).toBe(2);
    const notes = res.body.notes as Array<{ path: string }>;
    expect(notes.map((n) => n.path)).toEqual(expect.arrayContaining(['note1.md', 'sub/note2.md']));
  });

  it('synthesizes memory notes inside the vault', async () => {
    const memoryDir = path.join(vault, 'Cindy', 'Memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, '2026-11-08-test-summary.md'),
      `---
session_id: "s1"
title: "MCP Test"
---
## Overview
Tested MCP synthesis.
## Decisions & Rationale
- Decision MCP
`,
    );

    const res = await call(deps(), SYNTHESIZE_VAULT_MEMORY_TOOL, { limit: 5 });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ ok: true, relPath: 'Cindy/Memory/Synthesis.md', sourcesCount: 1 });
    expect(fs.existsSync(path.join(vault, 'Cindy', 'Memory', 'Synthesis.md'))).toBe(true);
  });

  it('refuses when no session context is available', async () => {
    const d = deps({ getSessionContext: () => undefined });
    const res = await call(d, READ_NOTE_TOOL, { path: 'note1.md' });
    expect(res.isError).toBe(true);
    expect(res.body).toMatchObject({ status: 'refused', errorCode: 'NO_SESSION' });
  });

  it('refuses when expert does not permit the tool', async () => {
    const d = deps({ sessionMayUse: () => false });
    const res = await call(d, APPEND_NOTE_TOOL, { path: 'note1.md', text: 'new text' });
    expect(res.isError).toBe(true);
    expect(res.body).toMatchObject({ status: 'refused', errorCode: 'FORBIDDEN' });
  });

  it('refuses when no vault is configured', async () => {
    const d = deps({ getVaultDir: () => null });
    const res = await call(d, READ_NOTE_TOOL, { path: 'note1.md' });
    expect(res.isError).toBe(true);
    expect(res.body).toMatchObject({ status: 'refused', errorCode: 'NO_VAULT' });
  });

  it('refuses path traversal outside the vault', async () => {
    const res = await call(deps(), READ_NOTE_TOOL, { path: '../outside.md' });
    expect(res.isError).toBe(true);
    expect(res.body.errorCode).toBe('OUTSIDE-VAULT');
  });

  it('live-exercises read, search, and append against real vault when present', async () => {
    const realVault = '/Users/turko/Bishi-memory';
    if (!fs.existsSync(realVault)) return;

    const d = deps({ getVaultDir: () => realVault });
    const listRes = await call(d, LIST_NOTES_TOOL, { limit: 5 });
    expect(listRes.isError).toBe(false);
    expect(listRes.body.count).toBeGreaterThan(0);

    const readRes = await call(d, READ_NOTE_TOOL, { path: 'AGENTS_workline.md' });
    expect(readRes.isError).toBe(false);
    expect(readRes.body.text).toContain('Ingiltere');

    const testRelPath = 'cindy-test.md';
    const stamp = `Live verification 5.1b at ${new Date().toISOString()}`;
    const appendRes = await call(d, APPEND_NOTE_TOOL, { path: testRelPath, text: stamp });
    expect(appendRes.isError).toBe(false);

    const readBack = await call(d, READ_NOTE_TOOL, { path: testRelPath });
    expect(readBack.isError).toBe(false);
    expect(readBack.body.text).toContain(stamp);

    // Clean up test note
    fs.rmSync(path.join(realVault, testRelPath), { force: true });
  });
});

