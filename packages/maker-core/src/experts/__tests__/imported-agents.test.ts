/**
 * Imported agents (ROADMAP 12.1): read-only foreign agent definitions.
 * Pure parser / tool map / draft conversion — zero I/O here.
 */

import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../../agents/shared/customization-scanner';
import { validateExpertDraft } from '../expert-draft';
import {
  IMPORTED_AGENT_SOURCES,
  IMPORTED_TOOL_MAP,
  importedAgentId,
  importedAgentToExpertDraft,
  isImportedAgentId,
  parseImportedAgent,
  parseImportedAgentId,
} from '../imported-agents';

const META = { source: 'claude-user' as const, absolutePath: '/home/u/.claude/agents/reviewer.md', relPath: 'reviewer.md' };

const FULL = [
  '---',
  'name: Code Reviewer',
  'description: Reviews diffs for correctness and security.',
  'tools: Read, Grep, Glob, Bash',
  'model: opus',
  '---',
  '',
  'You review code.',
  '',
].join('\n');

describe('parseImportedAgent', () => {
  it('parses frontmatter, tools string, model and body', () => {
    const agent = parseImportedAgent(FULL, META);
    expect(agent.id).toBe('imported:claude-user:reviewer.md');
    expect(agent.source).toBe('claude-user');
    expect(agent.absolutePath).toBe(META.absolutePath);
    expect(agent.relPath).toBe('reviewer.md');
    expect(agent.name).toBe('Code Reviewer');
    expect(agent.description).toBe('Reviews diffs for correctness and security.');
    expect(agent.declaredTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(agent.declaredModel).toBe('opus');
    expect(agent.prompt).toBe('You review code.');
    expect(agent.runsOn).toEqual(['claude-code', 'hermes']);
    expect(agent.blockedTools).toBeUndefined();
    expect(agent.error).toBeUndefined();
  });

  it('accepts tools as a YAML list', () => {
    const raw = '---\nname: X\ntools: [Read, Write]\n---\nBody.';
    const agent = parseImportedAgent(raw, META);
    expect(agent.declaredTools).toEqual(['Read', 'Write']);
    expect(agent.runsOn).toEqual(['claude-code', 'hermes']);
  });

  it('lists a file without frontmatter using the file stem', () => {
    const agent = parseImportedAgent('Just a prompt, no frontmatter.', META);
    expect(agent.name).toBe('reviewer');
    expect(agent.description).toBe('');
    expect(agent.declaredTools).toEqual([]);
    expect(agent.prompt).toBe('Just a prompt, no frontmatter.');
    expect(agent.runsOn).toEqual(['claude-code', 'hermes']);
    expect(agent.error).toBeUndefined();
  });

  it('parses CRLF files', () => {
    const agent = parseImportedAgent(FULL.replace(/\n/g, '\r\n'), META);
    expect(agent.name).toBe('Code Reviewer');
    expect(agent.declaredTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(agent.prompt).toBe('You review code.');
  });

  it('falls back to the file stem when name is missing', () => {
    const agent = parseImportedAgent('---\ndescription: D.\n---\nBody.', META);
    expect(agent.name).toBe('reviewer');
  });

  it('lists a malformed file with its error instead of throwing', () => {
    const agent = parseImportedAgent('---\nname: [unclosed\n---\nBody.', META);
    expect(agent.error).toBeTruthy();
    expect(agent.name).toBe('reviewer');
    expect(agent.runsOn).toEqual([]);
  });

  it('keeps the error on re-reads (gray-matter must not cache a failed parse)', () => {
    const raw = '---\nname: [unclosed\n---\nBody.';
    expect(parseImportedAgent(raw, META).error).toBeTruthy();
    expect(parseImportedAgent(raw, META).error).toBeTruthy();
    expect(parseImportedAgent(raw, META).error).toBeTruthy();
  });

  it('caps the description at 500 characters', () => {
    const agent = parseImportedAgent(`---\nname: X\ndescription: ${'d'.repeat(600)}\n---\nBody.`, META);
    expect(agent.description.length).toBe(500);
  });

  it('keeps model raw and never maps it', () => {
    const agent = parseImportedAgent(FULL, META);
    expect(agent.declaredModel).toBe('opus');
    expect(JSON.stringify(agent)).not.toContain('route');
  });

  it('blocks Hermes when a declared tool does not map, naming the tool', () => {
    const agent = parseImportedAgent('---\nname: X\ntools: Read, WebSearch\n---\nBody.', META);
    expect(agent.runsOn).toEqual(['claude-code']);
    expect(agent.blockedTools).toEqual(['WebSearch']);
  });

  it('allows Hermes when no tools are declared', () => {
    const agent = parseImportedAgent('---\nname: X\n---\nBody.', META);
    expect(agent.runsOn).toEqual(['claude-code', 'hermes']);
  });

  it('does not treat prototype keys as mapped tools', () => {
    const agent = parseImportedAgent('---\nname: X\ntools: constructor, toString\n---\nBody.', META);
    expect(agent.runsOn).toEqual(['claude-code']);
    expect(agent.blockedTools).toEqual(['constructor', 'toString']);
  });

  it('blocks non-string tool entries instead of dropping them', () => {
    const agent = parseImportedAgent('---\nname: X\ntools: [Read, 42]\n---\nBody.', META);
    expect(agent.runsOn).toEqual(['claude-code']);
    expect(agent.blockedTools).toEqual(['42']);
  });

  it('produces stable ids and normalizes backslashes', () => {
    const a = parseImportedAgent(FULL, META);
    const b = parseImportedAgent(FULL, META);
    expect(a.id).toBe(b.id);
    const nested = parseImportedAgent(FULL, { ...META, relPath: 'team\\reviewer.md' });
    expect(nested.id).toBe('imported:claude-user:team/reviewer.md');
    expect(nested.relPath).toBe('team/reviewer.md');
  });

  it('applies the same rules to qwen sources', () => {
    const agent = parseImportedAgent(FULL, { ...META, source: 'qwen-user' });
    expect(agent.id).toBe('imported:qwen-user:reviewer.md');
    expect(agent.runsOn).toEqual(['claude-code', 'hermes']);
  });
});

describe('parseFrontmatter content (shared parser)', () => {
  it('returns the body alongside frontmatter', () => {
    const parsed = parseFrontmatter('---\nname: X\n---\nBody text.');
    expect(parsed.content?.trim()).toBe('Body text.');
    expect(parsed.frontmatter?.name).toBe('X');
  });

  it('returns the whole raw text when there is no frontmatter', () => {
    const parsed = parseFrontmatter('No frontmatter here.');
    expect(parsed.content?.trim()).toBe('No frontmatter here.');
  });
});

describe('IMPORTED_TOOL_MAP', () => {
  it('maps to real Hermes tool names only', () => {
    expect(IMPORTED_TOOL_MAP).toEqual({
      Read: 'read_file',
      Grep: 'search_files',
      Glob: 'search_files',
      Bash: 'terminal',
      Edit: 'patch',
      Write: 'write_file',
    });
  });
});

describe('parseImportedAgentId', () => {
  it('accepts every source', () => {
    for (const source of IMPORTED_AGENT_SOURCES) {
      const id = importedAgentId(source, 'sub/agent.md');
      expect(isImportedAgentId(id)).toBe(true);
      expect(parseImportedAgentId(id)).toEqual({ source, relPath: 'sub/agent.md' });
    }
  });

  it('refuses traversal, absolute paths, backslashes and unknown sources', () => {
    for (const bad of [
      'imported:claude-user:../escape.md',
      'imported:claude-user:/abs/agent.md',
      'imported:claude-user:a\\b.md',
      'imported:claude-user:a//b.md',
      'imported:claude-user:./a.md',
      'imported:other:agent.md',
      'imported:claude-user:',
      'expert:code-reviewer',
      '',
      null,
      42,
    ]) {
      expect(parseImportedAgentId(bad)).toBeNull();
      expect(isImportedAgentId(bad)).toBe(false);
    }
  });
});

describe('importedAgentToExpertDraft', () => {
  const agent = parseImportedAgent(FULL, META);

  it('produces a draft the 3.8 validator accepts, without a model', () => {
    const draft = importedAgentToExpertDraft(agent);
    const check = validateExpertDraft(draft);
    expect(check.ok).toBe(true);
    expect(draft.slug).toBe('code-reviewer');
    expect(draft.name).toBe('Code Reviewer');
    expect(draft.model).toBeUndefined();
    expect(draft.tags).toEqual(['imported', 'claude-user']);
    expect(draft.memory).toBe(false);
    expect(draft.prompt).toBe('You review code.');
  });

  it('numbers the slug when it is taken, never overwriting', () => {
    const taken = new Set(['code-reviewer', 'code-reviewer-2']);
    const draft = importedAgentToExpertDraft(agent, { isSlugTaken: (slug) => taken.has(slug) });
    expect(draft.slug).toBe('code-reviewer-3');
  });

  it('falls back to a factual one-line description when none was declared', () => {
    const bare = parseImportedAgent('---\nname: X\n---\nBody.', META);
    const draft = importedAgentToExpertDraft(bare);
    expect(draft.description).toBe('Imported from claude-user (reviewer.md)');
    expect(validateExpertDraft(draft).ok).toBe(true);
  });

  it('folds a multi-line description into one line within the draft limit', () => {
    const multiline = parseImportedAgent('---\nname: X\ndescription: >\n  line one\n  line two\n---\nBody.', META);
    const draft = importedAgentToExpertDraft(multiline);
    expect(draft.description).toBe('line one line two');
    expect(validateExpertDraft(draft).ok).toBe(true);
  });

  it('truncates over-long names and descriptions to the draft limits', () => {
    const long = parseImportedAgent(`---\nname: ${'n'.repeat(120)}\ndescription: ${'d'.repeat(400)}\n---\nBody.`, META);
    const draft = importedAgentToExpertDraft(long);
    expect(draft.name.length).toBe(80);
    expect(draft.description.length).toBe(300);
    expect(validateExpertDraft(draft).ok).toBe(true);
  });

  it('derives a valid slug from names with no usable characters', () => {
    const odd = parseImportedAgent('---\nname: "!!!"\n---\nBody.', META);
    const draft = importedAgentToExpertDraft(odd);
    expect(validateExpertDraft(draft).ok).toBe(true);
  });

  it('keeps the prompt untouched so an oversized body fails validation loudly', () => {
    const big = parseImportedAgent(`---\nname: X\ndescription: D.\n---\n${'p'.repeat(20_001)}`, META);
    const draft = importedAgentToExpertDraft(big);
    expect(draft.prompt.length).toBe(20_001);
    const check = validateExpertDraft(draft);
    expect(check.ok).toBe(false);
  });
});
