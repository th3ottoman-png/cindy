/**
 * Cross-Session Vault Memory Synthesis (ROADMAP 6.3).
 *
 * Scans conversation summary notes in `<vault>/Cindy/Memory/` (or configured folder),
 * extracts structured sections (Overview, Decisions & Rationale, Facts Learned,
 * Open Questions, Next Steps), and synthesizes them into a consolidated
 * cross-session memory note at `<vault>/Cindy/Memory/Synthesis.md`.
 *
 * Enforces strict vault containment (no traversal, no symlink escapes) and
 * writes atomically via temp file + rename with secret redaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactSecrets } from '../export/session-markdown.js';
import { checkNotePath, type NoteError } from './vault-notes.js';

export const DEFAULT_SYNTHESIS_FOLDER = 'Cindy/Memory';
export const DEFAULT_SYNTHESIS_FILE = 'Cindy/Memory/Synthesis.md';
export const DEFAULT_SYNTHESIS_LIMIT = 20;
export const MAX_SYNTHESIS_LIMIT = 100;

export interface SummaryFileItem {
  fileName: string;
  relPath: string;
  fullPath: string;
  mtimeMs: number;
  sessionId?: string;
  title?: string;
  exportedAt?: string;
  turnsSummarized?: number;
  overview?: string;
  decisions: string[];
  facts: string[];
  openQuestions: string[];
  nextSteps: string[];
}

export interface VaultSynthesisSuccess {
  ok: true;
  relPath: string;
  fullPath: string;
  bytesWritten: number;
  sourcesCount: number;
  sources: string[];
}

export type VaultSynthesisResult = VaultSynthesisSuccess | NoteError;

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
 * Extracts bullet points from a markdown section text.
 * Trims leading bullet markers (`- `, `* `, `• `) and skips blank lines.
 */
function extractBullets(text: string): string[] {
  const lines = text.split('\n');
  const bullets: string[] = [];
  let currentBullet = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentBullet) {
        bullets.push(currentBullet.trim());
        currentBullet = '';
      }
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+\.\s+(.*)$/);
    if (bulletMatch) {
      if (currentBullet) {
        bullets.push(currentBullet.trim());
      }
      currentBullet = bulletMatch[1];
    } else if (currentBullet) {
      // Continuation line for the current bullet
      currentBullet += ` ${line}`;
    }
  }

  if (currentBullet) {
    bullets.push(currentBullet.trim());
  }

  return bullets;
}

/**
 * Parses markdown summary text into structured sections and frontmatter metadata.
 */
export function parseSummaryNote(rawContent: string): {
  frontmatter: Record<string, unknown>;
  overview?: string;
  decisions: string[];
  facts: string[];
  openQuestions: string[];
  nextSteps: string[];
} {
  let content = rawContent;
  const frontmatter: Record<string, unknown> = {};

  // Parse YAML frontmatter if present
  if (content.startsWith('---')) {
    const endFm = content.indexOf('\n---', 3);
    if (endFm !== -1) {
      const fmLines = content.slice(3, endFm).split('\n');
      for (const line of fmLines) {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          const key = line.slice(0, colon).trim();
          let val = line.slice(colon + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          frontmatter[key] = val;
        }
      }
      content = content.slice(endFm + 4);
    }
  }

  const sections: Record<string, string> = {};
  const headingRegex = /^##\s+([^\n]+)/gm;
  let lastHeading = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(content)) !== null) {
    if (lastHeading) {
      sections[lastHeading] = content.slice(lastIndex, match.index).trim();
    }
    lastHeading = match[1].trim();
    lastIndex = headingRegex.lastIndex;
  }
  if (lastHeading) {
    sections[lastHeading] = content.slice(lastIndex).trim();
  }

  const findSection = (namePatterns: string[]): string => {
    for (const [heading, body] of Object.entries(sections)) {
      const lower = heading.toLowerCase();
      if (namePatterns.some((p) => lower.includes(p.toLowerCase()))) {
        return body;
      }
    }
    return '';
  };

  const overviewText = findSection(['overview', 'summary']);
  const decisionsText = findSection(['decisions', 'rationale']);
  const factsText = findSection(['facts', 'discoveries', 'knowledge']);
  const questionsText = findSection(['questions', 'open questions', 'blockers']);
  const nextStepsText = findSection(['next steps', 'follow', 'actions']);

  return {
    frontmatter,
    overview: overviewText || undefined,
    decisions: extractBullets(decisionsText),
    facts: extractBullets(factsText),
    openQuestions: extractBullets(questionsText),
    nextSteps: extractBullets(nextStepsText),
  };
}

