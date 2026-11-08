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

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-host-')));
  vaultDir = path.join(dir, 'my-vault');
  configFile = path.join(dir, 'vault.json');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'a.md'), 'Note A\n');
  fs.writeFileSync(path.join(vaultDir, 'b.md'), 'Note B\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
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

    expect(assertTrusted).toHaveBeenCalledTimes(5);
  });
});

