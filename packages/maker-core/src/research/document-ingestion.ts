/**
 * Local Document Ingestion & Parser for Notes Vault (ROADMAP 9.5).
 *
 * Local-first parser for PDFs, CSV/TSV spreadsheets, Markdown, and text files.
 * Extracts structured text, sections, metadata, tabular data, and chunks
 * without external network calls or cloud services.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export type DocumentType = 'pdf' | 'spreadsheet' | 'markdown' | 'text' | 'unknown';
export type DocumentClassification = 'academic_paper' | 'technical_spec' | 'data_sheet' | 'general_document';

export interface DocumentMetadata {
  title?: string;
  author?: string;
  pageCount?: number;
  wordCount: number;
  fileSizeBytes: number;
  fileName: string;
  classification: DocumentClassification;
  tags: string[];
}

export interface DocumentSection {
  title: string;
  level: number;
  content: string;
  page?: number;
}

export interface IngestedTable {
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
  markdown: string;
}

export interface DocumentChunk {
  index: number;
  text: string;
  section?: string;
  page?: number;
  charCount: number;
}

export interface IngestedDocument {
  ok: true;
  filePath: string;
  documentType: DocumentType;
  metadata: DocumentMetadata;
  fullText: string;
  sections: DocumentSection[];
  tables?: IngestedTable[];
  chunks: DocumentChunk[];
}

export interface IngestionError {
  ok: false;
  filePath: string;
  error: string;
}

export type IngestionResult = IngestedDocument | IngestionError;

export interface IngestOptions {
  chunkSize?: number;
  maxPages?: number;
  maxChars?: number;
}

const DEFAULT_CHUNK_SIZE = 1200;
const MAX_FILE_CHARS = 500_000;

/**
 * Detects document type from file extension and buffer header.
 */
export function detectDocumentType(filePath: string, buffer?: Buffer): DocumentType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.csv' || ext === '.tsv') return 'spreadsheet';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt' || ext === '.json' || ext === '.yaml' || ext === '.yml') return 'text';

  if (buffer && buffer.length >= 4) {
    if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  }

  return 'unknown';
}

/**
 * Ingests a local document from a file path or in-memory Buffer/string.
 */