/**
 * Reads all conversation summary notes from `<vaultDir>/<folder>` (defaults to `Cindy/Memory`).
 * Sorts newest to oldest by modification time and caps at `limit`.
 */
export function collectSessionSummaries(
  vaultDir: string,
  options?: { folder?: string; limit?: number },
): SummaryFileItem[] {
  const root = vaultRoot(vaultDir);
  if (!root) return [];

  const folder = options?.folder || DEFAULT_SYNTHESIS_FOLDER;
  const limit = Math.min(Math.max(options?.limit ?? DEFAULT_SYNTHESIS_LIMIT, 1), MAX_SYNTHESIS_LIMIT);

  // Validate folder safety
  const checkProbe = checkNotePath(path.join(folder, 'probe.md'));
  if (!checkProbe.ok) return [];

  const targetDir = path.join(root, path.dirname(checkProbe.rel));
  if (!fs.existsSync(targetDir)) return [];

  let realDir: string;
  try {
    realDir = fs.realpathSync(targetDir);
  } catch {
    return [];
  }
  if (!inside(root, realDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(realDir);
  } catch {
    return [];
  }

  const summaryFiles = files.filter(
    (name) => name.endsWith('-summary.md') && !name.startsWith('.') && name !== 'Synthesis.md',
  );

  const items: SummaryFileItem[] = [];

  for (const name of summaryFiles) {
    const full = path.join(realDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;

      const raw = fs.readFileSync(full, 'utf8');
      const parsed = parseSummaryNote(raw);

      const relPath = path.join(path.dirname(checkProbe.rel), name).replace(/\\/g, '/');

      items.push({
        fileName: name,
        relPath,
        fullPath: full,
        mtimeMs: stat.mtimeMs,
        sessionId: typeof parsed.frontmatter.session_id === 'string' ? parsed.frontmatter.session_id : undefined,
        title: typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : undefined,
        exportedAt: typeof parsed.frontmatter.exported_at === 'string' ? parsed.frontmatter.exported_at : undefined,
        turnsSummarized:
          typeof parsed.frontmatter.turns_summarized === 'string'
            ? parseInt(parsed.frontmatter.turns_summarized, 10)
            : undefined,
        overview: parsed.overview,
        decisions: parsed.decisions,
        facts: parsed.facts,
        openQuestions: parsed.openQuestions,
        nextSteps: parsed.nextSteps,
      });
    } catch {
      continue;
    }
  }

  // Sort newest first
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return items.slice(0, limit);
}

/**
 * Deduplicates strings preserving order.
 */
function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Builds the Markdown text for the consolidated Synthesis document.
 */
export function synthesizeVaultNotes(
  summaries: SummaryFileItem[],
  options?: { generatedAt?: Date; title?: string },
): string {
  const generatedAt = options?.generatedAt ?? new Date();
  const isoDate = generatedAt.toISOString();
  const docTitle = options?.title || 'Cross-Session Memory Synthesis';

  const sources = summaries.map((s) => s.relPath);

  // Frontmatter
  const lines: string[] = [
    '---',
    'type: memory-synthesis',
    `generated: "${isoDate}"`,
    `sources_count: ${summaries.length}`,
    'sources:',
  ];
  for (const src of sources) {
    lines.push(`  - "${src}"`);
  }
  lines.push('---', '');

  // Document Heading
  lines.push(`# ${docTitle}`, '');
  lines.push(
    `> Consolidated long-term memory synthesized from ${summaries.length} conversation summaries on ${isoDate.slice(0, 10)}.`,
    '',
  );

  // Executive Overview
  lines.push('## Executive Summary', '');
  if (summaries.length === 0) {
    lines.push('_No conversation summaries found yet to synthesize._', '');
  } else {
    const recentOverviews = summaries
      .filter((s) => s.overview)
      .slice(0, 5)
      .map((s) => `- **${s.title || s.fileName.replace(/-summary\.md$/, '')}**: ${s.overview}`);

    if (recentOverviews.length > 0) {
      lines.push(...recentOverviews, '');
    } else {
      lines.push('Active work across recent development and research sessions.', '');
    }
  }

  // Key Decisions & Architecture
  lines.push('## Key Decisions & Architecture', '');
  const allDecisions = summaries.flatMap((s) => {
    const sourceRef = s.fileName.replace(/\.md$/, '');
    return s.decisions.map((d) => `${d} (from [[${sourceRef}|${s.title || 'summary'}]])`);
  });
  const dedupedDecisions = dedupeStrings(allDecisions);
  if (dedupedDecisions.length > 0) {
    for (const dec of dedupedDecisions) {
      lines.push(`- ${dec}`);
    }
  } else {
    lines.push('_No recorded decisions across analyzed sessions._');
  }
  lines.push('');

  // Facts Learned & Environment Details
  lines.push('## Facts Learned & Environment Details', '');
  const allFacts = summaries.flatMap((s) => s.facts);
  const dedupedFacts = dedupeStrings(allFacts);
  if (dedupedFacts.length > 0) {
    for (const fact of dedupedFacts) {
      lines.push(`- ${fact}`);
    }
  } else {
    lines.push('_No recorded facts across analyzed sessions._');
  }
  lines.push('');

  // Open Questions & Blockers
  lines.push('## Open Questions & Blockers', '');
  const allQuestions = summaries.flatMap((s) => s.openQuestions);
  const dedupedQuestions = dedupeStrings(allQuestions);
  if (dedupedQuestions.length > 0) {
    for (const q of dedupedQuestions) {
      lines.push(`- ${q}`);
    }
  } else {
    lines.push('_No open blockers or unresolved questions._');
  }
  lines.push('');

  // Next Actions & Pending Tasks
  lines.push('## Next Actions & Pending Tasks', '');
  const allNextSteps = summaries.flatMap((s) => s.nextSteps);
  const dedupedNextSteps = dedupeStrings(allNextSteps);
  if (dedupedNextSteps.length > 0) {
    for (const step of dedupedNextSteps) {
      lines.push(`- ${step}`);
    }
  } else {
    lines.push('_No pending next steps identified._');
  }
  lines.push('');

  // Session History Index
  lines.push('## Session History Index', '');
  if (summaries.length > 0) {
    lines.push('| Date | Session Title | Summary Link | Turns |');
    lines.push('|---|---|---|---|');
    for (const s of summaries) {
      const dateStr = (s.exportedAt || new Date(s.mtimeMs).toISOString()).slice(0, 10);
      const titleStr = (s.title || s.fileName.replace(/-summary\.md$/, '')).replace(/\|/g, '-');
      const turnsStr = s.turnsSummarized !== undefined ? String(s.turnsSummarized) : '-';
      const baseName = s.fileName.replace(/\.md$/, '');
      lines.push(`| ${dateStr} | ${titleStr} | [[${baseName}]] | ${turnsStr} |`);
    }
  } else {
    lines.push('_No sessions indexed._');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Writes the synthesized markdown into `<vaultDir>/<targetFile>` atomically.
 */
export function writeVaultSynthesis(
  vaultDir: string,
  content: string,
  options?: { targetFile?: string },
): VaultSynthesisResult {
  const root = vaultRoot(vaultDir);
  if (!root) return { ok: false, reason: 'no-vault', message: 'vault folder does not exist' };

  const targetFile = options?.targetFile || DEFAULT_SYNTHESIS_FILE;
  const checked = checkNotePath(targetFile);
  if (!checked.ok) return checked;

  const targetPath = path.join(root, checked.rel);
  const dir = path.dirname(targetPath);

  // Create missing directories one level at a time and check containment
  const missing: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    fs.mkdirSync(d);
    if (!inside(root, fs.realpathSync(d))) {
      fs.rmdirSync(d);
      return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };
    }
  }
  if (!inside(root, fs.realpathSync(dir))) {
    return { ok: false, reason: 'outside-vault', message: 'path leaves the vault' };
  }

  // Redact any secrets before writing
  const cleanContent = redactSecrets(content);

  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    fs.writeFileSync(tmpPath, cleanContent, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return {
      ok: false,
      reason: 'bad-path',
      message: `could not write synthesis note ${targetFile}: ${(err as Error).message}`,
    };
  }

  const stat = fs.statSync(targetPath);
  return {
    ok: true,
    relPath: checked.rel,
    fullPath: targetPath,
    bytesWritten: stat.size,
    sourcesCount: 0,
    sources: [],
  };
}

/**
 * Orchestrates full cross-session synthesis:
 * Collects session summaries -> compiles synthesis document -> writes atomically to vault.
 */
export function runVaultSynthesis(
  vaultDir: string,
  options?: {
    memoryFolder?: string;
    targetFile?: string;
    limit?: number;
    title?: string;
  },
): VaultSynthesisResult {
  const summaries = collectSessionSummaries(vaultDir, {
    folder: options?.memoryFolder,
    limit: options?.limit,
  });

  const markdown = synthesizeVaultNotes(summaries, { title: options?.title });
  const writeRes = writeVaultSynthesis(vaultDir, markdown, { targetFile: options?.targetFile });

  if (!writeRes.ok) return writeRes;

  return {
    ...writeRes,
    sourcesCount: summaries.length,
    sources: summaries.map((s) => s.relPath),
  };
}
