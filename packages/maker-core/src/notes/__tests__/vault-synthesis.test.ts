import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectSessionSummaries,
  parseSummaryNote,
  runVaultSynthesis,
  synthesizeVaultNotes,
  writeVaultSynthesis,
} from '../vault-synthesis.js';

describe('vault-synthesis (ROADMAP 6.3)', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-test-synthesis-vault-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  describe('parseSummaryNote', () => {
    it('parses frontmatter and all structured sections', () => {
      const text = `---
session_id: "test-sess-123"
title: "Build Feature X"
exported_at: "2026-11-08T10:00:00Z"
turns_summarized: 4
---

## Overview
Built feature X and integrated with existing subsystems.

## Decisions & Rationale
- Used recursive fs.watch for low latency
- Filtered dot files to prevent feedback loops

## Facts Learned
- Node 22 fs.watch supports recursive on macOS
- Session ID prefix is always 8 characters

## Open Questions
- Should debounce timing be configurable per vault?

## Next Steps
- Add UI trigger in Settings -> Notes Vault
`;

      const parsed = parseSummaryNote(text);
      expect(parsed.frontmatter.session_id).toBe('test-sess-123');
      expect(parsed.frontmatter.title).toBe('Build Feature X');
      expect(parsed.frontmatter.exported_at).toBe('2026-11-08T10:00:00Z');
      expect(parsed.overview).toBe('Built feature X and integrated with existing subsystems.');
      expect(parsed.decisions).toEqual([
        'Used recursive fs.watch for low latency',
        'Filtered dot files to prevent feedback loops',
      ]);
      expect(parsed.facts).toEqual([
        'Node 22 fs.watch supports recursive on macOS',
        'Session ID prefix is always 8 characters',
      ]);
      expect(parsed.openQuestions).toEqual([
        'Should debounce timing be configurable per vault?',
      ]);
      expect(parsed.nextSteps).toEqual([
        'Add UI trigger in Settings -> Notes Vault',
      ]);
    });

    it('handles note without frontmatter or missing sections', () => {
      const text = `## Overview
Quick test note.

## Facts Learned
* Fact one
* Fact two
`;
      const parsed = parseSummaryNote(text);
      expect(parsed.frontmatter).toEqual({});
      expect(parsed.overview).toBe('Quick test note.');
      expect(parsed.decisions).toEqual([]);
      expect(parsed.facts).toEqual(['Fact one', 'Fact two']);
      expect(parsed.openQuestions).toEqual([]);
      expect(parsed.nextSteps).toEqual([]);
    });
  });

  describe('collectSessionSummaries', () => {
    it('reads and parses summaries from vault folder and ignores other files', () => {
      const memoryDir = path.join(tmpVault, 'Cindy', 'Memory');
      fs.mkdirSync(memoryDir, { recursive: true });

      // Note 1
      fs.writeFileSync(
        path.join(memoryDir, '2026-11-01-first-sess1-summary.md'),
        `---
session_id: "sess-1"
title: "First Task"
---
## Overview
First overview.

## Decisions & Rationale
- Decision 1
`,
      );

      // Note 2
      fs.writeFileSync(
        path.join(memoryDir, '2026-11-02-second-sess2-summary.md'),
        `---
session_id: "sess-2"
title: "Second Task"
---
## Overview
Second overview.

## Facts Learned
- Fact A
`,
      );

      // Non-summary file
      fs.writeFileSync(path.join(memoryDir, 'regular-note.md'), '# Regular note');

      // Synthesis.md should be ignored as input
      fs.writeFileSync(path.join(memoryDir, 'Synthesis.md'), '# Old Synthesis');

      const collected = collectSessionSummaries(tmpVault, { folder: 'Cindy/Memory' });
      expect(collected.length).toBe(2);
      expect(collected.map((c) => c.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
      expect(collected.some((c) => c.fileName === 'regular-note.md')).toBe(false);
      expect(collected.some((c) => c.fileName === 'Synthesis.md')).toBe(false);
    });

    it('returns empty array when memory folder does not exist or escapes vault', () => {
      expect(collectSessionSummaries(tmpVault, { folder: 'NonExistent' })).toEqual([]);
      expect(collectSessionSummaries(tmpVault, { folder: '../../escape' })).toEqual([]);
    });
  });

  describe('synthesizeVaultNotes', () => {
    it('compiles structured synthesis document with frontmatter and sections', () => {
      const summaries = [
        {
          fileName: '2026-11-02-task2-summary.md',
          relPath: 'Cindy/Memory/2026-11-02-task2-summary.md',
          fullPath: '/path/to/task2.md',
          mtimeMs: 2000,
          sessionId: 'sess-2',
          title: 'Task Two',
          exportedAt: '2026-11-02T12:00:00Z',
          turnsSummarized: 3,
          overview: 'Implemented backend services.',
          decisions: ['Adopted SQLite WAL mode'],
          facts: ['Node 22 is required'],
          openQuestions: ['Need benchmark under load'],
          nextSteps: ['Run stress tests'],
        },
        {
          fileName: '2026-11-01-task1-summary.md',
          relPath: 'Cindy/Memory/2026-11-01-task1-summary.md',
          fullPath: '/path/to/task1.md',
          mtimeMs: 1000,
          sessionId: 'sess-1',
          title: 'Task One',
          exportedAt: '2026-11-01T12:00:00Z',
          turnsSummarized: 2,
          overview: 'Set up repository structure.',
          decisions: ['Decided to use pnpm workspaces'],
          facts: ['Node 22 is required'], // Duplicate fact
          openQuestions: [],
          nextSteps: ['Build feature 1'],
        },
      ];

      const markdown = synthesizeVaultNotes(summaries, {
        generatedAt: new Date('2026-11-08T12:00:00Z'),
      });

      expect(markdown).toContain('type: memory-synthesis');
      expect(markdown).toContain('sources_count: 2');
      expect(markdown).toContain('## Executive Summary');
      expect(markdown).toContain('- **Task Two**: Implemented backend services.');
      expect(markdown).toContain('## Key Decisions & Architecture');
      expect(markdown).toContain('Adopted SQLite WAL mode (from [[2026-11-02-task2-summary|Task Two]])');
      expect(markdown).toContain('## Facts Learned & Environment Details');
      // Deduplication check: 'Node 22 is required' should appear only once as bullet
      const factOccurrences = (markdown.match(/- Node 22 is required/g) || []).length;
      expect(factOccurrences).toBe(1);
      expect(markdown).toContain('## Open Questions & Blockers');
      expect(markdown).toContain('Need benchmark under load');
      expect(markdown).toContain('## Session History Index');
      expect(markdown).toContain('| 2026-11-02 | Task Two | [[2026-11-02-task2-summary]] | 3 |');
    });

    it('renders clean placeholder sections when summaries array is empty', () => {
      const markdown = synthesizeVaultNotes([]);
      expect(markdown).toContain('sources_count: 0');
      expect(markdown).toContain('_No conversation summaries found yet to synthesize._');
      expect(markdown).toContain('_No recorded decisions across analyzed sessions._');
    });
  });

  describe('writeVaultSynthesis and runVaultSynthesis', () => {
    it('writes synthesis file atomically and redacts secrets', () => {
      const memoryDir = path.join(tmpVault, 'Cindy', 'Memory');
      fs.mkdirSync(memoryDir, { recursive: true });

      const content = `---
type: memory-synthesis
---
# Cross-Session Memory Synthesis

## Facts
- Secret key: sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890-abcdef12
`;

      const res = writeVaultSynthesis(tmpVault, content, { targetFile: 'Cindy/Memory/Synthesis.md' });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.relPath).toBe('Cindy/Memory/Synthesis.md');
        expect(fs.existsSync(res.fullPath)).toBe(true);

        const readBack = fs.readFileSync(res.fullPath, 'utf8');
        expect(readBack).not.toContain('sk-ant-api03-abcdef');
        expect(readBack).toContain('[redacted]');
      }
    });

    it('refuses path traversal outside the vault', () => {
      const res = writeVaultSynthesis(tmpVault, '# Title', { targetFile: '../../outside.md' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('outside-vault');
      }
    });

    it('runVaultSynthesis executes full collection, generation and atomic write', () => {
      const memoryDir = path.join(tmpVault, 'Cindy', 'Memory');
      fs.mkdirSync(memoryDir, { recursive: true });

      fs.writeFileSync(
        path.join(memoryDir, '2026-11-08-sample-summary.md'),
        `---
session_id: "s1"
title: "Live Sample"
---
## Overview
Live sample overview.

## Decisions & Rationale
- Made decision A

## Facts Learned
- Found fact B
`,
      );

      const res = runVaultSynthesis(tmpVault);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.sourcesCount).toBe(1);
        expect(res.sources).toEqual(['Cindy/Memory/2026-11-08-sample-summary.md']);
        expect(fs.existsSync(res.fullPath)).toBe(true);

        const saved = fs.readFileSync(res.fullPath, 'utf8');
        expect(saved).toContain('type: memory-synthesis');
        expect(saved).toContain('Made decision A');
        expect(saved).toContain('Found fact B');
      }
    });
  });
});
