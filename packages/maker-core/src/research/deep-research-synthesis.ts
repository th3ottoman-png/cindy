/**
 * Deep Research Synthesis & Vault Literature Note Assembler (ROADMAP 9.5).
 *
 * Compiles multi-hop web search and local document research findings into
 * structured literature notes directly in the Obsidian notes vault (`Bishi-memory`).
 *
 * Provides:
 * - Source classification (academic, documentation, news, reference, local_document).
 * - Automatic numbered citation extraction and footnote formatting ([^1], [^2]).
 * - Atomic vault persistence with containment checking and secret redaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactSecrets } from '../export/session-markdown.js';
import { checkNotePath, type NoteError } from '../notes/vault-notes.js';

export type ResearchSourceType = 'academic' | 'documentation' | 'news' | 'reference' | 'local_document';

export interface ResearchSourceItem {
  id?: string;
  title: string;
  url?: string;
  filePath?: string;
  sourceType?: ResearchSourceType;
  author?: string;
  publishedDate?: string;
  keyTakeaway?: string;
}

export interface ResearchFindingItem {
  statement: string;
  detail?: string;
  sourceIds?: string[];
  confidence?: 'high' | 'medium' | 'unverified';
}

export interface ResearchSynthesisInput {
  title: string;
  topic?: string;
  summary: string;
  findings: ResearchFindingItem[];
  sources: ResearchSourceItem[];
  localDocumentAnalysis?: {
    documentTitle: string;
    documentPath: string;
    highlights: string[];
  };
  tags?: string[];
  sessionId?: string;
}

export interface LiteratureNoteResult {
  ok: true;
  relPath: string;
  fullPath: string;
  bytesWritten: number;
  citationCount: number;
  sourceCount: number;
}

export type SaveLiteratureNoteResult = LiteratureNoteResult | NoteError;

export interface SaveSynthesisOptions {
  targetFolder?: string; // defaults to 'Cindy/Research' or 'Literature'
  fileName?: string;
}

/**
 * Classifies a source based on its URL or path.
 */
export function classifySource(item: { url?: string; filePath?: string }): ResearchSourceType {
  if (item.filePath) return 'local_document';
  const url = (item.url || '').toLowerCase();
  if (url.includes('arxiv.org') || url.includes('.edu') || url.includes('ieee.org') || url.includes('acm.org') || url.includes('nature.com') || url.includes('doi.org')) {
    return 'academic';
  }
  if (url.includes('docs.') || url.includes('developer.') || url.includes('github.com') || url.includes('spec.')) {
    return 'documentation';
  }
  if (url.includes('news.') || url.includes('reuters.com') || url.includes('bloomberg.com') || url.includes('techcrunch.com')) {
    return 'news';
  }
  return 'reference';
}

/**
 * Normalizes title into a clean filename slug.
 */
export function slugifyTitle(title: string): string {
  const sanitized = title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
  return sanitized.slice(0, 80) || 'Research-Synthesis';
}

/**
 * Assembles a complete Markdown literature note with frontmatter, synthesis sections,
 * and structured footnote citations.
 */
