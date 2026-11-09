/**
 * inline-diff-card.ts — Pure unified diff parser & card projection model.
 * ---------------------------------------------------------------------------
 * Parses unified diffs, git patches, and raw diff text into a structured
 * representation for interactive visual diff cards in chat:
 *  - Extract file path & language extension
 *  - Precise line numbers for old & new files
 *  - Addition & deletion statistics
 *  - Unified rows (gutter, +/- symbol, code)
 *  - Split rows (side-by-side left/right pairs)
 *
 * Pure logic: zero React, zero DOM, zero Electron, zero network/FS dependencies.
 */

export interface DiffHunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading?: string;
}

export type DiffLineType = 'add' | 'del' | 'ctx' | 'header';

export interface UnifiedDiffLine {
  type: DiffLineType;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  raw: string;
}

export interface SplitDiffCell {
  type: 'add' | 'del' | 'ctx';
  lineNumber?: number;
  text: string;
}

export interface SplitDiffRow {
  left: SplitDiffCell | null;
  right: SplitDiffCell | null;
  isHeader?: boolean;
  headerText?: string;
}

export interface ParsedDiffCard {
  filePath?: string;
  fileName?: string;
  fileExtension?: string;
  additions: number;
  deletions: number;
  lines: UnifiedDiffLine[];
  splitRows: SplitDiffRow[];
  hasHeaders: boolean;
}

const HUNK_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:[ \t]+(.*))?$/;

/**
 * Normalise a raw path from `diff --git a/... b/...` or `+++ b/...`.
 */
function cleanDiffPath(rawPath: string): string {
  let cleaned = rawPath.trim();
  // Strip quotes if any
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }
  // Strip a/ or b/ prefix if present
  if (cleaned.startsWith('a/') || cleaned.startsWith('b/')) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

/**
 * Extract target file path from unified diff headers.
 */
export function extractDiffFilePath(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const p = cleanDiffPath(line.slice(4));
      if (p && p !== '/dev/null') return p;
    }
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.slice(11).split(' ');
      if (parts.length >= 2) {
        const dest = cleanDiffPath(parts[1]);
        if (dest && dest !== '/dev/null') return dest;
      }
    }
  }
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      const p = cleanDiffPath(line.slice(4));
      if (p && p !== '/dev/null') return p;
    }
  }
  for (const line of lines) {
    if (line.startsWith('Index: ')) {
      const p = line.slice(7).trim();
      if (p) return cleanDiffPath(p);
    }
  }
  return undefined;
}

/**
 * Parse a raw diff string into structured card model.
 */
export function parseUnifiedDiff(raw: string): ParsedDiffCard {
  if (!raw || typeof raw !== 'string') {
    return {
      additions: 0,
      deletions: 0,
      lines: [],
      splitRows: [],
      hasHeaders: false,
    };
  }

  const filePath = extractDiffFilePath(raw);
  const fileName = filePath ? filePath.split(/[/\\]/).pop() : undefined;
  const fileExtension = fileName?.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;

  const rawLines = raw.replace(/^\n+|\n+$/g, '').split(/\r?\n/);

  let additions = 0;
  let deletions = 0;
  let hasHeaders = false;

  let curOld: number | undefined;
  let curNew: number | undefined;

  const lines: UnifiedDiffLine[] = [];

  for (const rawLine of rawLines) {
    const hunkMatch = rawLine.match(HUNK_REGEX);
    if (hunkMatch) {
      hasHeaders = true;
      const oldStart = parseInt(hunkMatch[1], 10);
      const newStart = parseInt(hunkMatch[3], 10);
      curOld = oldStart;
      curNew = newStart;

      lines.push({
        type: 'header',
        text: rawLine,
        raw: rawLine,
      });
      continue;
    }

    if (
      rawLine.startsWith('diff --git ') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('--- ') ||
      rawLine.startsWith('+++ ') ||
      rawLine.startsWith('old mode ') ||
      rawLine.startsWith('new mode ') ||
      rawLine.startsWith('new file mode ') ||
      rawLine.startsWith('deleted file mode ')
    ) {
      hasHeaders = true;
      lines.push({
        type: 'header',
        text: rawLine,
        raw: rawLine,
      });
      continue;
    }

    if (rawLine.startsWith('+')) {
      additions++;
      const text = rawLine.slice(1).replace(/^ /, '');
      const lineNum = curNew !== undefined ? curNew++ : additions;
      lines.push({
        type: 'add',
        text,
        newLineNumber: lineNum,
        raw: rawLine,
      });
    } else if (rawLine.startsWith('-')) {
      deletions++;
      const text = rawLine.slice(1).replace(/^ /, '');
      const lineNum = curOld !== undefined ? curOld++ : deletions;
      lines.push({
        type: 'del',
        text,
        oldLineNumber: lineNum,
        raw: rawLine,
      });
    } else {
      // Context line (leading space or unmodified line)
      const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
      const oldNum = curOld !== undefined ? curOld++ : undefined;
      const newNum = curNew !== undefined ? curNew++ : undefined;
      lines.push({
        type: 'ctx',
        text,
        oldLineNumber: oldNum,
        newLineNumber: newNum,
        raw: rawLine,
      });
    }
  }

  // Build Side-by-Side (Split) rows by aligning consecutive deletions and additions
  const splitRows = buildSplitDiffRows(lines);

  return {
    filePath,
    fileName,
    fileExtension,
    additions,
    deletions,
    lines,
    splitRows,
    hasHeaders,
  };
}

/**
 * Convert unified lines into paired side-by-side rows.
 */
export function buildSplitDiffRows(lines: UnifiedDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === 'header') {
      rows.push({
        left: null,
        right: null,
        isHeader: true,
        headerText: line.text,
      });
      i++;
      continue;
    }

    if (line.type === 'ctx') {
      rows.push({
        left: {
          type: 'ctx',
          lineNumber: line.oldLineNumber,
          text: line.text,
        },
        right: {
          type: 'ctx',
          lineNumber: line.newLineNumber,
          text: line.text,
        },
      });
      i++;
      continue;
    }

    // Collect consecutive del lines then consecutive add lines in this change cluster
    const dels: UnifiedDiffLine[] = [];
    const adds: UnifiedDiffLine[] = [];

    while (i < lines.length && (lines[i].type === 'del' || lines[i].type === 'add')) {
      if (lines[i].type === 'del') {
        dels.push(lines[i]);
      } else {
        adds.push(lines[i]);
      }
      i++;
    }

    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k++) {
      const del = dels[k];
      const add = adds[k];

      rows.push({
        left: del
          ? {
              type: 'del',
              lineNumber: del.oldLineNumber,
              text: del.text,
            }
          : null,
        right: add
          ? {
              type: 'add',
              lineNumber: add.newLineNumber,
              text: add.text,
            }
          : null,
      });
    }
  }

  return rows;
}
