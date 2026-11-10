/**
 * Git Workspace ↔ Vault Project Note Auto-Sync (ROADMAP 7.4).
 *
 * Pure logic for:
 * 1. Resolving project name from workspace git directory.
 * 2. Matching workspace project name to an existing vault project note in `<vault>/memory/Project — <Name>.md`.
 * 3. Parsing `git log --oneline` and `git status --porcelain` into structured summaries.
 * 4. Formatting a dated Markdown progress section with commit log, working tree status, and optional progress summary.
 * 5. Appending atomically to the project note via `appendNote`.
 */

import * as path from 'node:path';
import { appendNote, type NoteError } from './vault-notes.js';

export interface GitCommitLogItem {
  hash: string;
  message: string;
  author?: string;
  date?: string;
}

export interface GitStatusItem {
  path: string;
  status: 'staged' | 'modified' | 'untracked' | 'deleted' | 'renamed';
}

export interface GitWorkspaceInspection {
  projectName: string;
  workspaceDir: string;
  branch: string;
  recentCommits: GitCommitLogItem[];
  staged: GitStatusItem[];
  modified: GitStatusItem[];
  untracked: GitStatusItem[];
  totalDirty: number;
}

export interface MatchedProjectNote {
  notePath: string;
  noteTitle: string;
  matchType: 'exact' | 'heuristic' | 'default';
}

/**
 * Extracts the project name from a workspace directory path.
 * Normalizes separators and strips trailing slashes before taking the basename.
 */
export function resolveProjectName(workspacePath: string): string {
  if (!workspacePath || typeof workspacePath !== 'string') {
    return 'Project';
  }
  const clean = workspacePath.trim().replace(/[/\\]+$/, '');
  const base = path.posix.basename(clean.replace(/\\/g, '/'));
  return base || 'Project';
}

/**
 * Parses raw `git log --oneline` output into structured commit items.
 * Accepts formats:
 * - `<hash> <message>`
 * - `<hash>\t<message>\t<author>\t<date>`
 */
export function parseGitLogOneline(output: string, maxCommits = 10): GitCommitLogItem[] {
  if (!output || typeof output !== 'string') return [];
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const commits: GitCommitLogItem[] = [];

  for (const line of lines) {
    if (commits.length >= maxCommits) break;
    if (line.includes('\t')) {
      const parts = line.split('\t');
      const hash = parts[0]?.trim() ?? '';
      const message = parts[1]?.trim() ?? '';
      const author = parts[2]?.trim();
      const date = parts[3]?.trim();
      if (hash) {
        commits.push({ hash, message, ...(author ? { author } : {}), ...(date ? { date } : {}) });
      }
    } else {
      const match = line.match(/^([a-f0-9]+)\s+(.+)$/i);
      if (match && match[1] && match[2]) {
        commits.push({ hash: match[1], message: match[2].trim() });
      }
    }
  }

  return commits;
}

/**
 * Parses `git status --porcelain=v1` or short status into structured file categories.
 */
export function parseGitStatusShort(output: string): {
  staged: GitStatusItem[];
  modified: GitStatusItem[];
  untracked: GitStatusItem[];
  totalDirty: number;
} {
  const staged: GitStatusItem[] = [];
  const modified: GitStatusItem[] = [];
  const untracked: GitStatusItem[] = [];

  if (!output || typeof output !== 'string') {
    return { staged, modified, untracked, totalDirty: 0 };
  }

  const lines = output.split(/\r?\n/).filter((l) => l.length >= 3);

  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    const filePath = line.slice(3).trim();

    if (x === '?' && y === '?') {
      untracked.push({ path: filePath, status: 'untracked' });
      continue;
    }

    // X indicates staged index status
    if (x && x !== ' ' && x !== '?') {
      const status = x === 'D' ? 'deleted' : x === 'R' ? 'renamed' : 'staged';
      staged.push({ path: filePath, status });
    }

    // Y indicates working tree status
    if (y && y !== ' ' && y !== '?') {
      const status = y === 'D' ? 'deleted' : 'modified';
      modified.push({ path: filePath, status });
    }
  }

  const totalDirty = staged.length + modified.length + untracked.length;
  return { staged, modified, untracked, totalDirty };
}

