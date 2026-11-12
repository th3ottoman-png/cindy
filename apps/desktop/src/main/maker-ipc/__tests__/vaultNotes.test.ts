import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { registerVaultNotesHandlers, VaultNotesHost } from '../vaultNotes';
import { IpcHarness } from './helpers/ipcHarness';

let dir: string;
let vaultDir: string;
let configFile: string;
let pinnedNotesConfigFile: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-host-')));
  vaultDir = path.join(dir, 'my-vault');
  configFile = path.join(dir, 'vault.json');
  pinnedNotesConfigFile = path.join(dir, 'pinned-vault-notes.json');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'a.md'), 'Note A\n');
  fs.writeFileSync(path.join(vaultDir, 'b.md'), 'Note B\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('VaultNotesHost relevant ADRs (ROADMAP 11.8)', () => {
  function seed(): { host: VaultNotesHost; repo: string; sessionAdrsFile: string } {
    const sessionAdrsFile = path.join(dir, 'session-adrs.json');
    const host = new VaultNotesHost({ configFile, pinnedNotesConfigFile, sessionAdrsFile });
    host.setConfig(vaultDir);
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'docs', 'decisions'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'docs', 'decisions', '0001-use-sqlite.md'),
      '# ADR 0001 — Use SQLite for the session store\n\n- **Status:** Accepted\n- **Date:** 2026-11-01\n\n## Decision\n\nSQLite.\n',
    );
    fs.mkdirSync(path.join(vaultDir, 'Cindy', 'Decisions'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'Cindy', 'Decisions', '2026-11-02-gateway-per-session.md'),
      '# ADR — Hermes gateway runs per session\n\n- **Status:** Accepted\n\n## Decision\n\nOne gateway each.\n',
    );
    return { host, repo, sessionAdrsFile };
  }

  it('matches the first prompt, returns a titles block and records it for the manifest', async () => {
    const { host, repo } = seed();
    try {
      const preamble = host.resolveRelevantAdrsPreamble({
        sessionId: 'sess-1',
        prompt: 'Should we replace SQLite with Postgres?',
        workingDir: repo,
      });
      expect(preamble).toContain('[Relevant past decisions (ADRs)]');
      expect(preamble).toContain(
        'Use SQLite for the session store (Accepted) — docs/decisions/0001-use-sqlite.md',
      );
      expect(preamble).not.toContain('gateway');

      const harness = new IpcHarness();
      registerVaultNotesHandlers(harness, { host, broadcast: vi.fn(), assertTrusted: vi.fn() });
      expect(await harness.invoke(MAKER_INVOKE.VAULT_GET_SESSION_ADRS, 'sess-1')).toEqual({
        workspaceDir: repo,
        adrs: [
          {
            title: 'Use SQLite for the session store',
            path: 'docs/decisions/0001-use-sqlite.md',
            source: 'repo',
            status: 'Accepted',
            date: '2026-11-01',
          },
        ],
      });
      expect(await harness.invoke(MAKER_INVOKE.VAULT_GET_SESSION_ADRS, 'other')).toEqual({
        adrs: [],
      });
    } finally {
      host.close();
    }
  });

  it('injects nothing for an unrelated prompt but still remembers the workspace', () => {
    const { host, repo } = seed();
    try {
      expect(
        host.resolveRelevantAdrsPreamble({
          sessionId: 'sess-2',
          prompt: 'Write a haiku',
          workingDir: repo,
        }),
      ).toBe('');
      expect(host.getSessionAdrs('sess-2')).toEqual({ workspaceDir: repo, adrs: [] });
    } finally {
      host.close();
    }
  });

  it('notifies once the session record is written, so the manifest strip can refresh', () => {
    const notifySessionAdrsChanged = vi.fn();
    const sessionAdrsFile = path.join(dir, 'session-adrs.json');
    const host = new VaultNotesHost({
      configFile,
      pinnedNotesConfigFile,
      sessionAdrsFile,
      notifySessionAdrsChanged,
    });
    try {
      host.resolveRelevantAdrsPreamble({ sessionId: 'sess-3', prompt: 'Write a haiku' });
      expect(notifySessionAdrsChanged).toHaveBeenCalledTimes(1);
      expect(notifySessionAdrsChanged).toHaveBeenCalledWith('sess-3');
      expect(fs.existsSync(sessionAdrsFile)).toBe(true);
    } finally {
      host.close();
    }
  });

  it('fails open: an unwritable record file never throws into the turn', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const host = new VaultNotesHost({
      configFile,
      sessionAdrsFile: path.join(blocker, 'session-adrs.json'),
    });
    try {
      expect(host.resolveRelevantAdrsPreamble({ sessionId: 's', prompt: 'sqlite store' })).toBe('');
    } finally {
      host.close();
    }
  });
});

