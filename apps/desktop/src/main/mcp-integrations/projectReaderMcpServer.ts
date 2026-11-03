/**
 * cindy_project_reader — read-only look at the task folder for a locked Hermes chat
 * (ROADMAP 3.10d, ADR 0009 §7).
 *
 * An expert locked by `toolsets:` (Options first) runs without Hermes' own file tools, because
 * Hermes' `file` toolset bundles read with write. This server gives it two read-only tools,
 * `read_project_file` and `search_project`, limited to the session's local working folder:
 * paths are resolved through symlinks and must stay inside the folder, secret-looking files and
 * binaries are refused, and the walk skips dependency and VCS folders and never follows links.
 * hermesBridgeHost mounts it only for a locked session whose expert.md lists one of the tools in
 * `tools:`, and every call re-checks that binding here, so a session that reaches the route
 * without it fails closed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpProvider } from '@cindy/maker-core';
import { resolveLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

export const CINDY_PROJECT_READER_MCP_SERVER_NAME = 'cindy_project_reader';
export const READ_PROJECT_FILE_TOOL = 'read_project_file';
export const SEARCH_PROJECT_TOOL = 'search_project';

export interface ProjectReaderMcpDeps {
  getSessionContext():
    | Pick<LiziMcpSessionContext, 'agentKind' | 'sessionId' | 'workingDir' | 'remoteHostId'>
    | undefined;
  /** True when the session is bound to an expert whose `tools:` lists this tool. */
  sessionMayRead(sessionId: string, tool: string): boolean;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const DEFAULT_LINES = 400;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const DEFAULT_RESULTS = 50;
const MAX_RESULTS = 200;
const MAX_WALK_ENTRIES = 20_000;
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.build',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
]);

type Refusal = { code: string; message: string };

function reply(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function refused(r: Refusal) {
  return reply({ status: 'refused', errorCode: r.code, message: r.message }, true);
}

/** Files whose content is likely a credential; never read or searched. */
export function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.endsWith('.p12') ||
    lower.endsWith('.pfx') ||
    lower.startsWith('id_rsa') ||
    lower.startsWith('id_ed25519') ||
    lower.startsWith('id_ecdsa') ||
    lower === '.npmrc' ||
    lower === '.netrc'
  );
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The session's folder, or a refusal when the session cannot use this server. */
function resolveRoot(deps: ProjectReaderMcpDeps, tool: string): { root: string } | Refusal {
  const ctx = deps.getSessionContext();
  const sessionId = ctx?.sessionId;
  if (!ctx || ctx.agentKind !== 'hermes' || !sessionId) {
    return { code: 'NO_SESSION_CONTEXT', message: `${tool} only runs inside a Hermes session.` };
  }
  if (!deps.sessionMayRead(sessionId, tool)) {
    return {
      code: 'NOT_PROJECT_READER',
      message: `This session was not started as an expert whose expert.md lists "${tool}" in tools.`,
    };
  }
  if (ctx.remoteHostId || !ctx.workingDir) {
    return { code: 'NO_LOCAL_FOLDER', message: 'This chat has no local project folder to read.' };
  }
  try {
    return { root: fs.realpathSync(ctx.workingDir) };
  } catch {
    return { code: 'NO_LOCAL_FOLDER', message: 'The project folder cannot be opened.' };
  }
}