export function ingestDocument(
  filePath: string,
  input?: Buffer | string,
  options: IngestOptions = {},
): IngestionResult {
  try {
    let contentBuffer: Buffer;
    if (input instanceof Buffer) {
      contentBuffer = input;
    } else if (typeof input === 'string') {
      contentBuffer = Buffer.from(input, 'utf8');
    } else {
      if (!fs.existsSync(filePath)) {
        return { ok: false, filePath, error: `file not found: ${filePath}` };
      }
      contentBuffer = fs.readFileSync(filePath);
    }

    const docType = detectDocumentType(filePath, contentBuffer);
    const fileName = path.basename(filePath);
    const fileSizeBytes = contentBuffer.length;

    let fullText = '';
    let sections: DocumentSection[] = [];
    let tables: IngestedTable[] | undefined;
    let pageCount = 1;
    let title: string | undefined;
    let author: string | undefined;

    switch (docType) {
      case 'pdf': {
        const parsedPdf = extractPdfContent(contentBuffer, options.maxPages);
        fullText = parsedPdf.text;
        sections = parsedPdf.sections;
        pageCount = parsedPdf.pageCount;
        title = parsedPdf.title;
        author = parsedPdf.author;
        break;
      }
      case 'spreadsheet': {
        const parsedSheet = parseSpreadsheetContent(contentBuffer.toString('utf8'), filePath);
        fullText = parsedSheet.fullText;
        tables = [parsedSheet.table];
        sections = [{ title: 'Tabular Data', level: 1, content: parsedSheet.table.markdown }];
        title = fileName.replace(/\.(csv|tsv)$/i, '');
        break;
      }
      case 'markdown':
      case 'text':
      default: {
        const rawText = contentBuffer.toString('utf8');
        const parsedText = parseTextContent(rawText, fileName);
        fullText = parsedText.fullText;
        sections = parsedText.sections;
        title = parsedText.title;
        break;
      }
    }

    const charLimit = options.maxChars && options.maxChars > 0 ? Math.min(options.maxChars, MAX_FILE_CHARS) : MAX_FILE_CHARS;
    if (fullText.length > charLimit) {
      fullText = fullText.slice(0, charLimit);
      let remaining = charLimit;
      const cappedSections: DocumentSection[] = [];
      for (const sec of sections) {
        if (remaining <= 0) break;
        const sliced = sec.content.slice(0, remaining);
        cappedSections.push({ ...sec, content: sliced });
        remaining -= sliced.length;
      }
      sections = cappedSections;
    }

    const wordCount = fullText.trim() ? fullText.trim().split(/\s+/).length : 0;
    const classification = classifyDocument(fullText, docType);
    const tags = deriveDocumentTags(fullText, classification, docType);

    const chunks = chunkDocument(fullText, sections, options.chunkSize ?? DEFAULT_CHUNK_SIZE);

    return {
      ok: true,
      filePath,
      documentType: docType,
      metadata: {
        title: title || fileName,
        author,
        pageCount,
        wordCount,
        fileSizeBytes,
        fileName,
        classification,
        tags,
      },
      fullText,
      sections,
      tables,
      chunks,
    };
  } catch (err) {
    return {
      ok: false,
      filePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extracts plain text and metadata from PDF bytes.
 */
function extractPdfContent(buffer: Buffer, maxPages?: number): {
  text: string;
  sections: DocumentSection[];
  pageCount: number;
  title?: string;
  author?: string;
} {
  const raw = buffer.toString('binary');

  // Count pages via /Type /Page and bound extraction to maxPages when specified
  const pageRegex = /\/Type\s*\/Page\b/g;
  const pageIndices: number[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = pageRegex.exec(raw)) !== null) {
    pageIndices.push(pm.index);
  }
  let pageCount = pageIndices.length > 0 ? pageIndices.length : 1;
  let extractionSource = raw;
  if (maxPages && maxPages > 0 && pageCount > maxPages) {
    pageCount = maxPages;
    const cutoffIdx = pageIndices[maxPages];
    if (cutoffIdx !== undefined) {
      extractionSource = raw.slice(0, cutoffIdx);
    }
  }

  // Extract PDF Metadata if present
  let title: string | undefined;
  let author: string | undefined;
  const titleMatch = raw.match(/\/Title\s*\(([^)]+)\)/i);
  if (titleMatch?.[1]) title = titleMatch[1].trim();

  const authorMatch = raw.match(/\/Author\s*\(([^)]+)\)/i);
  if (authorMatch?.[1]) author = authorMatch[1].trim();

  // Extract text from text blocks (BT ... ET) preserving Tj / TJ operator order
  const extractBtEtFromText = (src: string, outChunks: string[]): void => {
    const btRegex = /BT[\s\S]*?ET/g;
    let match: RegExpExecArray | null;
    while ((match = btRegex.exec(src)) !== null) {
      const block = match[0];
      const opRegex = /(?:\(([^)]+)\)\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ)/g;
      let opMatch: RegExpExecArray | null;
      let line = '';
      while ((opMatch = opRegex.exec(block)) !== null) {
        if (opMatch[1] !== undefined) {
          line += opMatch[1] + ' ';
        } else if (opMatch[2] !== undefined) {
          const strParts = opMatch[2].match(/\(([^)]+)\)/g);
          if (strParts) {
            line += strParts.map((s) => s.slice(1, -1)).join('') + ' ';
          }
        }
      }
      if (line.trim()) {
        outChunks.push(line.trim());
      }
    }
  };

  const textChunks: string[] = [];
  extractBtEtFromText(extractionSource, textChunks);

  if (textChunks.length === 0) {
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let sm: RegExpExecArray | null;
    while ((sm = streamRegex.exec(extractionSource)) !== null) {
      const streamBytes = Buffer.from(sm[1]!, 'binary');
      for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
        try {
          const decoded = inflate(streamBytes).toString('latin1');
          extractBtEtFromText(decoded, textChunks);
          break;
        } catch {
          // Not a valid deflate stream; ignore
        }
      }
    }
  }

  // If text streams were found, join them
  let fullText = textChunks.join('\n\n');

  // If raw PDF text streams were compressed and empty, extract printable string sequences
  if (!fullText.trim()) {
    const printableLines: string[] = [];
    const strings = raw.match(/[A-Za-z0-9 ,.;:!?'"()/-]{6,}/g) || [];
    for (const s of strings) {
      // Filter out internal PDF operators
      if (!/^\/(Root|Pages|Catalog|Type|Filter|FlateDecode)/.test(s)) {
        printableLines.push(s);
      }
    }
    fullText = printableLines.slice(0, 500).join('\n');
  }

  // Detect sections (e.g. Abstract, Introduction, Methods, Results, Discussion, Conclusion)
  const sections: DocumentSection[] = [];
  const lines = fullText.split(/\r?\n/);
  let currentSection: DocumentSection = { title: 'Overview', level: 1, content: '' };

  const sectionHeaderPattern = /^(?:[0-9]+\.?\s+)?(Abstract|Introduction|Background|Methodology|Methods|Implementation|Results|Evaluation|Discussion|Conclusion|References)\b(?:\s*[:.—-]\s*(.*))?$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const headerMatch = trimmed.match(sectionHeaderPattern);
    if (headerMatch && (trimmed.length < 80 || headerMatch[2])) {
      if (currentSection.content.trim()) {
        sections.push(currentSection);
      }
      currentSection = {
        title: headerMatch[1],
        level: 2,
        content: headerMatch[2] ? headerMatch[2].trim() : '',
      };
    } else {
      currentSection.content += (currentSection.content ? '\n' : '') + trimmed;
    }
  }
  if (currentSection.content.trim()) {
    sections.push(currentSection);
  }

  if (!title && sections.length > 0 && sections[0].content) {
    const firstLine = sections[0].content.split('\n')[0]?.trim();
    if (firstLine && firstLine.length < 120) {
      title = firstLine;
    }
  }

  return {
    text: fullText,
    sections,
    pageCount,
    title,
    author,
  };
}

