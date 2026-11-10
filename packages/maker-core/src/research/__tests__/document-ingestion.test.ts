import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectDocumentType,
  ingestDocument,
} from '../document-ingestion.js';

describe('document-ingestion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-doc-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('detectDocumentType', () => {
    it('detects document types from extensions', () => {
      expect(detectDocumentType('paper.pdf')).toBe('pdf');
      expect(detectDocumentType('metrics.csv')).toBe('spreadsheet');
      expect(detectDocumentType('data.tsv')).toBe('spreadsheet');
      expect(detectDocumentType('notes.md')).toBe('markdown');
      expect(detectDocumentType('log.txt')).toBe('text');
      expect(detectDocumentType('binary.bin')).toBe('unknown');
    });

    it('detects PDF from magic bytes when extension is missing', () => {
      const pdfHeader = Buffer.from('%PDF-1.4 header content');
      expect(detectDocumentType('unknown-file', pdfHeader)).toBe('pdf');
    });
  });

  describe('ingestDocument with Markdown & Text', () => {
    it('parses markdown document with frontmatter and headings', () => {
      const mdContent = `---
title: "Agent Memory Architecture"
author: "Cindy Core Team"
---

# Overview
This document outlines the architecture for persistent memory.

## Design Goals
- Local first
- Zero cloud dependency
- Atomic writes

## Implementation Details
We use SQLite and Obsidian markdown vaults.
`;
      const filePath = path.join(tmpDir, 'spec.md');
      fs.writeFileSync(filePath, mdContent, 'utf8');

      const result = ingestDocument(filePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.metadata.title).toBe('Agent Memory Architecture');
      expect(result.documentType).toBe('markdown');
      expect(result.sections.length).toBeGreaterThanOrEqual(3);
      expect(result.sections[0].title).toBe('Overview');
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.metadata.tags).toContain('markdown');
    });
  });

  describe('ingestDocument with Spreadsheets (CSV/TSV)', () => {
    it('parses CSV into structured markdown tables and row metrics', () => {
      const csvContent = `Model,Window,TokensPerSec,Provider
Qwen-2.5-7B,32768,45.2,LMStudio
Llama-3.1-8B,131072,52.8,Ollama
DeepSeek-V3,65536,38.1,LocalVllm
`;
      const filePath = path.join(tmpDir, 'benchmarks.csv');
      fs.writeFileSync(filePath, csvContent, 'utf8');

      const result = ingestDocument(filePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.documentType).toBe('spreadsheet');
      expect(result.metadata.classification).toBe('data_sheet');
      expect(result.tables).toBeDefined();
      expect(result.tables![0].rowCount).toBe(3);
      expect(result.tables![0].columnCount).toBe(4);
      expect(result.tables![0].headers).toEqual(['Model', 'Window', 'TokensPerSec', 'Provider']);
      expect(result.tables![0].markdown).toContain('| Qwen-2.5-7B | 32768 | 45.2 | LMStudio |');
    });
  });

  describe('ingestDocument with PDF structure', () => {
    it('parses uncompressed text streams and extracts metadata and sections from mock PDF', () => {
      // Constructs a valid minimal PDF buffer with text operators (BT ... ET)
      const mockPdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Title (Deep Research on Local LLMs) /Author (Dr. Alice Smith) >>
endobj
2 0 obj
<< /Type /Page >>
stream
BT
/F1 12 Tf
(Abstract: This paper studies local LLM reasoning.) Tj
ET
BT
/F1 12 Tf
(Introduction: Open weights models have achieved strong parity.) Tj
ET
BT
/F1 12 Tf
(Methods: We evaluate 7B and 14B parameter models.) Tj
ET
BT
/F1 12 Tf
(References: [1] Vaswani et al., arXiv:1706.03762) Tj
ET
endstream
endobj
%%EOF`);
      const filePath = path.join(tmpDir, 'paper.pdf');
      fs.writeFileSync(filePath, mockPdf);

      const result = ingestDocument(filePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.documentType).toBe('pdf');
      expect(result.metadata.title).toBe('Deep Research on Local LLMs');
      expect(result.metadata.author).toBe('Dr. Alice Smith');
      expect(result.metadata.classification).toBe('academic_paper');
      expect(result.fullText).toContain('Abstract: This paper studies local LLM reasoning.');
      expect(result.fullText).toContain('Introduction: Open weights models');
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('returns error when file does not exist', () => {
      const result = ingestDocument(path.join(tmpDir, 'missing.pdf'));
      expect(result.ok).toBe(false);
    });
  });
});
