import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AutoReviewGate, type AutoReviewHookPayload } from '../auto-review-gate.js';
import {
  AUTO_REVIEW_HOOK_SCRIPT_FILE,
  parsePythonShebang,
  parseShellExecTarget,
  prepareAutoReviewHookArgv,
  resolveHermesInterpreter,
  writeHookScript,
  type InterpreterProbeIo,
} from '../auto-review-hook-python.js';

const tmpDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
function tmpDir(): string {
  // Short base: unix socket paths are limited to ~104 bytes on macOS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** A fake filesystem of entry scripts: path -> first bytes. */
function fakeIo(files: Record<string, string>, onPath: Record<string, string> = {}): InterpreterProbeIo {
  return {
    async readHead(file) {
      const head = files[file];
      if (head === undefined) throw new Error(`ENOENT ${file}`);
      return head;
    },
    async which(name) {
      return onPath[name];
    },
  };
}

describe('shebang and wrapper parsing', () => {
  it('reads a direct python shebang and the env form', () => {
    expect(parsePythonShebang('#!/opt/h/venv/bin/python3.14')).toEqual(['/opt/h/venv/bin/python3.14']);
    expect(parsePythonShebang('#!/usr/bin/env python3')).toEqual(['/usr/bin/env', 'python3']);
  });

  it('rejects non-python, relative and missing shebangs', () => {
    expect(parsePythonShebang('#!/bin/sh')).toBeUndefined();
    expect(parsePythonShebang('#!/usr/bin/env node')).toBeUndefined();
    expect(parsePythonShebang('#!python3')).toBeUndefined();
    expect(parsePythonShebang('print(1)')).toBeUndefined();
    expect(parsePythonShebang('#!')).toBeUndefined();
  });

  it('finds the exec target of a small sh wrapper', () => {
    expect(parseShellExecTarget('#!/bin/sh\nexec /opt/h/bin/hermes "$@"\n')).toBe('/opt/h/bin/hermes');
    expect(parseShellExecTarget('#!/bin/bash\nset -e\nexec "/opt/h x/hermes" "$@"')).toBe('/opt/h x/hermes');
    expect(parseShellExecTarget('#!/bin/sh\nexec hermes "$@"')).toBeUndefined();
    expect(parseShellExecTarget('#!/opt/h/venv/bin/python3\nexec /x')).toBeUndefined();
  });
});

describe('resolveHermesInterpreter', () => {
  it('follows PATH -> sh wrapper -> python entry script', async () => {
    const io = fakeIo(
      {
        '/bin1/hermes': '#!/bin/sh\nexec /opt/h/bin/hermes "$@"\n',
        '/opt/h/bin/hermes': '#!/opt/h/venv/bin/python3.14\nimport sys\n',
      },
      { hermes: '/bin1/hermes' },
    );
    expect(await resolveHermesInterpreter('hermes', io)).toEqual(['/opt/h/venv/bin/python3.14']);
  });

  it('takes the python an sh wrapper execs directly (Hermes 0.22.7 entry script)', async () => {
    const io = fakeIo(
      {
        '/bin1/hermes': '#!/bin/sh\nexec /opt/h/bin/hermes "$@"\n',
        '/opt/h/bin/hermes': "#!/bin/sh\nexec /opt/h/tools/python-3.14.9/bin/python3 -I -c 'import os'\n",
      },
      { hermes: '/bin1/hermes' },
    );
    expect(await resolveHermesInterpreter('hermes', io)).toEqual(['/opt/h/tools/python-3.14.9/bin/python3']);
  });

  it('accepts an absolute hermes binary without a PATH lookup', async () => {
    const io = fakeIo({ '/opt/h/bin/hermes': '#!/usr/bin/env python3\n' });
    expect(await resolveHermesInterpreter('/opt/h/bin/hermes', io)).toEqual(['/usr/bin/env', 'python3']);
  });

  it('gives up on a missing binary, an unreadable file, a non-python script, and a wrapper loop', async () => {
    expect(await resolveHermesInterpreter('hermes', fakeIo({}))).toBeUndefined();
    expect(await resolveHermesInterpreter('hermes', fakeIo({}, { hermes: '/gone/hermes' }))).toBeUndefined();
    expect(await resolveHermesInterpreter('/x/hermes', fakeIo({ '/x/hermes': '#!/usr/bin/env node\n' }))).toBeUndefined();
    const loop = fakeIo({ '/a': '#!/bin/sh\nexec /b "$@"', '/b': '#!/bin/sh\nexec /a "$@"' });
    expect(await resolveHermesInterpreter('/a', loop)).toBeUndefined();
  });
});

describe('prepareAutoReviewHookArgv', () => {
  const io = fakeIo({ '/opt/h/bin/hermes': '#!/opt/h/venv/bin/python3.14\n' });

  it('writes the script (0700) and returns the python argv', async () => {
    const stateDir = path.join(tmpDir(), 'state');
    const argv = await prepareAutoReviewHookArgv({
      hermesBin: '/opt/h/bin/hermes',
      stateDir,
      bundlePath: '/b/hermes-mgr.mjs',
      io,
    });
    const script = path.join(stateDir, AUTO_REVIEW_HOOK_SCRIPT_FILE);
    expect(argv).toEqual(['/opt/h/venv/bin/python3.14', '-I', script]);
    expect(fs.readFileSync(script, 'utf8')).toContain('Cindy auto-review hook for Hermes');
    if (process.platform !== 'win32') expect(fs.statSync(script).mode & 0o777).toBe(0o700);
  });

  it('falls back to the node hook when no interpreter is found', async () => {
    const logs: string[] = [];
    const argv = await prepareAutoReviewHookArgv({
      hermesBin: 'hermes',
      stateDir: tmpDir(),
      bundlePath: '/b/hermes-mgr.mjs',
      io: fakeIo({}),
      log: (m) => logs.push(m),
    });
    expect(argv).toEqual(['node', '/b/hermes-mgr.mjs', '--auto-review-hook']);
    expect(logs[0]).toContain('using node');
  });

  it('falls back to the node hook when the script cannot be written', async () => {
    const blocker = path.join(tmpDir(), 'file');
    fs.writeFileSync(blocker, 'x');
    const argv = await prepareAutoReviewHookArgv({
      hermesBin: '/opt/h/bin/hermes',
      stateDir: path.join(blocker, 'sub'),
      bundlePath: '/b/hermes-mgr.mjs',
      io,
    });
    expect(argv[0]).toBe('node');
  });
});

function pythonAvailable(): string | undefined {
  try {
    const out = execFileSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 8))'], { encoding: 'utf8' });
    return out.trim() === 'True' ? 'python3' : undefined;
  } catch {
    return undefined;
  }
}
const PYTHON = pythonAvailable();

