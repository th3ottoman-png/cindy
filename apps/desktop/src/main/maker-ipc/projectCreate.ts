/**
 * Project Creation & Scaffolding IPC handler.
 *
 * Implements the backend handler for creating new projects, initializing
 * directories, writing IDEA.md, git initialization, setting project aliases,
 * and linking to the Notes Vault.
 */

import { ipcMain } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { upsertProjectAlias } from '../localDb/ipc/projectAliases.js';
import { readVaultConfig } from '@cindy/maker-core/vault-notes';

const execFileAsync = promisify(execFile);

export interface CreateProjectInput {
  name: string;
  primaryPath: string;
  additionalPaths?: string[];
  ideaText?: string;
  preset?: string;
  agentKind?: string;
  modelRoute?: string;
  initGit?: boolean;
  createIdeaFile?: boolean;
  createGitIgnore?: boolean;
  linkVault?: boolean;
}

export interface CreateProjectResult {
  ok: boolean;
  projectKey: string;
  workingDir: string;
  name: string;
  createdFiles: string[];
  error?: string;
}

export const PROJECT_CREATE_CHANNEL = 'maker:project:create';

export async function executeProjectCreate(
  input: CreateProjectInput,
  deps: {
    mkdir?: typeof fs.mkdir;
    writeFile?: typeof fs.writeFile;
    stat?: typeof fs.stat;
    execGit?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
    upsertAlias?: typeof upsertProjectAlias;
    readVault?: typeof readVaultConfig;
  } = {},
): Promise<CreateProjectResult> {
  const mkdir = deps.mkdir ?? fs.mkdir;
  const writeFile = deps.writeFile ?? fs.writeFile;
  const stat = deps.stat ?? fs.stat;
  const upsertAlias = deps.upsertAlias ?? upsertProjectAlias;
  const readVault = deps.readVault ?? readVaultConfig;

  if (!input.primaryPath || typeof input.primaryPath !== 'string' || !input.primaryPath.trim()) {
    throw new Error('Project primary path is required');
  }

  const resolvedPath = path.resolve(input.primaryPath.trim());
  const projectName = (input.name?.trim() || path.basename(resolvedPath)).slice(0, 80);
  const createdFiles: string[] = [];

  // 1. Ensure directory exists
  await mkdir(resolvedPath, { recursive: true });

  // 2. Initialize Git repo if requested
  if (input.initGit) {
    const gitDir = path.join(resolvedPath, '.git');
    const hasGit = await stat(gitDir).then(() => true).catch(() => false);
    if (!hasGit) {
      try {
        if (deps.execGit) {
          await deps.execGit(['init', '-b', 'main', resolvedPath]);
        } else {
          await execFileAsync('git', ['init', '-b', 'main', resolvedPath]);
        }
        createdFiles.push('.git');
      } catch {
        // Fall back gracefully if git command fails or is unavailable
      }
    }
  }

  // 3. Write IDEA.md if requested
  if (input.createIdeaFile !== false && input.ideaText && input.ideaText.trim()) {
    const ideaPath = path.join(resolvedPath, 'IDEA.md');
    const ideaContent = `# ${projectName}\n\n${input.ideaText.trim()}\n`;
    await writeFile(ideaPath, ideaContent, 'utf8');
    createdFiles.push('IDEA.md');
  }

  // 4. Create .gitignore if requested
  if (input.createGitIgnore) {
    const gitIgnorePath = path.join(resolvedPath, '.gitignore');
    const hasGitIgnore = await stat(gitIgnorePath).then(() => true).catch(() => false);
    if (!hasGitIgnore) {
      const gitIgnoreContent = `node_modules/\n.DS_Store\ndist/\nbuild/\n.env\n.env.local\n*.log\n`;
      await writeFile(gitIgnorePath, gitIgnoreContent, 'utf8');
      createdFiles.push('.gitignore');
    }
  }

  // 5. Register project alias in Cindy DB
  const projectKey = `local:${resolvedPath}`;
  try {
    await upsertAlias(projectKey, projectName);
  } catch {
    // Alias upsert failure does not block project creation
  }

  // 6. Link to Notes Vault if requested
  if (input.linkVault) {
    try {
      const vaultConfigPath = path.join(os.homedir(), '.cindy-harness', 'vault.json');
      const vaultConfig = readVault(vaultConfigPath);
      const vaultDir = vaultConfig?.config?.vaultDir;
      if (vaultDir) {
        const memoryDir = path.join(vaultDir, 'memory');
        await mkdir(memoryDir, { recursive: true });
        const notePath = path.join(memoryDir, `Project — ${projectName}.md`);
        const noteContent = `# Project — ${projectName}\n\n- **Path:** \`${resolvedPath}\`\n- **Created:** ${new Date().toISOString()}\n\n## Scope & Overview\n${input.ideaText?.trim() || 'No initial description provided.'}\n`;
        await writeFile(notePath, noteContent, 'utf8');
        createdFiles.push(`vault: Project — ${projectName}.md`);
      }
    } catch {
      // Vault linking fail-open
    }
  }

  return {
    ok: true,
    projectKey,
    workingDir: resolvedPath,
    name: projectName,
    createdFiles,
  };
}

export function registerProjectCreateHandlers(): void {
  ipcMain.handle(PROJECT_CREATE_CHANNEL, async (_event, input: unknown) => {
    return executeProjectCreate(input as CreateProjectInput);
  });
}
