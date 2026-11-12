import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { executeProjectCreate } from '../projectCreate.js';

describe('executeProjectCreate', () => {
  it('throws when primaryPath is missing or empty', async () => {
    await expect(executeProjectCreate({ name: 'test', primaryPath: '' })).rejects.toThrow(
      'Project primary path is required',
    );
  });

  it('scaffolds directory, IDEA.md, .gitignore, and registers alias', async () => {
    const mockFiles = new Map<string, string>();
    const createdDirs = new Set<string>();
    const mockUpsert = vi.fn().mockResolvedValue(null);
    const mockGit = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const targetDir = '/test/workspace/my-new-app';

    const result = await executeProjectCreate(
      {
        name: 'My New App',
        primaryPath: targetDir,
        ideaText: 'A cutting-edge developer tool',
        initGit: true,
        createIdeaFile: true,
        createGitIgnore: true,
        linkVault: true,
      },
      {
        mkdir: (async (dirPath: any) => {
          createdDirs.add(String(dirPath));
          return undefined;
        }) as any,
        writeFile: (async (filePath: any, content: any) => {
          mockFiles.set(String(filePath), content.toString());
        }) as any,
        stat: (async (p: any) => {
          if (mockFiles.has(String(p))) return {} as any;
          throw new Error('ENOENT');
        }) as any,
        execGit: mockGit,
        upsertAlias: mockUpsert,
        readVault: (() => ({ config: { vaultDir: '/vault/root' } })) as any,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.name).toBe('My New App');
    expect(result.workingDir).toBe(path.resolve(targetDir));
    expect(result.projectKey).toBe(`local:${path.resolve(targetDir)}`);

    // Verify created files
    expect(result.createdFiles).toContain('.git');
    expect(result.createdFiles).toContain('IDEA.md');
    expect(result.createdFiles).toContain('.gitignore');
    expect(result.createdFiles).toContain('vault: Project — My New App.md');

    // Verify git initialization
    expect(mockGit).toHaveBeenCalledWith(['init', '-b', 'main', path.resolve(targetDir)]);

    // Verify IDEA.md content
    const ideaPath = path.join(path.resolve(targetDir), 'IDEA.md');
    expect(mockFiles.get(ideaPath)).toContain('# My New App');
    expect(mockFiles.get(ideaPath)).toContain('A cutting-edge developer tool');

    // Verify alias upsert
    expect(mockUpsert).toHaveBeenCalledWith(`local:${path.resolve(targetDir)}`, 'My New App');

    // Verify vault note creation
    const vaultNotePath = path.join('/vault/root', 'memory', 'Project — My New App.md');
    expect(mockFiles.get(vaultNotePath)).toContain('# Project — My New App');
  });

  it('defaults name to folder basename when name is omitted', async () => {
    const mockUpsert = vi.fn().mockResolvedValue(null);
    const targetDir = '/test/workspace/auto-named-proj';

    const result = await executeProjectCreate(
      {
        name: '',
        primaryPath: targetDir,
      },
      {
        mkdir: (async () => undefined) as any,
        writeFile: (async () => undefined) as any,
        stat: (async () => {
          throw new Error('ENOENT');
        }) as any,
        upsertAlias: mockUpsert,
        readVault: (() => ({ config: { vaultDir: '' } })) as any,
      },
    );

    expect(result.name).toBe('auto-named-proj');
    expect(mockUpsert).toHaveBeenCalledWith(`local:${path.resolve(targetDir)}`, 'auto-named-proj');
  });

  it('never overwrites an existing IDEA.md or vault project note; reports them as skipped', async () => {
    // A project named like an existing vault note (e.g. "Cindy") must not clobber the owner's
    // curated `memory/Project — Cindy.md`; an existing folder keeps its IDEA.md.
    const fsReal = await import('node:fs/promises');
    const os = await import('node:os');
    const root = await fsReal.mkdtemp(path.join(os.tmpdir(), 'cindy-project-create-'));
    const dir = path.join(root, 'existing');
    const vault = path.join(root, 'vault');
    await fsReal.mkdir(dir, { recursive: true });
    await fsReal.mkdir(path.join(vault, 'memory'), { recursive: true });
    await fsReal.writeFile(path.join(dir, 'IDEA.md'), 'owner idea\n');
    const note = path.join(vault, 'memory', 'Project — Cindy.md');
    await fsReal.writeFile(note, 'curated history\n');

    const result = await executeProjectCreate(
      { name: 'Cindy', primaryPath: dir, ideaText: 'new idea', createIdeaFile: true, linkVault: true },
      { upsertAlias: vi.fn().mockResolvedValue(null), readVault: (() => ({ config: { vaultDir: vault } })) as any },
    );

    expect(result.ok).toBe(true);
    expect(await fsReal.readFile(path.join(dir, 'IDEA.md'), 'utf8')).toBe('owner idea\n');
    expect(await fsReal.readFile(note, 'utf8')).toBe('curated history\n');
    expect(result.createdFiles).not.toContain('IDEA.md');
    expect(result.skippedFiles).toEqual(['IDEA.md (exists)', 'vault: Project — Cindy.md (exists)']);
    await fsReal.rm(root, { recursive: true, force: true });
  });

  it('checks the IPC sender before creating anything', async () => {
    const { registerProjectCreateHandlers } = await import('../projectCreate.js');
    const electron = await import('electron');
    const handle = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(() => undefined as never);
    const assertTrusted = vi.fn(() => {
      throw new Error('untrusted');
    });
    registerProjectCreateHandlers({ assertTrusted });
    const listener = handle.mock.calls.find(([channel]) => channel === 'maker:project:create')![1] as (e: unknown, i: unknown) => Promise<unknown>;
    await expect(listener({ sender: 'x' }, { name: 'x', primaryPath: '/nope/never' })).rejects.toThrow('untrusted');
    expect(assertTrusted).toHaveBeenCalledWith({ sender: 'x' });
    handle.mockRestore();
  });
});