const payload = (): Record<string, unknown> => ({
  hook_event_name: 'pre_tool_call',
  tool_name: 'terminal',
  tool_input: { command: 'ls' },
  session_id: 'local-abc',
  cwd: '/opt/hermes',
  extra: { tool_call_id: 'call_1' },
});

function runHook(
  script: string,
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      PYTHON!,
      ['-I', script, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env }, timeout: 20_000 },
      (error, stdout) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? -1 : 0;
        resolve({ stdout, code });
      },
    );
    child.stdin!.end(stdin);
  });
}

describe.skipIf(!PYTHON)('the python hook against a real gate', () => {
  async function setup(
    handler: (sessionId: string, p: AutoReviewHookPayload) => Promise<{ decision: 'allow' | 'block'; reason?: string }>,
  ) {
    const dir = tmpDir();
    const script = path.join(dir, AUTO_REVIEW_HOOK_SCRIPT_FILE);
    await writeHookScript(script);
    const gate = new AutoReviewGate({ socketPath: path.join(dir, 'g.sock'), handler });
    await gate.start();
    cleanups.push(() => gate.stop());
    const writeCreds = (token: string, socketPath = gate.socketPath): string => {
      const file = path.join(dir, 'auto-review.json');
      fs.writeFileSync(file, JSON.stringify({ socketPath, token }), { mode: 0o600 });
      return file;
    };
    return { dir, script, gate, writeCreds };
  }

  it('allows: prints {} and exits 0; the handler sees the session and tool', async () => {
    const seen: Array<[string, AutoReviewHookPayload]> = [];
    const { script, gate, writeCreds } = await setup(async (sid, p) => {
      seen.push([sid, p]);
      return { decision: 'allow' };
    });
    const creds = writeCreds(gate.registerTurn('cindy-1').token);
    const out = await runHook(script, ['--credentials', creds], JSON.stringify(payload()));
    expect(out).toEqual({ stdout: '{}', code: 0 });
    expect(seen[0]![0]).toBe('cindy-1');
    expect(seen[0]![1]).toEqual(expect.objectContaining({ toolName: 'terminal', toolInput: { command: 'ls' } }));
  });

  it('blocks with the reviewer reason and exit 2', async () => {
    const { script, gate, writeCreds } = await setup(async () => ({ decision: 'block', reason: 'outside the project' }));
    const creds = writeCreds(gate.registerTurn('s').token);
    const out = await runHook(script, ['--credentials', creds], JSON.stringify(payload()));
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout)).toEqual({ decision: 'block', reason: 'outside the project' });
  });

  it('works from the env alone (fallback) and prefers the credentials file when both exist', async () => {
    const { script, gate, writeCreds } = await setup(async () => ({ decision: 'allow' }));
    const turn = gate.registerTurn('s');
    const viaEnv = await runHook(script, [], JSON.stringify(payload()), turn.env);
    expect(viaEnv).toEqual({ stdout: '{}', code: 0 });
    const creds = writeCreds(turn.token);
    const both = await runHook(script, ['--credentials', creds], JSON.stringify(payload()), {
      ...turn.env,
      CINDY_HERMES_REVIEW_TOKEN: 'stale',
    });
    expect(both).toEqual({ stdout: '{}', code: 0 });
  });

  it('fails closed: unknown token, no credentials, bad stdin, unreachable socket, handler error', async () => {
    const { script, gate, writeCreds, dir } = await setup(async () => {
      throw new Error('reviewer exploded');
    });
    const unknown = await runHook(script, ['--credentials', writeCreds('nope')], JSON.stringify(payload()));
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout).reason).toContain('not registered');

    const none = await runHook(script, [], JSON.stringify(payload()));
    expect(none.code).toBe(2);
    expect(JSON.parse(none.stdout).reason).toContain('not connected');

    const creds = writeCreds(gate.registerTurn('s').token);
    const garbage = await runHook(script, ['--credentials', creds], 'not json');
    expect(garbage.code).toBe(2);
    expect(JSON.parse(garbage.stdout).reason).toContain('could not read');

    const errored = await runHook(script, ['--credentials', creds], JSON.stringify(payload()));
    expect(errored.code).toBe(2);
    expect(JSON.parse(errored.stdout).decision).toBe('block');

    const gone = writeCreds('t', path.join(dir, 'missing.sock'));
    const unreachable = await runHook(script, ['--credentials', gone], JSON.stringify(payload()));
    expect(unreachable.code).toBe(2);
    expect(JSON.parse(unreachable.stdout).reason).toContain('unreachable');
  });
});
