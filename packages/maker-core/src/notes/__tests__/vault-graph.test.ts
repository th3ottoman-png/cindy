import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  normalizeTag,
  parseNoteLinksAndTags,
  scanVaultGraph,
} from '../vault-graph.js';

describe('vault-graph', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-graph-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeNote(rel: string, content: string) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  it('normalizes tags by stripping leading hashes and lowercasing', () => {
    expect(normalizeTag('#cindy')).toBe('cindy');
    expect(normalizeTag('##AI')).toBe('ai');
    expect(normalizeTag('  #DeepSeek-Flash  ')).toBe('deepseek-flash');
  });

  it('parses frontmatter tags, inline hashtags, wikilinks, and title', () => {
    const content = `---
title: "Architecture Decisions"
tags:
  - cindy
  - design
---

# Architecture Decisions

This note links to [[Memory/Synthesis]] and [[2026-11-08-session|Session 1]].
It also mentions #architecture and #roadmap inline.

\`\`\`markdown
#not-a-tag [[NotALink]]
\`\`\`
`;
    const res = parseNoteLinksAndTags('Notes/arch.md', content);
    expect(res.title).toBe('Architecture Decisions');
    expect(res.tags).toContain('cindy');
    expect(res.tags).toContain('design');
    expect(res.tags).toContain('architecture');
    expect(res.tags).toContain('roadmap');
    expect(res.tags).not.toContain('not-a-tag');
    expect(res.outgoingLinks).toEqual(['Memory/Synthesis', '2026-11-08-session']);
  });

  it('scans vault and constructs nodes, tags index, and bidirectional backlinks', () => {
    writeNote(
      'Cindy/Memory/Synthesis.md',
      `---
title: "Cross-Session Synthesis"
tags: [summary, memory]
---
# Cross-Session Memory Synthesis
Overview of progress.
`,
    );

    writeNote(
      'Cindy/Memory/2026-11-08-orch-summary.md',
      `---
title: "Summary: Orca Lead"
tags: [summary, orca]
---
# Summary: Orca Lead
See [[Synthesis]] for consolidated knowledge.
`,
    );

    writeNote(
      'Cindy/Chats/chat-1.md',
      `---
title: "Chat 1"
tags: [chat]
---
# Chat 1
Discussed in [[2026-11-08-orch-summary|Orca Lead Summary]] and [[Synthesis]].
`,
    );

    const graph = scanVaultGraph(tmpDir);

    expect(graph.totalNotes).toBe(3);

    // Check tags
    expect(graph.tags['summary']).toContain('Cindy/Memory/Synthesis.md');
    expect(graph.tags['summary']).toContain('Cindy/Memory/2026-11-08-orch-summary.md');
    expect(graph.tags['orca']).toEqual(['Cindy/Memory/2026-11-08-orch-summary.md']);
    expect(graph.tags['chat']).toEqual(['Cindy/Chats/chat-1.md']);

    // Check backlinks for Synthesis.md
    // Both 2026-11-08-orch-summary.md and chat-1.md link to Synthesis
    const synthBacklinks = graph.backlinks['Cindy/Memory/Synthesis.md'];
    expect(synthBacklinks).toBeDefined();
    expect(synthBacklinks).toContain('Cindy/Memory/2026-11-08-orch-summary.md');
    expect(synthBacklinks).toContain('Cindy/Chats/chat-1.md');

    // Check backlinks for 2026-11-08-orch-summary.md
    // chat-1.md links to it
    const orchBacklinks = graph.backlinks['Cindy/Memory/2026-11-08-orch-summary.md'];
    expect(orchBacklinks).toEqual(['Cindy/Chats/chat-1.md']);
  });

  it('fails open when vault directory does not exist', () => {
    const graph = scanVaultGraph(path.join(tmpDir, 'does-not-exist'));
    expect(graph.totalNotes).toBe(0);
    expect(graph.nodes).toEqual({});
    expect(graph.tags).toEqual({});
    expect(graph.backlinks).toEqual({});
  });
});