describe('VaultNotesHost (ROADMAP 5.1)', () => {
  it('reads empty config when file does not exist', () => {
    const host = new VaultNotesHost({ configFile });
    const view = host.getConfig();
    expect(view).toEqual({ vaultDir: '' });
  });

  it('sets and gets valid vault config with noteCount', () => {
    const notifyChanged = vi.fn();
    const host = new VaultNotesHost({ configFile, notifyChanged });
    const view = host.setConfig(vaultDir);

    expect(notifyChanged).toHaveBeenCalledOnce();
    expect(view.vaultDir).toBe(vaultDir);
    expect(view.noteCount).toBe(2);
    expect(view.issue).toBeUndefined();

    // Verify persisted file
    const content = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(content.vaultDir).toBe(vaultDir);
  });

  it('reports issue when directory does not exist', () => {
    const missing = path.join(dir, 'non-existent');
    const host = new VaultNotesHost({ configFile });
    const view = host.setConfig(missing);

    expect(view.vaultDir).toBe(missing);
    expect(view.issue).toContain('does not exist');
    expect(view.noteCount).toBeUndefined();
  });

  it('picks folder using showOpenDialog', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: [vaultDir],
    });
    const host = new VaultNotesHost({ configFile, showOpenDialog });

    const picked = await host.pickFolder();
    expect(picked).toBe(vaultDir);
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory'],
    });
  });

  it('returns null when picker is canceled', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: true,
      filePaths: [],
    });
    const host = new VaultNotesHost({ configFile, showOpenDialog });

    const picked = await host.pickFolder();
    expect(picked).toBeNull();
  });

  it('watches configured vault directory and notifies on changes', async () => {
    const notifyChanged = vi.fn();
    const host = new VaultNotesHost({ configFile, notifyChanged, watchDebounceMs: 20 });
    try {
      host.setConfig(vaultDir);
      notifyChanged.mockClear();

      // Add a note in vault
      fs.writeFileSync(path.join(vaultDir, 'c.md'), 'Note C\n');
      await vi.waitFor(() => {
        expect(notifyChanged).toHaveBeenCalled();
      }, { timeout: 3000 });

      expect(host.getConfig().noteCount).toBe(3);
    } finally {
      host.close();
    }
  });

  it('registers and handles IPC channels', async () => {
    const harness = new IpcHarness();
    const host = new VaultNotesHost({
      configFile,
      pinnedNotesConfigFile,
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [vaultDir] }),
    });
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    registerVaultNotesHandlers(harness, { host, broadcast, assertTrusted });

    // Initial get
    const initial = await harness.invoke(MAKER_INVOKE.VAULT_GET_CONFIG);
    expect(initial).toEqual({ vaultDir: '' });

    // Set config
    const updated = await harness.invoke(MAKER_INVOKE.VAULT_SET_CONFIG, { vaultDir });
    expect(updated).toMatchObject({ vaultDir, noteCount: 2 });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.VAULT_CHANGED, expect.objectContaining({ vaultDir }));

    // Set allSessionsSearch via IPC
    const withSearch = await harness.invoke(MAKER_INVOKE.VAULT_SET_CONFIG, { allSessionsSearch: true });
    expect(withSearch).toMatchObject({ vaultDir, allSessionsSearch: true, noteCount: 2 });
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.VAULT_CHANGED, expect.objectContaining({ allSessionsSearch: true }));

    // Pick folder
    const picked = await harness.invoke(MAKER_INVOKE.VAULT_PICK_FOLDER);
    expect(picked).toBe(vaultDir);

    // Synthesize memory
    const memoryDir = path.join(vaultDir, 'Cindy', 'Memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, '2026-11-08-task1-summary.md'),
      `---
session_id: "s1"
title: "Task One"
---
## Overview
Synthesize test overview.
## Decisions & Rationale
- Decided on IPC test
`,
    );

    const synthRes = (await harness.invoke(MAKER_INVOKE.VAULT_SYNTHESIZE_MEMORY, { limit: 10 })) as {
      ok: boolean;
      sourcesCount: number;
      relPath: string;
    };
    expect(synthRes.ok).toBe(true);
    expect(synthRes.sourcesCount).toBe(1);
    expect(synthRes.relPath).toBe('Cindy/Memory/Synthesis.md');
    expect(fs.existsSync(path.join(vaultDir, 'Cindy', 'Memory', 'Synthesis.md'))).toBe(true);

    // Get graph index
    const graphRes = (await harness.invoke(MAKER_INVOKE.VAULT_GET_GRAPH)) as {
      ok: boolean;
      graph?: { totalNotes: number; nodes: Record<string, unknown> };
    };
    expect(graphRes.ok).toBe(true);
    expect(graphRes.graph?.totalNotes).toBeGreaterThan(0);
    expect(graphRes.graph?.nodes['Cindy/Memory/Synthesis.md']).toBeDefined();

    // Quick capture
    const captureRes = (await harness.invoke(MAKER_INVOKE.VAULT_QUICK_CAPTURE, {
      content: 'Quick note content',
      title: 'Captured Item',
      tags: ['quick', 'ipc'],
    })) as { ok: boolean; relPath?: string };
    expect(captureRes.ok).toBe(true);
    expect(captureRes.relPath).toBe('Inbox.md');
    expect(fs.readFileSync(path.join(vaultDir, 'Inbox.md'), 'utf8')).toContain('Quick note content');

    // Pinning via IPC
    const pinRes = (await harness.invoke(MAKER_INVOKE.VAULT_PIN_NOTE, {
      sessionId: 'sess-1',
      notePath: 'a.md',
    })) as { ok: boolean; pinnedNotes: string[] };
    expect(pinRes.ok).toBe(true);
    expect(pinRes.pinnedNotes).toEqual(['a.md']);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.VAULT_PINNED_CHANGED, {
      sessionId: 'sess-1',
      pinnedNotes: ['a.md'],
    });

    // Get pinned notes
    const pinned = await harness.invoke(MAKER_INVOKE.VAULT_GET_PINNED_NOTES, 'sess-1');
    expect(pinned).toEqual(['a.md']);

    // Preamble formatting on host
    const preamble = host.getPinnedNotesPreamble('sess-1');
    expect(preamble).toContain('[Pinned Vault Note: a.md]');
    expect(preamble).toContain('Note A');

    // Unpin via IPC
    const unpinRes = (await harness.invoke(MAKER_INVOKE.VAULT_UNPIN_NOTE, {
      sessionId: 'sess-1',
      notePath: 'a.md',
    })) as { ok: boolean; pinnedNotes: string[] };
    expect(unpinRes.ok).toBe(true);
    expect(unpinRes.pinnedNotes).toEqual([]);

    // Hybrid search via IPC (ROADMAP 7.3)
    const searchRes = (await harness.invoke(MAKER_INVOKE.VAULT_SEARCH_NOTES, {
      query: 'Note A',
    })) as Array<{ path: string; matchType?: string }>;
    expect(Array.isArray(searchRes)).toBe(true);
    expect(searchRes.some((h) => h.path === 'a.md')).toBe(true);

    // Index embeddings via IPC (ROADMAP 7.3)
    const indexRes = (await harness.invoke(MAKER_INVOKE.VAULT_INDEX_EMBEDDINGS)) as {
      indexed: number;
      skipped: number;
      pruned: number;
    };
    expect(indexRes).toBeDefined();
    expect(typeof indexRes.indexed).toBe('number');

    // Git sync inspect via IPC (ROADMAP 7.4)
    const fakeGitExec = vi.fn(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: '/Users/turko/projects/Cindy\n', stderr: '', exitCode: 0 };
      if (args.includes('--abbrev-ref')) return { stdout: 'feat/test\n', stderr: '', exitCode: 0 };
      if (args.includes('log')) return { stdout: 'c123456\tfeat: initial work\tTester\t2026-11-10\n', stderr: '', exitCode: 0 };
      if (args.includes('status')) return { stdout: ' M src/app.ts\n?? new.ts\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const hostWithGit = new VaultNotesHost({
      configFile,
      gitExecFn: fakeGitExec as any,
    });
    const harnessWithGit = new IpcHarness();
    registerVaultNotesHandlers(harnessWithGit, {
      host: hostWithGit,
      assertTrusted,
      broadcast,
    });

    const inspectRes = (await harnessWithGit.invoke(MAKER_INVOKE.VAULT_GIT_SYNC_INSPECT)) as {
      ok: boolean;
      inspection?: { projectName: string; branch: string; recentCommits: Array<{ hash: string }> };
      targetNotePath?: string;
    };
    expect(inspectRes.ok).toBe(true);
    expect(inspectRes.inspection?.projectName).toBe('Cindy');
    expect(inspectRes.inspection?.branch).toBe('feat/test');
    expect(inspectRes.targetNotePath).toBe('memory/Project — Cindy.md');

    // Git sync apply via IPC (ROADMAP 7.4)
    const applyRes = (await harnessWithGit.invoke(MAKER_INVOKE.VAULT_GIT_SYNC_APPLY, {
      summaryNote: 'Verified IPC auto-sync',
    })) as { ok: boolean; path?: string; created?: boolean };
    expect(applyRes.ok).toBe(true);
    expect(applyRes.path).toBe('memory/Project — Cindy.md');
    expect(applyRes.created).toBe(true);

    const savedContent = fs.readFileSync(path.join(vaultDir, 'memory/Project — Cindy.md'), 'utf8');
    expect(savedContent).toContain('Verified IPC auto-sync');
    expect(savedContent).toContain('c123456');

    expect(assertTrusted).toHaveBeenCalledTimes(14);
  });
});

