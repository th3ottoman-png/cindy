import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleLiteratureNote,
  classifySource,
  saveLiteratureNote,
  slugifyTitle,
} from '../deep-research-synthesis.js';

describe('deep-research-synthesis', () => {
  describe('classifySource', () => {
    it('identifies local documents when filePath is present', () => {
      expect(classifySource({ filePath: '/docs/spec.pdf' })).toBe('local_document');
    });

    it('identifies academic sources by domain', () => {
      expect(classifySource({ url: 'https://arxiv.org/abs/2401.00001' })).toBe('academic');
      expect(classifySource({ url: 'https://ieeexplore.ieee.org/document/12345' })).toBe('academic');
      expect(classifySource({ url: 'https://cs.stanford.edu/paper.pdf' })).toBe('academic');
    });

    it('identifies documentation and repositories', () => {
      expect(classifySource({ url: 'https://github.com/th3ottoman-png/cindy' })).toBe('documentation');
      expect(classifySource({ url: 'https://docs.anthropic.com/claude/reference' })).toBe('documentation');
    });

    it('identifies news outlets', () => {
      expect(classifySource({ url: 'https://www.reuters.com/technology/ai-breakthrough' })).toBe('news');
      expect(classifySource({ url: 'https://techcrunch.com/2026/01/01/startup' })).toBe('news');
    });

    it('defaults to reference for generic urls', () => {
      expect(classifySource({ url: 'https://blog.example.com/thoughts' })).toBe('reference');
    });
  });

  describe('slugifyTitle', () => {
    it('creates clean filesystem slugs', () => {
      expect(slugifyTitle('Deep Research: Vector Search & Embeddings?')).toBe('Deep-Research-Vector-Search-&-Embeddings');
      expect(slugifyTitle('   hello   world   ')).toBe('hello-world');
    });
  });

  describe('assembleLiteratureNote', () => {
    it('builds full markdown note with frontmatter, findings, footnotes, and references', () => {
      const { markdown, citationCount } = assembleLiteratureNote(
        {
          title: 'Hybrid Retrieval Systems in 2026',
          topic: 'Information Retrieval',
          summary: 'A synthesis of BM25 and vector search combinations.',
          findings: [
            {
              statement: 'Reciprocal Rank Fusion consistently outperforms score linear combinations',
              detail: 'Evaluated across 15 standard benchmarks.',
              sourceIds: ['s1'],
              confidence: 'high',
            },
            {
              statement: 'Sparse representations are essential for exact identifier matching',
              sourceIds: ['s2'],
              confidence: 'unverified',
            },
          ],
          sources: [
            {
              id: 's1',
              title: 'RRF in Practice',
              url: 'https://arxiv.org/abs/2401.99999',
              author: 'Cormack et al.',
              publishedDate: '2025',
              keyTakeaway: 'RRF provides parameter-free stability',
            },
            {
              id: 's2',
              title: 'Dense Retrieval Failures',
              filePath: '/home/antigravity/docs/failures.pdf',
              sourceType: 'local_document',
            },
          ],
          localDocumentAnalysis: {
            documentTitle: 'failures.pdf',
            documentPath: '/home/antigravity/docs/failures.pdf',
            highlights: ['Out of domain vocabulary degradation', 'Exact SKU matching'],
          },
          tags: ['search', 'retrieval'],
          sessionId: 'test-session-123',
        },
        { nowIso: '2026-11-10T12:00:00.000Z' },
      );

      expect(citationCount).toBe(2);
      expect(markdown).toContain('title: "Hybrid Retrieval Systems in 2026"');
      expect(markdown).toContain('session_id: "test-session-123"');
      expect(markdown).toContain('tags: [literature, research, retrieval, search]');
      expect(markdown).toContain('# Hybrid Retrieval Systems in 2026');
      expect(markdown).toContain('> **Research Topic:** Information Retrieval');
      expect(markdown).toContain('## Executive Summary\n\nA synthesis of BM25');
      // Footnote references in text
      expect(markdown).toContain('Reciprocal Rank Fusion consistently outperforms score linear combinations**[^1]');
      expect(markdown).toContain('Sparse representations are essential for exact identifier matching**[^2] *(unverified)*');
      // Local Document Section
      expect(markdown).toContain('## Local Document Ingestion: failures.pdf');
      expect(markdown).toContain('- Out of domain vocabulary degradation');
      // Footnotes / References list
      expect(markdown).toContain('## References & Citations');
      expect(markdown).toContain('[^1]: **[ACADEMIC]** [RRF in Practice](https://arxiv.org/abs/2401.99999) by Cormack et al. (2025) — RRF provides parameter-free stability');
      expect(markdown).toContain('[^2]: **[LOCAL_DOCUMENT]** `/home/antigravity/docs/failures.pdf`');
    });
  });

  describe('saveLiteratureNote', () => {
    it('atomically saves note in vault and redacts secrets', () => {
      const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
      try {
        const result = saveLiteratureNote(tmpVault, {
          title: 'Secret Key Study',
          summary: 'Evaluating API key leak protection sk-ant-api03-abcdef1234567890abcdef1234567890abcdef in literature.',
          findings: [
            {
              statement: 'Leak tests completed',
              sourceIds: ['src-1'],
            },
          ],
          sources: [
            {
              id: 'src-1',
              title: 'API Security',
              url: 'https://docs.anthropic.com/security',
            },
          ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.relPath).toBe('Cindy/Research/Secret-Key-Study.md');
        expect(fs.existsSync(result.fullPath)).toBe(true);
        const saved = fs.readFileSync(result.fullPath, 'utf8');
        expect(saved).not.toContain('sk-ant-api03');
        expect(saved).toContain('[redacted]');
        expect(saved).toContain('## References & Citations');
      } finally {
        fs.rmSync(tmpVault, { recursive: true, force: true });
      }
    });

    it('rejects paths escaping the vault', () => {
      const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
      try {
        const result = saveLiteratureNote(
          tmpVault,
          {
            title: 'Escape Attempt',
            summary: 'testing path escape',
            findings: [],
            sources: [],
          },
          { targetFolder: '../../etc' },
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('outside-vault');
        }
      } finally {
        fs.rmSync(tmpVault, { recursive: true, force: true });
      }
    });
  });
});