/**
 * Normalizes project name for loose matching (lowercase, strip dashes, underscores, spaces).
 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Matches a workspace project name against available notes in the vault.
 * Priority:
 * 1. Exact match for `memory/Project — <Name>.md` (with em-dash \u2014)
 * 2. Exact match for `memory/Project - <Name>.md` (with hyphen)
 * 3. Exact match for `memory/Project – <Name>.md` (with en-dash \u2013)
 * 4. Exact match for `Project — <Name>.md`
 * 5. Heuristic match inside `memory/` where title or filename matches project slug
 * 6. Default to `memory/Project — <Name>.md`
 */
export function matchVaultProjectNote(vaultNotePaths: string[], projectName: string): MatchedProjectNote {
  const rawName = projectName.trim();
  const normalizedCandidate = normalizeName(rawName);

  // 1-4: Exact candidate filenames
  const exactPatterns = [
    `memory/Project — ${rawName}.md`,
    `memory/Project - ${rawName}.md`,
    `memory/Project – ${rawName}.md`,
    `Project — ${rawName}.md`,
    `memory/${rawName}.md`,
  ];

  for (const pat of exactPatterns) {
    const found = vaultNotePaths.find((p) => p.toLowerCase() === pat.toLowerCase());
    if (found) {
      return {
        notePath: found,
        noteTitle: path.posix.basename(found, '.md'),
        matchType: 'exact',
      };
    }
  }

  // 5: Heuristic scan in memory/ or root: slug inclusion or matching
  for (const p of vaultNotePaths) {
    const base = path.posix.basename(p, '.md');
    const normBase = normalizeName(base);
    if (
      normBase.includes(normalizedCandidate) ||
      (normalizedCandidate.length >= 4 && normalizedCandidate.includes(normBase))
    ) {
      return {
        notePath: p,
        noteTitle: base,
        matchType: 'heuristic',
      };
    }
  }

  // 6: Default fallback
  const defaultPath = `memory/Project — ${rawName}.md`;
  return {
    notePath: defaultPath,
    noteTitle: `Project — ${rawName}`,
    matchType: 'default',
  };
}

/**
 * Formats a dated markdown section summarizing recent git activity.
 */
export function formatGitProgressBlock(
  inspection: GitWorkspaceInspection,
  opts: { summaryNote?: string; maxCommits?: number; now?: Date } = {},
): string {
  const stamp = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const maxCommits = opts.maxCommits ?? 5;
  const commits = inspection.recentCommits.slice(0, maxCommits);

  const lines: string[] = [];
  lines.push(`### Progress (${stamp})`);
  lines.push('');
  lines.push(`- **Workspace:** \`${inspection.projectName}\` (\`${inspection.branch || 'HEAD'}\`)`);

  if (commits.length > 0) {
    lines.push('- **Recent Commits:**');
    for (const c of commits) {
      lines.push(`  - \`${c.hash}\` ${c.message}`);
    }
  } else {
    lines.push('- **Recent Commits:** *(none recorded)*');
  }

  const dirtyParts: string[] = [];
  if (inspection.modified.length > 0) dirtyParts.push(`${inspection.modified.length} modified`);
  if (inspection.staged.length > 0) dirtyParts.push(`${inspection.staged.length} staged`);
  if (inspection.untracked.length > 0) dirtyParts.push(`${inspection.untracked.length} untracked`);

  if (dirtyParts.length > 0) {
    lines.push(`- **Working Tree:** ${dirtyParts.join(', ')}`);
  } else {
    lines.push('- **Working Tree:** Clean');
  }

  if (opts.summaryNote?.trim()) {
    lines.push(`- **Summary:** ${opts.summaryNote.trim()}`);
  }

  return lines.join('\n');
}

/**
 * Appends formatted git progress entry to the resolved project note in the vault.
 */
export function syncGitProgressToVault(
  vaultDir: string,
  inspection: GitWorkspaceInspection,
  opts: {
    targetNotePath?: string;
    summaryNote?: string;
    now?: Date;
    maxCommits?: number;
  } = {},
): { ok: true; path: string; created: boolean; block: string } | NoteError {
  const targetRel = opts.targetNotePath?.trim() || `memory/Project — ${inspection.projectName}.md`;
  const block = formatGitProgressBlock(inspection, {
    summaryNote: opts.summaryNote,
    maxCommits: opts.maxCommits,
    now: opts.now,
  });

  const appendRes = appendNote(vaultDir, targetRel, block, { now: opts.now });
  if (!appendRes.ok) {
    return appendRes;
  }

  return {
    ok: true,
    path: appendRes.path,
    created: appendRes.created,
    block,
  };
}
