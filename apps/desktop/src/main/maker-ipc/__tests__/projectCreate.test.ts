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
});
