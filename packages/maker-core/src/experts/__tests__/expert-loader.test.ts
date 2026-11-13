import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadExpert, loadExperts, watchExperts, type ExpertEntry } from '../expert-loader.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'experts-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeExpert(slug: string, md: string, extra: Record<string, string> = {}): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'expert.md'), md);
  for (const [rel, body] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const FULL = `---
name: Code Reviewer
description: Reviews diffs
agent: hermes
model: local-small
temperature: 0.2
tools: [read_file, grep]
skills: [review]
memory: true
tags: [code, review]
---
You review code carefully.
`;

describe('loadExpert', () => {
  it('parses a full expert with its optional files', () => {
    const dir = writeExpert('code-reviewer', FULL, {
      'skills/review/SKILL.md': '# review',
      'skills/.hidden/SKILL.md': 'x',
      'tools.yaml': 'tools:\n  allow: []\n',
      'knowledge/notes.md': 'n',
    });
    const { expert, error } = loadExpert(dir);
    expect(error).toBeUndefined();
    expect(expert).toMatchObject({
      slug: 'code-reviewer',
      name: 'Code Reviewer',
      description: 'Reviews diffs',
      agent: 'hermes',
      model: 'local-small',
      temperature: 0.2,
      tools: ['read_file', 'grep'],
      skills: ['review'],
      memory: true,
      tags: ['code', 'review'],
      prompt: 'You review code carefully.',
      toolsFile: path.join(dir, 'tools.yaml'),
      toolsPolicy: { tools: { allow: [] } },
      knowledgeDir: path.join(dir, 'knowledge'),
    });
    expect(expert!.skillFiles).toEqual([path.join(dir, 'skills', 'review', 'SKILL.md')]);
  });

  it('applies defaults: agent hermes, memory off, empty lists', () => {
    const { expert } = loadExpert(writeExpert('min', '---\nname: Min\n---\nBe brief.\n'));
    expect(expert).toMatchObject({ agent: 'hermes', memory: false, tools: [], skills: [], tags: [], description: '' });
    expect(expert!.model).toBeUndefined();
    expect(expert!.toolsFile).toBeUndefined();
    // No `toolsets:` line means no lock: the session keeps Hermes' own tools.
    expect(expert!.toolsets).toBeUndefined();
  });

  it('reads a toolsets lock as plain toolset names (ROADMAP 3.10)', () => {
    const { expert, error } = loadExpert(writeExpert('advisor', '---\nname: Advisor\ntoolsets: [web, clarify]\n---\nList options.\n'));
    expect(error).toBeUndefined();
    expect(expert!.toolsets).toEqual(['web', 'clarify']);
  });

  it('reads toolsPolicy when tools.yaml is valid', () => {
    const dir = writeExpert('custom-tools', '---\nname: Custom\n---\nPrompt\n', {
      'tools.yaml': `
tools:
  allow: [read_project_file]
  deny: [bash]
mcp_servers:
  allow: [cindy_docs]
`,
    });
    const { expert, error } = loadExpert(dir);
    expect(error).toBeUndefined();
    expect(expert?.toolsPolicy).toEqual({
      tools: {
        allow: ['read_project_file'],
        deny: ['bash'],
      },
      mcpServers: {
        allow: ['cindy_docs'],
      },
    });
  });

  it('fails closed when tools.yaml contains syntax or schema errors', () => {
    const dir = writeExpert('broken-tools', '---\nname: Broken\n---\nPrompt\n', {
      'tools.yaml': 'tools:\n  allow: [unclosed\n',
    });
    const entry = loadExpert(dir);
    expect(entry.expert).toBeUndefined();
    expect(entry.error).toContain('tools.yaml:');

    const dir2 = writeExpert('bad-schema', '---\nname: Bad\n---\nPrompt\n', {
      'tools.yaml': 'invalid_section:\n  allow: []\n',
    });
    const entry2 = loadExpert(dir2);
    expect(entry2.expert).toBeUndefined();
    expect(entry2.error).toContain('unknown property "invalid_section" in tools.yaml');
  });

  it.each([
    ['missing expert.md', null, 'expert.md is missing'],
    ['broken YAML', '---\nname: [unclosed\n---\nbody', ''],
    ['no name', '---\nagent: hermes\n---\nbody', '"name" is required'],
    ['unknown agent', '---\nname: X\nagent: gpt\n---\nbody', '"agent" must be one of'],
    ['bad temperature', '---\nname: X\ntemperature: 9\n---\nbody', '"temperature"'],
    ['non-list tools', '---\nname: X\ntools: grep\n---\nbody', '"tools" must be a list'],
    ['non-boolean memory', '---\nname: X\nmemory: yes please\n---\nbody', '"memory"'],
    // A lock that cannot be applied must refuse the expert, never run it unlocked (ROADMAP 3.10).
    ['empty toolsets', '---\nname: X\ntoolsets: []\n---\nbody', '"toolsets"'],
    ['non-list toolsets', '---\nname: X\ntoolsets: web\n---\nbody', '"toolsets"'],
    ['tool-level toolsets', '---\nname: X\ntoolsets: ["file:read_file"]\n---\nbody', '"toolsets"'],
    ['repeated toolsets', '---\nname: X\ntoolsets: [web, web]\n---\nbody', '"toolsets"'],
    ['empty prompt', '---\nname: X\n---\n\n', 'no system prompt'],
  ])('reports %s as an error, never throws', (_label, md, fragment) => {
    const dir = md === null ? path.join(root, 'bad') : writeExpert('bad', md);
    if (md === null) fs.mkdirSync(dir);
    const entry = loadExpert(dir);
    expect(entry.expert).toBeUndefined();
    expect(entry.error).toBeTruthy();
    expect(entry.error).toContain(fragment);
  });
});

describe('loadExperts', () => {
  it('lists valid and invalid experts together, sorted, skipping files and dot-dirs', () => {
    writeExpert('b-good', FULL);
    writeExpert('a-bad', '---\nagent: hermes\n---\nbody');
    writeExpert('.git', FULL);
    fs.writeFileSync(path.join(root, 'README.md'), 'not an expert');
    const entries = loadExperts(root);
    expect(entries.map((e) => e.slug)).toEqual(['a-bad', 'b-good']);
    expect(entries[0].error).toBeTruthy();
    expect(entries[1].expert?.name).toBe('Code Reviewer');
  });

  it('returns an empty list when the root does not exist', () => {
    expect(loadExperts(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('watchExperts', () => {
  // fs.watch can take a moment to start delivering events, and a change made before then is
  // lost. Each poll re-applies the (idempotent) change until the callback reports it.
  it('re-loads after an edit, an addition and a deletion', async () => {
    writeExpert('one', FULL);
    const seen: ExpertEntry[][] = [];
    const w = watchExperts(root, (e) => seen.push(e), 30);
    try {
      await vi.waitFor(
        () => {
          fs.writeFileSync(path.join(root, 'one', 'expert.md'), FULL.replace('Code Reviewer', 'Renamed'));
          expect(seen.at(-1)?.[0].expert?.name).toBe('Renamed');
        },
        { timeout: 15_000 },
      );
      await vi.waitFor(
        () => {
          writeExpert('two', FULL);
          expect(seen.at(-1)?.map((e) => e.slug)).toEqual(['one', 'two']);
        },
        { timeout: 15_000 },
      );
      await vi.waitFor(
        () => {
          fs.rmSync(path.join(root, 'one'), { recursive: true, force: true });
          expect(seen.at(-1)?.map((e) => e.slug)).toEqual(['two']);
        },
        { timeout: 15_000 },
      );
    } finally {
      w.close();
    }
  }, 60_000);

  it('picks up a root that is created after the watcher starts', async () => {
    const late = path.join(root, 'late-root');
    const seen: ExpertEntry[][] = [];
    const w = watchExperts(late, (e) => seen.push(e), 30);
    try {
      await vi.waitFor(
        () => {
          fs.mkdirSync(path.join(late, 'x'), { recursive: true });
          fs.writeFileSync(path.join(late, 'x', 'expert.md'), FULL);
          expect(seen.at(-1)?.map((e) => e.slug)).toEqual(['x']);
        },
        { timeout: 15_000 },
      );
    } finally {
      w.close();
    }
  }, 60_000);
});

describe('max_concurrent (ROADMAP 12.2)', () => {
  it('is optional and absent means the default cap of 1', () => {
    const dir = writeExpert('plain', '---\nname: Plain\n---\nBody.');
    const entry = loadExpert(dir);
    expect(entry.error).toBeUndefined();
    expect(entry.expert?.maxConcurrent).toBeUndefined();
  });

  it('accepts a positive integer', () => {
    const dir = writeExpert('cap', '---\nname: Cap\nmax_concurrent: 3\n---\nBody.');
    expect(loadExpert(dir).expert?.maxConcurrent).toBe(3);
  });

  it('lists the expert with an error for invalid values', () => {
    for (const bad of ['0', '-2', '1.5', '"two"', 'true']) {
      const dir = writeExpert('bad', `---\nname: Bad\nmax_concurrent: ${bad}\n---\nBody.`);
      const entry = loadExpert(dir);
      expect(entry.expert).toBeUndefined();
      expect(entry.error).toContain('max_concurrent');
    }
  });
});