export function assembleLiteratureNote(
  synthesis: ResearchSynthesisInput,
  options: { nowIso?: string } = {},
): { markdown: string; citationCount: number } {
  const now = options.nowIso || new Date().toISOString();

  // Map sources to numbered citations (1-indexed)
  const sourceIndexMap = new Map<string, number>();
  const citationList: Array<{ index: number; source: ResearchSourceItem }> = [];

  synthesis.sources.forEach((source, idx) => {
    const key = source.id || source.url || source.filePath || String(idx + 1);
    const citationIndex = idx + 1;
    sourceIndexMap.set(key, citationIndex);
    citationList.push({ index: citationIndex, source });
  });

  const getCitationRef = (sourceIdOrIndex: string | number): string => {
    const found = sourceIndexMap.get(String(sourceIdOrIndex));
    return found ? `[^${found}]` : '';
  };

  // Build Frontmatter
  const tags = Array.from(new Set(['research', 'literature', ...(synthesis.tags || [])])).sort();
  let md = '---\n';
  md += `title: "${synthesis.title.replace(/"/g, '\\"')}"\n`;
  md += `type: literature-note\n`;
  md += `created_at: ${now}\n`;
  if (synthesis.sessionId) md += `session_id: "${synthesis.sessionId}"\n`;
  md += `tags: [${tags.join(', ')}]\n`;
  md += 'sources:\n';
  for (const s of synthesis.sources) {
    const st = s.sourceType || classifySource(s);
    md += `  - title: "${s.title.replace(/"/g, '\\"')}"\n`;
    if (s.url) md += `    url: "${s.url}"\n`;
    if (s.filePath) md += `    file_path: "${s.filePath}"\n`;
    md += `    type: ${st}\n`;
  }
  md += '---\n\n';

  // Title & Topic Header
  md += `# ${synthesis.title}\n\n`;
  if (synthesis.topic) {
    md += `> **Research Topic:** ${synthesis.topic}\n\n`;
  }

  // Executive Summary
  md += `## Executive Summary\n\n${synthesis.summary.trim()}\n\n`;

  // Key Findings
  if (synthesis.findings.length > 0) {
    md += `## Key Findings\n\n`;
    for (const f of synthesis.findings) {
      const citeMarkers = (f.sourceIds || [])
        .map((sid) => getCitationRef(sid))
        .filter(Boolean)
        .join('');

      const confBadge = f.confidence === 'unverified' ? ' *(unverified)*' : '';
      md += `- **${f.statement}**${citeMarkers}${confBadge}\n`;
      if (f.detail) {
        md += `  ${f.detail}\n`;
      }
    }
    md += '\n';
  }

  // Local Document Analysis (if present)
  if (synthesis.localDocumentAnalysis) {
    const lda = synthesis.localDocumentAnalysis;
    md += `## Local Document Ingestion: ${lda.documentTitle}\n\n`;
    md += `*Source File:* \`${lda.documentPath}\`\n\n`;
    if (lda.highlights.length > 0) {
      md += `### Primary Extracted Insights\n\n`;
      for (const h of lda.highlights) {
        md += `- ${h}\n`;
      }
      md += '\n';
    }
  }

  // References & Footnotes Section
  md += `## References & Citations\n\n`;
  for (const { index, source } of citationList) {
    const st = source.sourceType || classifySource(source);
    const link = source.url ? `[${source.title}](${source.url})` : `\`${source.filePath || source.title}\``;
    const authorPart = source.author ? ` by ${source.author}` : '';
    const datePart = source.publishedDate ? ` (${source.publishedDate})` : '';
    const takeaway = source.keyTakeaway ? ` — ${source.keyTakeaway}` : '';

    md += `[^${index}]: **[${st.toUpperCase()}]** ${link}${authorPart}${datePart}${takeaway}\n`;
  }

  return {
    markdown: md,
    citationCount: citationList.length,
  };
}

function vaultRoot(vaultDir: string): string | undefined {
  try {
    return fs.realpathSync(vaultDir);
  } catch {
    return undefined;
  }
}

function inside(root: string, target: string): boolean {
  const r = path.relative(root, target);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/**
 * Saves assembled literature note into the vault with atomic write and secret redaction.
 */
export function saveLiteratureNote(
  vaultDir: string,
  synthesis: ResearchSynthesisInput,
  options: SaveSynthesisOptions = {},
): SaveLiteratureNoteResult {
  const folder = options.targetFolder || 'Cindy/Research';
  const fileName = options.fileName || `${slugifyTitle(synthesis.title)}.md`;
  const relPath = path.posix.join(folder.replace(/\\/g, '/'), fileName);

  const check = checkNotePath(relPath);
  if (!check.ok) {
    return check;
  }

  const root = vaultRoot(vaultDir);
  if (!root) {
    return { ok: false, reason: 'no-vault', message: 'vault folder does not exist' };
  }

  const fullPath = path.join(root, check.rel);
  if (!inside(root, fullPath)) {
    return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };
  }

  const { markdown, citationCount } = assembleLiteratureNote(synthesis);
  const sanitizedMarkdown = redactSecrets(markdown);

  const targetDir = path.dirname(fullPath);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: 'bad-path',
      message: `failed to create directory ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Atomic write via temp file + rename
  const tmpFile = path.join(targetDir, `.${path.basename(fullPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpFile, sanitizedMarkdown, 'utf8');
    fs.renameSync(tmpFile, fullPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    return {
      ok: false,
      reason: 'bad-path',
      message: `failed to write note ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    relPath: check.rel,
    fullPath,
    bytesWritten: Buffer.byteLength(sanitizedMarkdown, 'utf8'),
    citationCount,
    sourceCount: synthesis.sources.length,
  };
}
