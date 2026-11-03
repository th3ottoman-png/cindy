import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProjectReaderMcpServer,
  READ_PROJECT_FILE_TOOL,
  SEARCH_PROJECT_TOOL,
  type ProjectReaderMcpDeps,
} from '../projectReaderMcpServer';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-reader-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'Project readme\nsecond line\nthird line\n');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const x = 0;\nconst needle = 1;\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'needle in a dependency\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'needle in git\n');
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=needle-secret\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle outside the project\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function deps(over: Partial<ProjectReaderMcpDeps> = {}): ProjectReaderMcpDeps {
  return {
    getSessionContext: () => ({ agentKind: 'hermes', sessionId: 's1', workingDir: root }),
    sessionMayRead: (id) => id === 's1',
    ...over,
  };
}

async function call(d: ProjectReaderMcpDeps, tool: string, input: Record<string, unknown>) {
  const server = createProjectReaderMcpServer(d);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reader-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    const result = await client.callTool({ name: tool, arguments: input });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

describe('cindy_project_reader (ROADMAP 3.10d)', () => {
  it('offers exactly two read-only tools', async () => {
    const server = createProjectReaderMcpServer(deps());
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'reader-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name).sort()).toEqual([READ_PROJECT_FILE_TOOL, SEARCH_PROJECT_TOOL].sort());
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('reads a project file with line numbers, by relative or in-folder absolute path, in a line window', async () => {
    const rel = await call(deps(), READ_PROJECT_FILE_TOOL, { path: 'src/a.ts' });
    expect(rel.isError).toBe(false);
    expect(rel.body).toMatchObject({ status: 'ok', path: 'src/a.ts', totalLines: 2 });
    expect(rel.body.content).toBe('1|const x = 0;\n2|const needle = 1;');
    const abs = await call(deps(), READ_PROJECT_FILE_TOOL, { path: path.join(root, 'README.md'), offset: 2, limit: 1 });
    expect(abs.body).toMatchObject({ status: 'ok', path: 'README.md', content: '2|second line', truncated: true });
  });

  it('refuses paths outside the folder, symlink escapes, secret files, binaries, folders and missing files', async () => {
    const cases: Array<[string, string]> = [
      ['../outside/secret.txt', 'OUTSIDE_PROJECT'],
      [path.join(outside, 'secret.txt'), 'OUTSIDE_PROJECT'],
      ['link.txt', 'OUTSIDE_PROJECT'],
      ['linkdir/secret.txt', 'OUTSIDE_PROJECT'],
      ['.env', 'SECRET_FILE'],
      ['bin.dat', 'BINARY_FILE'],
      ['src', 'NOT_A_FILE'],
      ['nope.txt', 'NOT_FOUND'],
    ];
    for (const [p, code] of cases) {
      const res = await call(deps(), READ_PROJECT_FILE_TOOL, { path: p });
      expect(res.isError, p).toBe(true);
      expect(res.body, p).toMatchObject({ status: 'refused', errorCode: code });
      expect(JSON.stringify(res.body), p).not.toContain('needle');
    }
  });

  it('searches file text inside the folder only, skipping dependency folders, .git, secret files and symlinks', async () => {
    const res = await call(deps(), SEARCH_PROJECT_TOOL, { text: 'NEEDLE' });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ status: 'ok', truncated: false });
    expect(res.body.matches).toEqual([{ path: 'src/a.ts', line: 2, preview: 'const needle = 1;' }]);
  });

  it('lists files by name, and caps the results', async () => {
    const byName = await call(deps(), SEARCH_PROJECT_TOOL, { name: 'a.ts' });
    expect(byName.body).toMatchObject({ status: 'ok', files: ['src/a.ts'] });
    const all = await call(deps(), SEARCH_PROJECT_TOOL, { max_results: 1 });
    expect(all.body).toMatchObject({ status: 'ok', truncated: true });
    expect(all.body.files).toHaveLength(1);
    const listed = await call(deps(), SEARCH_PROJECT_TOOL, {});
    expect(listed.body.files).toEqual(['README.md', 'bin.dat', 'src/a.ts']);
  });

  it('refuses without a Hermes session, a local folder or the expert opting in', async () => {
    const refusals: Array<[Partial<ProjectReaderMcpDeps>, string]> = [
      [{ getSessionContext: () => undefined }, 'NO_SESSION_CONTEXT'],
      [{ getSessionContext: () => ({ agentKind: 'codex', sessionId: 's1', workingDir: root }) }, 'NO_SESSION_CONTEXT'],
      [{ getSessionContext: () => ({ agentKind: 'hermes', sessionId: 's1', workingDir: root, remoteHostId: 'h1' }) }, 'NO_LOCAL_FOLDER'],
      [{ getSessionContext: () => ({ agentKind: 'hermes', sessionId: 's1', workingDir: '' }) }, 'NO_LOCAL_FOLDER'],
      [{ sessionMayRead: () => false }, 'NOT_PROJECT_READER'],
    ];
    for (const [over, code] of refusals) {
      for (const [tool, input] of [[READ_PROJECT_FILE_TOOL, { path: 'README.md' }], [SEARCH_PROJECT_TOOL, { text: 'readme' }]] as const) {
        const res = await call(deps(over), tool, input);
        expect(res.isError, `${tool} ${code}`).toBe(true);
        expect(res.body, `${tool} ${code}`).toMatchObject({ status: 'refused', errorCode: code });
      }
    }
  });
});