/**
 * Parses CSV / TSV spreadsheet into a structured table and text summary.
 */
function parseSpreadsheetContent(content: string, filePath: string): {
  fullText: string;
  table: IngestedTable;
} {
  const isTsv = filePath.toLowerCase().endsWith('.tsv');
  const delimiter = isTsv ? '\t' : ',';

  const parsedRows: string[][] = [];
  let currentField = '';
  let currentRow: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && content[i + 1] === '\n') i += 1;
      currentRow.push(currentField.trim());
      currentField = '';
      if (currentRow.some((cell) => cell.length > 0)) {
        parsedRows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentField += ch;
    }
  }
  if (currentField.trim().length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((cell) => cell.length > 0)) {
      parsedRows.push(currentRow);
    }
  }

  if (parsedRows.length === 0) {
    const emptyTable: IngestedTable = { headers: [], rows: [], rowCount: 0, columnCount: 0, markdown: '' };
    return { fullText: 'Empty spreadsheet', table: emptyTable };
  }

  const headers = parsedRows[0]!;
  const rows = parsedRows.slice(1);

  // Build markdown table
  let md = '| ' + headers.join(' | ') + ' |\n';
  md += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
  for (const r of rows.slice(0, 100)) {
    // Limit to first 100 rows for display
    const padded = headers.map((_, i) => r[i] ?? '');
    md += '| ' + padded.join(' | ') + ' |\n';
  }

  const table: IngestedTable = {
    headers,
    rows,
    rowCount: rows.length,
    columnCount: headers.length,
    markdown: md,
  };

  const fullText = `Spreadsheet with ${headers.length} columns and ${rows.length} rows.\n\nColumns: ${headers.join(', ')}\n\n${md}`;
  return { fullText, table };
}

/**
 * Parses markdown or plain text with heading breakdown.
 */
