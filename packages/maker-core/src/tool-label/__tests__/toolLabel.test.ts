/**
 * Tool-batch labels, pure module (ROADMAP 13.4): digest bounds + redaction, the fail-closed
 * reply contract, the header format, and the per-session cache file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TOOL_LABEL_ARG_CHARS,
  TOOL_LABEL_DIGEST_CHAR_BUDGET,
  TOOL_LABEL_SYSTEM_PROMPT,
  buildToolLabelDigest,
  firstToolArgument,
  formatToolLabelHeader,
  parseToolLabel,
  readToolLabelCache,
  toolLabelCacheFile,
  writeToolLabelEntry,
} from '../toolLabel.js';

describe('firstToolArgument', () => {
  it('prefers command/path-like keys over other strings', () => {
    expect(firstToolArgument({ timeout: '5', command: 'pnpm test' })).toBe('pnpm test');
    expect(firstToolArgument({ content: 'x', file_path: '/a/b.ts' })).toBe('/a/b.ts');
  });
  it('falls back to the first string, then JSON, and collapses whitespace', () => {
    expect(firstToolArgument({ n: 1, note: 'a\n  b' })).toBe('a b');
    expect(firstToolArgument({ n: 1 })).toBe('{"n":1}');
    expect(firstToolArgument('  ls  -la ')).toBe('ls -la');
    expect(firstToolArgument(null)).toBe('');
    expect(firstToolArgument(['x', 'y'])).toBe('x');
  });
});

describe('buildToolLabelDigest', () => {
  it('lists each call with its first argument, numbered, under a count header', () => {
    const digest = buildToolLabelDigest([
      { name: 'Read', input: { file_path: 'src/auth.ts' } },
      { name: 'Bash', input: { command: 'pnpm test auth' } },
    ]);
    expect(digest).toBe('Tool calls (2):\n1. Read: src/auth.ts\n2. Bash: pnpm test auth');
  });
  it('truncates long arguments', () => {
    const digest = buildToolLabelDigest([{ name: 'Bash', input: { command: 'x'.repeat(1000) } }]);
    const line = digest.split('\n')[1]!;
    expect(line.length).toBeLessThanOrEqual('1. Bash: '.length + TOOL_LABEL_ARG_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });
  it('redacts secrets with the screen-share engine before anything leaves the machine', () => {
    const digest = buildToolLabelDigest([
      { name: 'Bash', input: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456" x' } },
      { name: 'Bash', input: { command: 'mail owner@example.com' } },
    ]);
    expect(digest).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(digest).not.toContain('owner@example.com');
    expect(digest).toContain('[REDACTED]');
  });
  it('never exceeds the budget and counts the calls it did not send', () => {
    const calls = Array.from({ length: 500 }, (_, i) => ({ name: 'Read', input: { file_path: `src/${'d'.repeat(100)}/${i}.ts` } }));
    const digest = buildToolLabelDigest(calls);
    expect(digest.length).toBeLessThanOrEqual(TOOL_LABEL_DIGEST_CHAR_BUDGET);
    expect(digest.startsWith('Tool calls (500):')).toBe(true);
    expect(digest).toMatch(/… and \d+ more tool calls$/);
  });
});

describe('parseToolLabel', () => {
  it('accepts a short label and strips quotes, a Label: prefix and a trailing period', () => {
    expect(parseToolLabel('Updated auth tests')).toBe('Updated auth tests');
    expect(parseToolLabel('"Updated auth tests."')).toBe('Updated auth tests');
    expect(parseToolLabel('Label: Read the build config\n')).toBe('Read the build config');
    expect(parseToolLabel('\n\n**Searched logs**')).toBe('Searched logs');
  });
  it('fails closed on prose, fences, JSON, empty or over-long replies', () => {
    expect(parseToolLabel('')).toBeNull();
    expect(parseToolLabel('   \n ')).toBeNull();
    expect(parseToolLabel('```\nUpdated tests\n```')).toBeNull();
    expect(parseToolLabel('{"label":"x"}')).toBeNull();
    expect(parseToolLabel('The agent read several files and then ran the tests')).toBeNull();
    expect(parseToolLabel('Supercalifragilistic'.repeat(4))).toBeNull();
  });
});

describe('formatToolLabelHeader', () => {
  it('keeps the count as the suffix, singular for one', () => {
    expect(formatToolLabelHeader('Updated auth tests', 7)).toBe('Updated auth tests · 7 tools');
    expect(formatToolLabelHeader('Read config', 1)).toBe('Read config · 1 tool');
  });
});

describe('cache file', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-tool-label-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const entry = { label: 'Ran tests', toolCount: 3, routeName: 'r', model: 'm', provider: 'p', createdAt: 1 };

  it('maps a session id to a safe file name under the dir', () => {
    expect(toolLabelCacheFile(dir, 'abc-123')).toBe(path.join(dir, 'abc-123.json'));
    const unsafe = toolLabelCacheFile(dir, '../../etc/passwd');
    expect(path.dirname(unsafe)).toBe(dir);
    expect(() => toolLabelCacheFile(dir, '')).toThrow();
  });
  it('reads a missing or corrupt file as empty', () => {
    const file = path.join(dir, 's.json');
    expect(readToolLabelCache(file)).toEqual({ version: 1, labels: {} });
    fs.writeFileSync(file, 'not json');
    expect(readToolLabelCache(file)).toEqual({ version: 1, labels: {} });
  });
  it('writes atomically, merges entries, and drops malformed ones on read', () => {
    const file = path.join(dir, 'nested', 's.json');
    writeToolLabelEntry(file, 'toolu_1', entry);
    writeToolLabelEntry(file, 'toolu_2', { ...entry, label: 'Read files' });
    expect(Object.keys(readToolLabelCache(file).labels)).toEqual(['toolu_1', 'toolu_2']);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['s.json']);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.labels.bad = { label: 3 };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(Object.keys(readToolLabelCache(file).labels)).toEqual(['toolu_1', 'toolu_2']);
  });
});

describe('TOOL_LABEL_SYSTEM_PROMPT', () => {
  it('states the six-word bound', () => {
    expect(TOOL_LABEL_SYSTEM_PROMPT).toContain('at most 6 words');
  });
});
