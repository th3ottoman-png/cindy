/**
 * Imported agents discovery + IPC (ROADMAP 12.1). Real temp directory trees; the watcher is
 * faked (real fs.watch inside a vitest worker risks the threads-pool teardown SIGSEGV,
 * ROADMAP Debt — same convention as expertsHandlers.test.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadExpert } from '@cindy/maker-core/experts';
import type { ImportedAgent } from '@cindy/maker-core/imported-agents';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import {
  IMPORTED_AGENTS_FILE_CAP,
  discoverImportedAgents,
  importedAgentSourceDirs,
  readImportedAgentById,
  registerImportedAgentsHandlers,
  type ImportedAgentsHandlerHandle,
} from '../importedAgents';
import { IpcHarness } from './helpers/ipcHarness';

let home: string;
let project: string;
let experts: string;
let handle: ImportedAgentsHandlerHandle | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'imported-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'imported-project-'));
  experts = fs.mkdtempSync(path.join(os.tmpdir(), 'imported-experts-'));
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  for (const dir of [home, project, experts]) fs.rmSync(dir, { recursive: true, force: true });
});

function writeAgent(dir: string, rel: string, body: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const GOOD = '---\nname: Reviewer\ndescription: Reviews code.\ntools: Read, Grep\n---\nYou review code.\n';

function seed(): void {
  writeAgent(path.join(home, '.claude', 'agents'), 'reviewer.md', GOOD);
  writeAgent(path.join(home, '.qwen', 'agents'), 'architect.md', '---\nname: Architect\ndescription: Designs.\n---\nYou design.\n');
  writeAgent(path.join(project, '.claude', 'agents'), 'local.md', '---\nname: Local\ndescription: Project agent.\n---\nLocal.\n');
  writeAgent(path.join(project, '.qwen', 'agents'), 'qlocal.md', '---\nname: QLocal\ndescription: Qwen project agent.\n---\nQLocal.\n');
}

describe('discoverImportedAgents', () => {
  it('finds all four sources with stable ids', () => {
    seed();
    const { agents, capped } = discoverImportedAgents({ homeDir: home, projectDir: project });
    expect(capped).toBe(false);
    expect(agents.map((a) => a.id)).toEqual([
      `imported:claude-user:reviewer.md`,
      `imported:qwen-user:architect.md`,
      `imported:claude-project:local.md`,
      `imported:qwen-project:qlocal.md`,
    ]);
    expect(agents[0].name).toBe('Reviewer');
    expect(agents[0].absolutePath).toBe(path.join(home, '.claude', 'agents', 'reviewer.md'));
  });

  it('reads one level of sub-folders but no deeper', () => {
    const dir = path.join(home, '.claude', 'agents');
    writeAgent(dir, 'team/nested.md', GOOD);
    writeAgent(dir, 'team/deep/too-deep.md', GOOD);
    const { agents } = discoverImportedAgents({ homeDir: home });
    expect(agents.map((a) => a.relPath)).toEqual(['team/nested.md']);
    expect(agents[0].id).toBe('imported:claude-user:team/nested.md');
  });

  it('skips symlinks that leave the directory', () => {
    const dir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, GOOD);
    fs.symlinkSync(outside, path.join(dir, 'escape.md'));
    const outsideDir = path.join(home, 'outside-dir');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'x.md'), GOOD);
    fs.symlinkSync(outsideDir, path.join(dir, 'escape-dir'));
    writeAgent(dir, 'real.md', GOOD);
    const { agents } = discoverImportedAgents({ homeDir: home });
    expect(agents.map((a) => a.relPath)).toEqual(['real.md']);
  });

  it('keeps symlinks that stay inside the directory', () => {
    const dir = path.join(home, '.claude', 'agents');
    writeAgent(dir, 'real.md', GOOD);
    fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'alias.md'));
    const { agents } = discoverImportedAgents({ homeDir: home });
    expect(agents.map((a) => a.relPath)).toEqual(['alias.md', 'real.md']);
  });

  it('skips dot-files and non-markdown files', () => {
    const dir = path.join(home, '.claude', 'agents');
    writeAgent(dir, '.hidden.md', GOOD);
    writeAgent(dir, 'notes.txt', GOOD);
    writeAgent(dir, 'real.md', GOOD);
    const { agents } = discoverImportedAgents({ homeDir: home });
    expect(agents.map((a) => a.relPath)).toEqual(['real.md']);
  });

  it('lists malformed files with their error instead of crashing', () => {
    const dir = path.join(home, '.claude', 'agents');
    writeAgent(dir, 'bad.md', '---\nname: [unclosed\n---\nBody.');
    writeAgent(dir, 'good.md', GOOD);
    const { agents } = discoverImportedAgents({ homeDir: home });
    expect(agents).toHaveLength(2);
    const bad = agents.find((a) => a.relPath === 'bad.md');
    expect(bad?.error).toBeTruthy();
    expect(bad?.name).toBe('bad');
    expect(agents.find((a) => a.relPath === 'good.md')?.error).toBeUndefined();
  });

  it('caps the total file count and says so', () => {
    expect(IMPORTED_AGENTS_FILE_CAP).toBe(1000);
    const dir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < IMPORTED_AGENTS_FILE_CAP + 1; i += 1) {
      fs.writeFileSync(path.join(dir, `agent-${String(i).padStart(4, '0')}.md`), GOOD);
    }
    const { agents, capped } = discoverImportedAgents({ homeDir: home });
    expect(capped).toBe(true);
    expect(agents).toHaveLength(IMPORTED_AGENTS_FILE_CAP);
  });

  it('missing directories are an empty list, not an error', () => {
    const { agents, capped } = discoverImportedAgents({ homeDir: home, projectDir: project });
    expect(agents).toEqual([]);
    expect(capped).toBe(false);
  });

  it('ignores a relative project dir', () => {
    seed();
    const dirs = importedAgentSourceDirs({ homeDir: home, projectDir: 'relative/path' });
    expect(dirs.map((d) => d.source)).toEqual(['claude-user', 'qwen-user']);
  });
});

describe('readImportedAgentById', () => {
  it('reads a known id and refuses unknown, invalid and escaping ids', () => {
    seed();
    const scope = { homeDir: home, projectDir: project };
    const found = readImportedAgentById('imported:claude-user:reviewer.md', scope);
    expect(found?.name).toBe('Reviewer');
    expect(readImportedAgentById('imported:claude-user:nope.md', scope)).toBeNull();
    expect(readImportedAgentById('imported:claude-user:../../../etc/passwd', scope)).toBeNull();
    expect(readImportedAgentById('expert:reviewer', scope)).toBeNull();
    expect(readImportedAgentById('imported:claude-user:notes.txt', scope)).toBeNull();
    // Project-scoped ids only resolve when the project dir is in scope.
    expect(readImportedAgentById('imported:claude-project:local.md', { homeDir: home })).toBeNull();
    expect(readImportedAgentById('imported:claude-project:local.md', scope)?.name).toBe('Local');
  });
});

describe('imported agents IPC', () => {
  function setup(watch?: Parameters<typeof registerImportedAgentsHandlers>[1]['watch']) {
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    handle = registerImportedAgentsHandlers(harness, { homeDir: home, expertsRoot: experts, assertTrusted, broadcast, watch });
    return { harness, broadcast, assertTrusted };
  }

  it('lists after a trust check and refuses an untrusted caller', async () => {
    seed();
    const { harness, assertTrusted } = setup(fakeWatch().watch);
    const result = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_LIST, project)) as { agents: ImportedAgent[] };
    expect(assertTrusted).toHaveBeenCalledOnce();
    expect(result.agents).toHaveLength(4);

    const strict = new IpcHarness();
    const h2 = registerImportedAgentsHandlers(strict, {
      homeDir: home,
      expertsRoot: experts,
      assertTrusted: () => { throw new Error('untrusted sender'); },
      broadcast: vi.fn(),
      watch: fakeWatch().watch,
    });
    await expect(strict.invoke(MAKER_INVOKE.IMPORTED_AGENTS_LIST)).rejects.toThrow('untrusted sender');
    h2.dispose();
  });

  it('reads one agent and refuses unknown ids', async () => {
    seed();
    const { harness } = setup(fakeWatch().watch);
    const ok = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_READ, 'imported:qwen-user:architect.md')) as { ok: boolean; agent?: ImportedAgent };
    expect(ok.ok).toBe(true);
    expect(ok.agent?.name).toBe('Architect');
    const missing = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_READ, 'imported:qwen-user:ghost.md')) as { ok: boolean; reason?: string };
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not-found');
    const invalid = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_READ, 'imported:claude-user:../escape.md')) as { ok: boolean; reason?: string };
    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toBe('invalid');
  });

  it('copies through the draft path into a folder the 3.1 loader accepts', async () => {
    seed();
    const { harness, broadcast } = setup(fakeWatch().watch);
    const res = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_COPY_TO_EXPERT, 'imported:claude-user:reviewer.md')) as { ok: boolean; slug?: string; dir?: string };
    expect(res.ok).toBe(true);
    expect(res.slug).toBe('reviewer');
    const loaded = loadExpert(path.join(experts, 'reviewer'));
    expect(loaded.expert?.name).toBe('Reviewer');
    expect(loaded.expert?.prompt).toBe('You review code.');
    expect(loaded.expert?.agent).toBe('hermes');
    expect(loaded.expert?.model).toBeUndefined();
    expect(loaded.expert?.tools).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_CHANGED, expect.any(Array));
    // The foreign file is untouched.
    expect(fs.readFileSync(path.join(home, '.claude', 'agents', 'reviewer.md'), 'utf8')).toBe(GOOD);
  });

  it('never overwrites an existing slug: the copy gets a numbered slug', async () => {
    seed();
    fs.mkdirSync(path.join(experts, 'reviewer'), { recursive: true });
    fs.writeFileSync(path.join(experts, 'reviewer', 'expert.md'), '---\nname: Mine\ndescription: Hand-made.\n---\nMine.\n');
    const { harness } = setup(fakeWatch().watch);
    const res = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_COPY_TO_EXPERT, 'imported:claude-user:reviewer.md')) as { ok: boolean; slug?: string };
    expect(res.ok).toBe(true);
    expect(res.slug).toBe('reviewer-2');
    expect(fs.readFileSync(path.join(experts, 'reviewer', 'expert.md'), 'utf8')).toContain('Hand-made.');
    const again = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_COPY_TO_EXPERT, 'imported:claude-user:reviewer.md')) as { ok: boolean; slug?: string };
    expect(again.slug).toBe('reviewer-3');
  });

  it('refuses to copy a malformed or unknown agent', async () => {
    writeAgent(path.join(home, '.claude', 'agents'), 'bad.md', '---\nname: [unclosed\n---\nBody.');
    const { harness } = setup(fakeWatch().watch);
    const bad = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_COPY_TO_EXPERT, 'imported:claude-user:bad.md')) as { ok: boolean; reason?: string; message?: string };
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('invalid');
    expect(bad.message).toContain('frontmatter');
    const ghost = (await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_COPY_TO_EXPERT, 'imported:claude-user:ghost.md')) as { ok: boolean; reason?: string };
    expect(ghost.ok).toBe(false);
    expect(ghost.reason).toBe('not-found');
    expect(fs.readdirSync(experts)).toEqual([]);
  });

  function fakeWatch() {
    const calls: Array<{ dirs: string[]; onChange: () => void; closed: boolean }> = [];
    const watch = ((dirs: string[], onChange: () => void) => {
      const call = { dirs: [...dirs], onChange, closed: false };
      calls.push(call);
      return { close: () => { call.closed = true; } };
    }) as unknown as NonNullable<Parameters<typeof registerImportedAgentsHandlers>[1]['watch']>;
    return { calls, watch };
  }

  it('arms one watcher on the first list, re-arms on a new project dir, pushes changes', async () => {
    seed();
    const { calls, watch } = fakeWatch();
    const { harness, broadcast } = setup(watch);
    expect(calls).toHaveLength(0);
    await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_LIST, project);
    await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_LIST, project);
    expect(calls).toHaveLength(1);
    expect(calls[0].dirs).toContain(path.join(home, '.claude', 'agents'));
    expect(calls[0].dirs).toContain(path.join(project, '.qwen', 'agents'));

    calls[0].onChange();
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.IMPORTED_AGENTS_CHANGED, expect.objectContaining({ agents: expect.any(Array) }));

    await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_LIST, null);
    expect(calls).toHaveLength(2);
    expect(calls[0].closed).toBe(true);
    expect(calls[1].dirs).not.toContain(path.join(project, '.claude', 'agents'));
  });

  it('closes the watcher on dispose', async () => {
    const { calls, watch } = fakeWatch();
    const { harness } = setup(watch);
    await harness.invoke(MAKER_INVOKE.IMPORTED_AGENTS_LIST);
    handle?.dispose();
    handle = undefined;
    expect(calls[0].closed).toBe(true);
  });
});