function parseTextContent(raw: string, fileName: string): {
  fullText: string;
  sections: DocumentSection[];
  title?: string;
} {
  let text = raw;
  let title: string | undefined;

  // Extract YAML frontmatter title if present
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = text.slice(3, end);
      const titleMatch = fm.match(/^title:\s*["']?([^"'\r\n]+)["']?/m);
      if (titleMatch?.[1]) title = titleMatch[1].trim();
      text = text.slice(end + 4).trimStart();
    }
  }

  const sections: DocumentSection[] = [];
  const lines = text.split(/\r?\n/);
  let currentSection: DocumentSection = { title: 'Overview', level: 1, content: '' };

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      if (currentSection.content.trim()) {
        sections.push(currentSection);
      }
      const level = headingMatch[1].length;
      const secTitle = headingMatch[2].trim();
      if (!title && level === 1) {
        title = secTitle;
      }
      currentSection = {
        title: secTitle,
        level,
        content: '',
      };
    } else {
      currentSection.content += (currentSection.content ? '\n' : '') + line;
    }
  }
  if (currentSection.content.trim()) {
    sections.push(currentSection);
  }

  if (!title) {
    title = fileName.replace(/\.[^.]+$/, '');
  }

  return { fullText: text, sections, title };
}

/**
 * Classifies document by content patterns.
 */
function classifyDocument(text: string, type: DocumentType): DocumentClassification {
  if (type === 'spreadsheet') return 'data_sheet';
  const lower = text.toLowerCase();
  if (
    lower.includes('abstract') &&
    (lower.includes('references') || lower.includes('doi:') || lower.includes('arxiv:'))
  ) {
    return 'academic_paper';
  }
  if (
    lower.includes('specification') ||
    lower.includes('architecture') ||
    lower.includes('rfc') ||
    lower.includes('requirements')
  ) {
    return 'technical_spec';
  }
  return 'general_document';
}

/**
 * Derives categorization tags from document text and classification.
 */
function deriveDocumentTags(text: string, classification: DocumentClassification, type: DocumentType): string[] {
  const tags = new Set<string>();
  tags.add('document');
  tags.add(type);
  tags.add(classification.replace('_', '-'));

  const lower = text.toLowerCase();
  const keywords = ['ai', 'agent', 'sqlite', 'react', 'api', 'benchmark', 'security', 'python', 'typescript', 'vault', 'research'];
  for (const kw of keywords) {
    if (lower.includes(kw)) tags.add(kw);
  }
  return Array.from(tags).sort();
}

/**
 * Splits document text into manageable, bounded chunks for agent consumption.
 */
function chunkDocument(
  fullText: string,
  sections: DocumentSection[],
  rawChunkSize: number,
): DocumentChunk[] {
  const chunkSize = Number.isFinite(rawChunkSize) && rawChunkSize > 0
    ? Math.max(1, Math.floor(rawChunkSize))
    : DEFAULT_CHUNK_SIZE;
  const chunks: DocumentChunk[] = [];
  let chunkIndex = 1;

  if (sections.length > 0) {
    for (const sec of sections) {
      const content = sec.content.trim();
      if (!content) continue;

      if (content.length <= chunkSize) {
        chunks.push({
          index: chunkIndex++,
          text: content,
          section: sec.title,
          charCount: content.length,
        });
      } else {
        // Split section by paragraphs
        const paras = content.split(/\n\s*\n/);
        let currentChunk = '';
        for (const p of paras) {
          if ((currentChunk ? currentChunk.length + 2 + p.length : p.length) <= chunkSize) {
            currentChunk += (currentChunk ? '\n\n' : '') + p;
          } else {
            if (currentChunk.trim()) {
              chunks.push({
                index: chunkIndex++,
                text: currentChunk.trim(),
                section: sec.title,
                charCount: currentChunk.trim().length,
              });
              currentChunk = '';
            }
            if (p.length > chunkSize) {
              for (let offset = 0; offset < p.length; offset += chunkSize) {
                const slice = p.slice(offset, offset + chunkSize).trim();
                if (slice) {
                  chunks.push({
                    index: chunkIndex++,
                    text: slice,
                    section: sec.title,
                    charCount: slice.length,
                  });
                }
              }
            } else {
              currentChunk = p;
            }
          }
        }
        if (currentChunk.trim()) {
          chunks.push({
            index: chunkIndex++,
            text: currentChunk.trim(),
            section: sec.title,
            charCount: currentChunk.trim().length,
          });
        }
      }
    }
  } else {
    // Chunk linearly
    for (let i = 0; i < fullText.length; i += chunkSize) {
      const slice = fullText.slice(i, i + chunkSize).trim();
      if (slice) {
        chunks.push({
          index: chunkIndex++,
          text: slice,
          charCount: slice.length,
        });
      }
    }
  }

  return chunks;
}
