import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VaultSemanticIndex } from '@cindy/maker-core/vault-semantic';

import {
  APPEND_NOTE_TOOL,
  createVaultNotesMcpServer,
  EXPLORE_VAULT_GRAPH_TOOL,
  LIST_NOTES_TOOL,
  LIST_PINNED_NOTES_TOOL,
  PARSE_LOCAL_DOCUMENT_TOOL,
  PIN_VAULT_NOTE_TOOL,
  QUERY_ADRS_TOOL,
  QUICK_CAPTURE_TOOL,
  READ_NOTE_TOOL,
  RECORD_ADR_TOOL,
  SAVE_RESEARCH_SYNTHESIS_TOOL,
  SEARCH_NOTES_TOOL,
  SYNTHESIZE_VAULT_MEMORY_TOOL,
  SYNC_WORKSPACE_GIT_TOOL,
  UNPIN_VAULT_NOTE_TOOL,
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
    pinnedNotesConfigFile: path.join(base, 'pinned-notes.json'),
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

describe('cindy_vault_notes ADR tools (ROADMAP 11.8)', () => {
  const ADR = {
    title: 'Use SQLite for the local session store',
    context: 'Sessions need a durable local store.',
    decision: 'Use SQLite through better-sqlite3.',
  };

  function repoDir(): string {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    return repo;
  }

  it('record_adr writes the vault copy and the repo copy of the session workspace', async () => {
    const repo = repoDir();
    const res = await call(deps({ getSessionWorkspaceDir: () => repo }), RECORD_ADR_TOOL, ADR);
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({
      recorded: true,
      title: ADR.title,
      repoPath: 'docs/decisions/0001-use-sqlite-for-the-local-session-store.md',
    });
    expect(fs.existsSync(path.join(vault, res.body.vaultPath as string))).toBe(true);
    expect(fs.readFileSync(path.join(repo, res.body.repoPath as string), 'utf8')).toContain(
      '# ADR 0001 — Use SQLite for the local session store',
    );
  });

  it('record_adr without a recorded workspace writes the vault copy only and says so', async () => {
    const res = await call(deps(), RECORD_ADR_TOOL, ADR);
    expect(res.isError).toBe(false);
    expect(res.body.repoPath).toBeUndefined();
    expect(res.body.repoSkipped).toBe('no workspace is recorded for this session');
  });

  it('record_adr refuses an invalid ADR, a duplicate, a missing vault and a forbidden session', async () => {
    const invalid = await call(deps(), RECORD_ADR_TOOL, { ...ADR, decision: '   ' });
    expect(invalid).toMatchObject({ isError: true, body: { errorCode: 'INVALID' } });

    await call(deps(), RECORD_ADR_TOOL, ADR);
    const dup = await call(deps(), RECORD_ADR_TOOL, ADR);
    expect(dup).toMatchObject({ isError: true, body: { errorCode: 'EXISTS' } });

    const noVault = await call(deps({ getVaultDir: () => '' }), RECORD_ADR_TOOL, ADR);
    expect(noVault).toMatchObject({ isError: true, body: { errorCode: 'NO_VAULT' } });

    const forbidden = await call(
      deps({ sessionMayUse: (_s, tool) => tool !== RECORD_ADR_TOOL }),
      RECORD_ADR_TOOL,
      {
        ...ADR,
        title: 'Another decision',
      },
    );
    expect(forbidden).toMatchObject({ isError: true, body: { errorCode: 'FORBIDDEN' } });
    expect(fs.readdirSync(path.join(vault, 'Cindy', 'Decisions'))).toHaveLength(1);
  });

  it('query_adrs finds a recorded ADR by keyword and is permission-checked', async () => {
    const repo = repoDir();
    const d = deps({ getSessionWorkspaceDir: () => repo });
    await call(d, RECORD_ADR_TOOL, ADR);

    const hit = await call(d, QUERY_ADRS_TOOL, { query: 'session store database' });
    expect(hit.isError).toBe(false);
    expect(hit.body.count).toBe(1);
    expect((hit.body.adrs as Array<{ title: string; decision: string }>)[0]).toMatchObject({
      title: ADR.title,
      decision: 'Use SQLite through better-sqlite3.',
    });

    const miss = await call(d, QUERY_ADRS_TOOL, { query: 'kubernetes' });
    expect(miss.body.count).toBe(0);

    const forbidden = await call(deps({ sessionMayUse: () => false }), QUERY_ADRS_TOOL, {
      query: 'store',
    });
    expect(forbidden).toMatchObject({ isError: true, body: { errorCode: 'FORBIDDEN' } });
  });
});

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

  it('searches notes with hybrid semantic relevance (ROADMAP 7.3)', async () => {
    const memDb = new Database(':memory:');
    const semanticIndex = new VaultSemanticIndex(memDb);
    semanticIndex.init();
    await semanticIndex.syncVault(vault);

    const res = await call(
      deps({ getSemanticIndex: () => semanticIndex }),
      SEARCH_NOTES_TOOL,
      { query: 'keyword alpha' },
    );
    expect(res.isError).toBe(false);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const hits = res.body.hits as Array<{ path: string; matchType?: string }>;
    expect(hits[0]!.path).toBe('note1.md');
    expect(hits[0]!.matchType).toBe('hybrid');
    memDb.close();
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

  it('explores vault graph with tags and backlinks', async () => {
    fs.writeFileSync(
      path.join(vault, 'note1.md'),
      `---
title: "First Note"
tags: [alpha, docs]
---
# First Note
Links to [[sub/note2]]
`,
    );

    const summaryRes = await call(deps(), EXPLORE_VAULT_GRAPH_TOOL);
    expect(summaryRes.isError).toBe(false);
    expect(summaryRes.body.totalNotes).toBe(2);

    const tagRes = await call(deps(), EXPLORE_VAULT_GRAPH_TOOL, { tag: 'alpha' });
    expect(tagRes.isError).toBe(false);
    expect(tagRes.body.tag).toBe('alpha');
    expect(tagRes.body.count).toBe(1);

    const noteRes = await call(deps(), EXPLORE_VAULT_GRAPH_TOOL, { notePath: 'sub/note2.md' });
    expect(noteRes.isError).toBe(false);
    expect(noteRes.body.found).toBe(true);
    expect(noteRes.body.backlinks).toContain('note1.md');
  });

  it('performs quick capture to Inbox.md and custom file', async () => {
    const res = await call(deps(), QUICK_CAPTURE_TOOL, {
      content: 'Quick capture snippet with #idea',
      tags: ['quick', 'idea'],
      title: 'Idea 1',
    });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ ok: true, relPath: 'Inbox.md' });

    const inbox = fs.readFileSync(path.join(vault, 'Inbox.md'), 'utf8');
    expect(inbox).toContain('Quick capture snippet with #idea');
    expect(inbox).toContain('#quick');
    expect(inbox).toContain('Idea 1');

    const customRes = await call(deps(), QUICK_CAPTURE_TOOL, {
      content: 'Captured to specific note',
      targetFile: 'sub/custom-inbox.md',
    });
    expect(customRes.isError).toBe(false);
    expect(customRes.body).toMatchObject({ ok: true, relPath: 'sub/custom-inbox.md' });
    expect(fs.readFileSync(path.join(vault, 'sub', 'custom-inbox.md'), 'utf8')).toContain('Captured to specific note');
  });

  it('pins, lists, and unpins vault notes for the session context', async () => {
    // Initially empty
    const listInitial = await call(deps(), LIST_PINNED_NOTES_TOOL);
    expect(listInitial.isError).toBe(false);
    expect(listInitial.body.pinnedNotes).toEqual([]);

    // Pin note1.md
    const pinRes = await call(deps(), PIN_VAULT_NOTE_TOOL, { path: 'note1.md' });
    expect(pinRes.isError).toBe(false);
    expect(pinRes.body).toMatchObject({ pinned: true, notePath: 'note1.md' });

    // List pinned
    const listRes = await call(deps(), LIST_PINNED_NOTES_TOOL);
    expect(listRes.isError).toBe(false);
    expect(listRes.body.pinnedNotes).toEqual(['note1.md']);

    // Unpin note1.md
    const unpinRes = await call(deps(), UNPIN_VAULT_NOTE_TOOL, { path: 'note1.md' });
    expect(unpinRes.isError).toBe(false);
    expect(unpinRes.body).toMatchObject({ unpinned: true, notePath: 'note1.md' });

    // Verify empty
    const listAfter = await call(deps(), LIST_PINNED_NOTES_TOOL);
    expect(listAfter.body.pinnedNotes).toEqual([]);
  });

  it('syncs workspace git progress to project note (ROADMAP 7.4)', async () => {
    // 1. Refuses when session is forbidden
    const forbidden = await call(
      deps({ sessionMayUse: (_id, tool) => tool !== SYNC_WORKSPACE_GIT_TOOL }),
      SYNC_WORKSPACE_GIT_TOOL,
    );
    expect(forbidden.isError).toBe(true);
    expect(forbidden.body.errorCode).toBe('FORBIDDEN');

    // 2. Refuses when no vault configured
    const noVault = await call(deps({ getVaultDir: () => null }), SYNC_WORKSPACE_GIT_TOOL);
    expect(noVault.isError).toBe(true);
    expect(noVault.body.errorCode).toBe('NO_VAULT');

    // 3. Executes successfully via syncWorkspaceGit callback
    const syncWorkspaceGitMock = async (opts: {
      workspaceDir?: string;
      targetNotePath?: string;
      summaryNote?: string;
    }) => ({
      ok: true,
      path: opts.targetNotePath || 'memory/Project — Cindy.md',
      created: false,
      block: '### Progress (2026-11-10)\n\n- Commits: test',
    });

    const success = await call(
      deps({ syncWorkspaceGit: syncWorkspaceGitMock }),
      SYNC_WORKSPACE_GIT_TOOL,
      { summary: 'Milestone verified' },
    );
    expect(success.isError).toBe(false);
    expect(success.body.synced).toBe(true);
    expect(success.body.path).toBe('memory/Project — Cindy.md');
    expect(success.body.block).toContain('### Progress');
  });

  it('parses local documents (ROADMAP 9.5)', async () => {
    const docPath = path.join(base, 'data.csv');
    fs.writeFileSync(docPath, 'model,params,latency\nhermes,7b,45ms\nllama,8b,50ms\n');

    const res = await call(deps(), PARSE_LOCAL_DOCUMENT_TOOL, { path: docPath });
    expect(res.isError).toBe(false);
    expect(res.body.success).toBe(true);
    const doc = res.body.document as { documentType: string; tables?: Array<{ rowCount: number; markdown: string }> };
    expect(doc.documentType).toBe('spreadsheet');
    expect(doc.tables?.[0].rowCount).toBe(2);
    expect(doc.tables?.[0].markdown).toContain('| hermes | 7b | 45ms |');
  });

  it('saves deep research synthesis literature note to vault (ROADMAP 9.5)', async () => {
    const res = await call(deps(), SAVE_RESEARCH_SYNTHESIS_TOOL, {
      title: 'Local LLM Inference Engine Benchmarks',
      summary: 'Comparison of quantized execution backends.',
      findings: [
        {
          statement: 'vLLM provides highest batch throughput',
          sourceIds: ['s1'],
          confidence: 'high',
        },
      ],
      sources: [
        {
          id: 's1',
          title: 'High-Throughput Serving of LLMs with PagedAttention',
          url: 'https://arxiv.org/abs/2309.06180',
          sourceType: 'academic',
        },
      ],
      tags: ['inference', 'llm'],
    });

    expect(res.isError).toBe(false);
    expect(res.body.saved).toBe(true);
    expect(res.body.relPath).toBe('Cindy/Research/Local-LLM-Inference-Engine-Benchmarks.md');
    expect(res.body.citationCount).toBe(1);

    const savedFile = path.join(vault, 'Cindy/Research/Local-LLM-Inference-Engine-Benchmarks.md');
    expect(fs.existsSync(savedFile)).toBe(true);
    const noteText = fs.readFileSync(savedFile, 'utf8');
    expect(noteText).toContain('title: "Local LLM Inference Engine Benchmarks"');
    expect(noteText).toContain('## References & Citations');
    expect(noteText).toContain('PagedAttention');
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

    // Live hybrid semantic search verification (ROADMAP 7.3)
    const memDb = new Database(':memory:');
    const semanticIndex = new VaultSemanticIndex(memDb);
    semanticIndex.init();
    const syncResult = await semanticIndex.syncVault(realVault);
    expect(syncResult.indexed).toBeGreaterThan(0);

    // Conceptual query without exact title keyword match
    const semSearchRes = await call(
      deps({ getVaultDir: () => realVault, getSemanticIndex: () => semanticIndex }),
      SEARCH_NOTES_TOOL,
      { query: 'autonomous agents orchestration and task planning' },
    );
    expect(semSearchRes.isError).toBe(false);
    expect(semSearchRes.body.count).toBeGreaterThan(0);
    const semHits = semSearchRes.body.hits as Array<{ path: string; matchType?: string; similarity?: number }>;
    expect(semHits.some((h) => h.matchType === 'semantic' || h.matchType === 'hybrid')).toBe(true);
    memDb.close();
  });
});

