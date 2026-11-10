import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createVaultNotesMcpServer,
  PARSE_LOCAL_DOCUMENT_TOOL,
  READ_NOTE_TOOL,
  SAVE_RESEARCH_SYNTHESIS_TOOL,
  SEARCH_NOTES_TOOL,
  type VaultNotesMcpDeps,
} from '../vaultNotesMcpServer';

describe('Deep Research & Local Document Ingestion Live Proof (ROADMAP 9.5)', () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-live-')));
    vaultDir = path.join(tmpDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(over: Partial<VaultNotesMcpDeps> = {}): VaultNotesMcpDeps {
    return {
      getSessionContext: () => ({ agentKind: 'hermes', sessionId: 'live-research-s1' }),
      getVaultDir: () => vaultDir,
      sessionMayUse: () => true,
      ...over,
    };
  }

  async function callMcpTool(d: VaultNotesMcpDeps, tool: string, args: Record<string, unknown> = {}) {
    const server = createVaultNotesMcpServer(d);
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'deep-research-verifier', version: '1.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const result = await client.callTool({ name: tool, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0].text;
      return { isError: result.isError === true, data: JSON.parse(text) as Record<string, unknown> };
    } finally {
      await client.close();
    }
  }

  it('live-exercises local document parsing, multi-hop synthesis, vault literature note persistence, and search discoverability', async () => {
    // 1. Stage a local document (e.g. simulated internal whitepaper)
    const localDocPath = path.join(tmpDir, 'agent-architecture-spec.md');
    fs.writeFileSync(
      localDocPath,
      `---
title: Agentic Coordination Protocol
author: Cindy Core Team
tags: [architecture, protocols]
---

# Agentic Coordination Protocol

## Abstract
Autonomous multi-agent architectures require strict isolation between planning and execution.

## Architectural Boundaries
1. Subagent execution loops must remain sandboxed with zero direct file mutation outside assigned workspaces.
2. Context compaction handoffs must summarize prior trajectories without losing decision trees.

## Evaluation
Measured 99.4% tool-call accuracy with local open-weight models using input sanitization filters.
`,
      'utf8',
    );

    // 2. Parse the document using PARSE_LOCAL_DOCUMENT_TOOL via MCP
    const parseRes = await callMcpTool(makeDeps(), PARSE_LOCAL_DOCUMENT_TOOL, {
      path: localDocPath,
      includeChunks: true,
    });

    expect(parseRes.isError).toBe(false);
    expect(parseRes.data.success).toBe(true);
    const doc = parseRes.data.document as {
      documentType: string;
      metadata: { title?: string; wordCount: number; classification: string };
      sections: Array<{ title: string; content: string }>;
      chunks: Array<{ text: string }>;
    };

    expect(doc.documentType).toBe('markdown');
    expect(doc.metadata.title).toBe('Agentic Coordination Protocol');
    expect(doc.metadata.classification).toBe('technical_spec');
    expect(doc.sections.length).toBeGreaterThanOrEqual(3);
    expect(doc.chunks.length).toBeGreaterThan(0);

    // 3. Assemble and save Deep Research Synthesis via SAVE_RESEARCH_SYNTHESIS_TOOL
    const synthesisTitle = 'Autonomous Multi-Agent Architectural Patterns 2026';
    const saveRes = await callMcpTool(makeDeps(), SAVE_RESEARCH_SYNTHESIS_TOOL, {
      title: synthesisTitle,
      topic: 'Autonomous Multi-Agent Systems',
      summary:
        'Synthesis comparing centralized orchestrator models against localized peer-to-peer delegation in modern agent frameworks.',
      findings: [
        {
          statement: 'Hierarchical planner-worker architectures reduce token consumption by 42% over flat chat loops',
          detail: 'Measured across 200 software engineering task workflows.',
          sourceIds: ['arxiv-1'],
          confidence: 'high',
        },
        {
          statement: 'Local document extraction and structured literature notes accelerate context retention across compaction barriers',
          detail: 'Validated via local Markdown and PDF ingestion pipelines.',
          sourceIds: ['local-spec'],
          confidence: 'high',
        },
      ],
      sources: [
        {
          id: 'arxiv-1',
          title: 'Hierarchical Autonomous Agent Coordination at Scale',
          url: 'https://arxiv.org/abs/2502.12345',
          sourceType: 'academic',
          author: 'Vaswani et al.',
          publishedDate: '2025',
          keyTakeaway: 'Strict separation of planning and tool dispatch prevents cognitive drift.',
        },
        {
          id: 'local-spec',
          title: 'Agentic Coordination Protocol',
          filePath: localDocPath,
          sourceType: 'local_document',
          keyTakeaway: 'Subagent execution must remain sandboxed with zero direct file mutation outside assigned workspaces.',
        },
      ],
      localDocumentAnalysis: {
        documentTitle: 'Agentic Coordination Protocol',
        documentPath: localDocPath,
        highlights: [
          'Strict sandboxed subagent loops',
          'Context compaction handoffs preserve decision trees',
          '99.4% tool-call accuracy with input sanitization',
        ],
      },
      tags: ['multi-agent', 'orchestration', 'deep-research'],
    });

    expect(saveRes.isError).toBe(false);
    expect(saveRes.data.saved).toBe(true);
    expect(saveRes.data.citationCount).toBe(2);
    expect(saveRes.data.sourceCount).toBe(2);

    const relPath = saveRes.data.relPath as string;
    expect(relPath).toBe('Cindy/Research/Autonomous-Multi-Agent-Architectural-Patterns-2026.md');

    // 4. Verify disk persistence in the vault
    const fullPath = path.join(vaultDir, relPath);
    expect(fs.existsSync(fullPath)).toBe(true);
    const content = fs.readFileSync(fullPath, 'utf8');

    // Verify markdown structure
    expect(content).toContain('type: literature-note');
    expect(content).toContain('Hierarchical Autonomous Agent Coordination at Scale');
    expect(content).toContain('## Executive Summary');
    expect(content).toContain('Hierarchical planner-worker architectures reduce token consumption by 42% over flat chat loops**[^1]');
    expect(content).toContain('Local document extraction and structured literature notes accelerate context retention across compaction barriers**[^2]');
    expect(content).toContain('## Local Document Ingestion: Agentic Coordination Protocol');
    expect(content).toContain('Strict sandboxed subagent loops');
    expect(content).toContain('## References & Citations');
    expect(content).toContain('[^1]: **[ACADEMIC]** [Hierarchical Autonomous Agent Coordination at Scale](https://arxiv.org/abs/2502.12345)');
    expect(content).toContain('[^2]: **[LOCAL_DOCUMENT]**');

    // 5. Read note back using READ_NOTE_TOOL
    const readRes = await callMcpTool(makeDeps(), READ_NOTE_TOOL, { path: relPath });
    expect(readRes.isError).toBe(false);
    expect((readRes.data as { text: string }).text).toBe(content);

    // 6. Search for the synthesized concept using SEARCH_NOTES_TOOL
    const searchRes = await callMcpTool(makeDeps(), SEARCH_NOTES_TOOL, { query: 'hierarchical planner-worker' });
    expect(searchRes.isError).toBe(false);
    expect(searchRes.data.count).toBe(1);
    const hit = (searchRes.data.hits as Array<{ path: string }>)[0];
    expect(hit.path).toBe(relPath);
  });
});
