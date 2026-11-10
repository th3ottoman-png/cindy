import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatGitProgressBlock,
  matchVaultProjectNote,
  parseGitLogOneline,
  parseGitStatusShort,
  resolveProjectName,
  syncGitProgressToVault,
  type GitWorkspaceInspection,
} from '../vault-git-sync.js';

describe('vault-git-sync', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-git-sync-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpVault, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('resolveProjectName', () => {
    it('extracts basename from posix path', () => {
      expect(resolveProjectName('/Users/turko/projects/Cindy')).toBe('Cindy');
      expect(resolveProjectName('/home/antigravity/cindy/')).toBe('cindy');
    });

    it('handles Windows backslashes and trailing slashes', () => {
      expect(resolveProjectName('C:\\Workspace\\MyProject\\\\')).toBe('MyProject');
    });

    it('falls back to default for empty input', () => {
      expect(resolveProjectName('')).toBe('Project');
    });
  });

  describe('parseGitLogOneline', () => {
    it('parses standard git log oneline output', () => {
      const log = [
        'e1078cd docs(handoff): add cloud next-agent takeover prompt',
        '379b4e1 feat(vault): local semantic and hybrid search for notes vault',
        'fc62081 docs(roadmap): add 5 benai-mods tasks to Phase 7 and Phase 8',
      ].join('\n');

      const commits = parseGitLogOneline(log);
      expect(commits).toHaveLength(3);
      expect(commits[0]).toEqual({
        hash: 'e1078cd',
        message: 'docs(handoff): add cloud next-agent takeover prompt',
      });
      expect(commits[1]?.hash).toBe('379b4e1');
    });

    it('parses tab-delimited log format and respects limit', () => {
      const log = [
        'a1b2c3d\tfeat: first commit\tAlice\t2026-11-09',
        'd4e5f6g\tfix: second commit\tBob\t2026-11-10',
      ].join('\n');

      const commits = parseGitLogOneline(log, 1);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toEqual({
        hash: 'a1b2c3d',
        message: 'feat: first commit',
        author: 'Alice',
        date: '2026-11-09',
      });
    });

    it('handles empty or blank lines cleanly', () => {
      expect(parseGitLogOneline('')).toEqual([]);
      expect(parseGitLogOneline('\n   \n\n')).toEqual([]);
    });
  });

  describe('parseGitStatusShort', () => {
    it('categorizes staged, modified, and untracked entries', () => {
      const statusOutput = [
        ' M src/index.ts',
        'M  packages/core/api.ts',
        '?? new-file.md',
        ' D deleted-in-worktree.ts',
        'D  deleted-in-index.ts',
        'MM both-staged-and-dirty.ts',
      ].join('\n');

      const res = parseGitStatusShort(statusOutput);
      expect(res.totalDirty).toBe(7); // 1 M + 1 staged + 1 untracked + 1 D + 1 D staged + 2 for MM
      expect(res.modified).toEqual(
        expect.arrayContaining([
          { path: 'src/index.ts', status: 'modified' },
          { path: 'deleted-in-worktree.ts', status: 'deleted' },
          { path: 'both-staged-and-dirty.ts', status: 'modified' },
        ]),
      );
      expect(res.staged).toEqual(
        expect.arrayContaining([
          { path: 'packages/core/api.ts', status: 'staged' },
          { path: 'deleted-in-index.ts', status: 'deleted' },
          { path: 'both-staged-and-dirty.ts', status: 'staged' },
        ]),
      );
      expect(res.untracked).toEqual([{ path: 'new-file.md', status: 'untracked' }]);
    });

    it('handles empty status cleanly', () => {
      const res = parseGitStatusShort('');
      expect(res.totalDirty).toBe(0);
      expect(res.modified).toHaveLength(0);
      expect(res.staged).toHaveLength(0);
      expect(res.untracked).toHaveLength(0);
    });
  });

  describe('matchVaultProjectNote', () => {
    const existingNotes = [
      'memory/Project — Cindy.md',
      'memory/Project - Orca.md',
      'Inbox.md',
      'Architecture.md',
      'memory/WorkBuddy-AI.md',
    ];

    it('matches exact em-dash pattern in memory/', () => {
      const match = matchVaultProjectNote(existingNotes, 'Cindy');
      expect(match.matchType).toBe('exact');
      expect(match.notePath).toBe('memory/Project — Cindy.md');
      expect(match.noteTitle).toBe('Project — Cindy');
    });

    it('matches exact hyphen pattern in memory/', () => {
      const match = matchVaultProjectNote(existingNotes, 'Orca');
      expect(match.matchType).toBe('exact');
      expect(match.notePath).toBe('memory/Project - Orca.md');
    });

    it('heuristically matches project slug in memory/', () => {
      const match = matchVaultProjectNote(existingNotes, 'workbuddy');
      expect(match.matchType).toBe('heuristic');
      expect(match.notePath).toBe('memory/WorkBuddy-AI.md');
    });

    it('defaults to memory/Project — <Name>.md when no match exists', () => {
      const match = matchVaultProjectNote(existingNotes, 'DeepSearch');
      expect(match.matchType).toBe('default');
      expect(match.notePath).toBe('memory/Project — DeepSearch.md');
    });
  });

  describe('formatGitProgressBlock', () => {
    const mockInspection: GitWorkspaceInspection = {
      projectName: 'Cindy',
      workspaceDir: '/path/to/cindy',
      branch: 'main',
      recentCommits: [
        { hash: 'e1078cd', message: 'feat: quick switcher' },
        { hash: 'a2b3c4d', message: 'fix: edge case' },
      ],
      staged: [],
      modified: [{ path: 'src/app.ts', status: 'modified' }],
      untracked: [{ path: 'temp.txt', status: 'untracked' }],
      totalDirty: 2,
    };

    it('formats a complete markdown progress section', () => {
      const block = formatGitProgressBlock(mockInspection, {
        summaryNote: 'Completed Phase 7.3 semantic search and verified live.',
        now: new Date('2026-11-10T12:00:00Z'),
      });

      expect(block).toContain('### Progress (2026-11-10)');
      expect(block).toContain('- **Workspace:** `Cindy` (`main`)');
      expect(block).toContain('- **Recent Commits:**');
      expect(block).toContain('  - `e1078cd` feat: quick switcher');
      expect(block).toContain('- **Working Tree:** 1 modified, 1 untracked');
      expect(block).toContain('- **Summary:** Completed Phase 7.3 semantic search and verified live.');
    });

    it('formats clean status when working tree is empty', () => {
      const cleanInspection: GitWorkspaceInspection = {
        ...mockInspection,
        staged: [],
        modified: [],
        untracked: [],
        totalDirty: 0,
      };

      const block = formatGitProgressBlock(cleanInspection);
      expect(block).toContain('- **Working Tree:** Clean');
    });
  });

  describe('syncGitProgressToVault', () => {
    it('appends progress entry to project note in vault atomically', () => {
      const inspection: GitWorkspaceInspection = {
        projectName: 'Cindy',
        workspaceDir: '/Users/turko/Cindy',
        branch: 'main',
        recentCommits: [{ hash: 'e1078cd', message: 'docs: cloud migration' }],
        staged: [],
        modified: [{ path: 'README.md', status: 'modified' }],
        untracked: [],
        totalDirty: 1,
      };

      const res = syncGitProgressToVault(tmpVault, inspection, {
        summaryNote: 'All pre-commit gates verified green.',
        now: new Date('2026-11-10T15:30:00Z'),
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.path).toBe('memory/Project — Cindy.md');
      expect(res.created).toBe(true);

      const filePath = path.join(tmpVault, 'memory/Project — Cindy.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('## 2026-11-10T15:30:00.000Z');
      expect(content).toContain('### Progress (2026-11-10)');
      expect(content).toContain('`e1078cd` docs: cloud migration');
      expect(content).toContain('All pre-commit gates verified green.');
    });

    it('preserves existing content when appending again', () => {
      const noteRel = 'memory/Project — Cindy.md';
      const fullPath = path.join(tmpVault, noteRel);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, '# Project: Cindy\n\nExisting roadmap log.\n', 'utf8');

      const inspection: GitWorkspaceInspection = {
        projectName: 'Cindy',
        workspaceDir: '/path/to/cindy',
        branch: 'feat/vault-sync',
        recentCommits: [{ hash: '1234567', message: 'test commit' }],
        staged: [],
        modified: [],
        untracked: [],
        totalDirty: 0,
      };

      const res = syncGitProgressToVault(tmpVault, inspection, {
        targetNotePath: noteRel,
        now: new Date('2026-11-10T16:00:00Z'),
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.created).toBe(false);

      const content = fs.readFileSync(fullPath, 'utf8');
      expect(content).toContain('# Project: Cindy');
      expect(content).toContain('Existing roadmap log.');
      expect(content).toContain('## 2026-11-10T16:00:00.000Z');
      expect(content).toContain('feat/vault-sync');
    });
  });
});