export function readProjectFile(
  root: string,
  args: { path: string; offset?: number; limit?: number },
): { ok: true; payload: Record<string, unknown> } | { ok: false; refusal: Refusal } {
  const fail = (code: string, message: string) => ({
    ok: false as const,
    refusal: { code, message },
  });
  const requested = path.resolve(root, args.path);
  if (!isInside(root, requested))
    return fail('OUTSIDE_PROJECT', 'Only files inside the project folder can be read.');
  let real: string;
  try {
    real = fs.realpathSync(requested);
  } catch {
    return fail('NOT_FOUND', `No such file: ${args.path}`);
  }
  if (!isInside(root, real))
    return fail('OUTSIDE_PROJECT', 'That path leads outside the project folder.');
  const rel = toPosix(path.relative(root, real));
  if (rel.split('/').some(isSecretFileName))
    return fail('SECRET_FILE', 'Secret-looking files (.env, keys) are not read.');
  const st = fs.statSync(real);
  if (!st.isFile())
    return fail('NOT_A_FILE', `${rel || '.'} is not a file. Use search_project to list files.`);
  if (st.size > MAX_FILE_BYTES) return fail('TOO_LARGE', `${rel} is larger than 2 MB.`);
  const buf = fs.readFileSync(real);
  if (isBinary(buf)) return fail('BINARY_FILE', `${rel} is a binary file.`);

  const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const offset = Math.max(1, Math.floor(args.offset ?? 1));
  const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(args.limit ?? DEFAULT_LINES)));
  const window = lines.slice(offset - 1, offset - 1 + limit);
  const content = window
    .map(
      (line, i) =>
        `${offset + i}|${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line cut]` : line}`,
    )
    .join('\n');
  return {
    ok: true,
    payload: {
      status: 'ok',
      path: rel,
      totalLines: lines.length,
      content,
      truncated: offset > 1 || offset - 1 + limit < lines.length,
    },
  };
}

/** Project files (relative, sorted), skipping dependency/VCS folders, secret files and every symlink. */
function walkProject(root: string): { files: string[]; complete: boolean } {
  const files: string[] = [];
  const stack = [''];
  let seen = 0;
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return { files: files.sort(), complete: false };
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
      } else if (entry.isFile() && !isSecretFileName(entry.name)) {
        files.push(rel);
      }
    }
  }
  return { files: files.sort(), complete: true };
}

export function searchProject(
  root: string,
  args: { text?: string; name?: string; max_results?: number },
): Record<string, unknown> {
  const max = Math.min(MAX_RESULTS, Math.max(1, Math.floor(args.max_results ?? DEFAULT_RESULTS)));
  const walk = walkProject(root);
  const name = args.name?.trim().toLowerCase();
  const candidates = name ? walk.files.filter((f) => f.toLowerCase().includes(name)) : walk.files;
  const text = args.text?.trim().toLowerCase();
  if (!text) {
    return {
      status: 'ok',
      files: candidates.slice(0, max),
      truncated: candidates.length > max || !walk.complete,
    };
  }
  const matches: Array<{ path: string; line: number; preview: string }> = [];
  let truncated = !walk.complete;
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    let buf: Buffer;
    try {
      if (fs.statSync(abs).size > MAX_SEARCH_FILE_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(text)) continue;
      if (matches.length >= max) {
        truncated = true;
        break;
      }
      const preview = lines[i].trim();
      matches.push({
        path: rel,
        line: i + 1,
        preview: preview.length > 300 ? `${preview.slice(0, 300)}…` : preview,
      });
    }
    if (truncated && matches.length >= max) break;
  }
  return { status: 'ok', matches, truncated };
}

const READ_DESCRIPTION = [
  "Read one text file from this chat's project folder (read-only). `path` is relative to the",
  'folder (an absolute path must be inside it). Lines come numbered as "N|text"; use `offset`',
  '(first line, 1-based) and `limit` (default 400, max 2000) to page. Files outside the folder,',
  'secret files (.env, keys) and binaries are refused.',
].join(' ');

const SEARCH_DESCRIPTION = [
  "Search this chat's project folder (read-only). With `text`: lines containing it",
  '(case-insensitive, plain text, not a regex) as {path, line, preview}. With only `name`: file',
  'paths containing it. With neither: list the files. Skips .git, node_modules and similar',
  'folders, secret files and symlinks. `max_results` default 50, max 200.',
].join(' ');

export function createProjectReaderMcpServer(deps: ProjectReaderMcpDeps): McpServer {
  const server = new McpServer({ name: CINDY_PROJECT_READER_MCP_SERVER_NAME, version: '1.0.0' });
  server.tool(
    READ_PROJECT_FILE_TOOL,
    READ_DESCRIPTION,
    {
      path: z.string().describe('File path, relative to the project folder.'),
      offset: z.number().int().optional().describe('First line to return, 1-based. Default 1.'),
      limit: z.number().int().optional().describe('Number of lines. Default 400, max 2000.'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      const root = resolveRoot(deps, READ_PROJECT_FILE_TOOL);
      if (!('root' in root)) return refused(root);
      const res = readProjectFile(root.root, args);
      return res.ok ? reply(res.payload) : refused(res.refusal);
    },
  );
  server.tool(
    SEARCH_PROJECT_TOOL,
    SEARCH_DESCRIPTION,
    {
      text: z
        .string()
        .optional()
        .describe('Plain text to find in file contents (case-insensitive).'),
      name: z
        .string()
        .optional()
        .describe('Only files whose path contains this (case-insensitive).'),
      max_results: z.number().int().optional().describe('Default 50, max 200.'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      const root = resolveRoot(deps, SEARCH_PROJECT_TOOL);
      if (!('root' in root)) return refused(root);
      return reply(searchProject(root.root, args));
    },
  );
  return server;
}

/** The provider Hermes' shared tool bridge serves; Pi filters it out by name. */
export function createProjectReaderMcpProvider(
  deps: Omit<ProjectReaderMcpDeps, 'getSessionContext'>,
): McpProvider {
  return {
    name: CINDY_PROJECT_READER_MCP_SERVER_NAME,
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: CINDY_PROJECT_READER_MCP_SERVER_NAME,
      instance: createProjectReaderMcpServer({
        ...deps,
        getSessionContext: () => resolveLiziMcpSessionContext(ctx as LiziMcpSessionContext),
      }),
    }),
  };
}
