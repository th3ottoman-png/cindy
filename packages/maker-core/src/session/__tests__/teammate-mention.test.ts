import { describe, expect, it } from 'vitest';

import {
  findInvalidTeammateMentions,
  parseTeammateMentions,
  parseTeammateRosterId,
  renderTeammateDispatchNote,
  stripTeammateMentions,
} from '../teammate-mention';

describe('parseTeammateRosterId', () => {
  it('accepts an expert roster id', () => {
    expect(parseTeammateRosterId('expert:historian')).toEqual({
      kind: 'expert',
      slug: 'historian',
      rosterId: 'expert:historian',
    });
  });

  it('accepts expert slugs with dots, underscores and digits', () => {
    expect(parseTeammateRosterId('expert:code_reviewer.v2')).toMatchObject({ kind: 'expert', slug: 'code_reviewer.v2' });
  });

  it('refuses empty, traversal and leading-punctuation expert slugs', () => {
    for (const id of ['expert:', 'expert:..', 'expert:a..b', 'expert:-lead', 'expert:.hidden']) {
      expect(parseTeammateRosterId(id)).toBeNull();
    }
  });

  it('accepts an imported roster id', () => {
    expect(parseTeammateRosterId('imported:claude-user:historian.md')).toEqual({
      kind: 'imported',
      source: 'claude-user',
      relPath: 'historian.md',
      rosterId: 'imported:claude-user:historian.md',
    });
  });

  it('accepts imported ids with one sub-folder', () => {
    expect(parseTeammateRosterId('imported:qwen-project:sub/agent.md')).toMatchObject({
      kind: 'imported',
      source: 'qwen-project',
      relPath: 'sub/agent.md',
    });
  });

  it('refuses unknown sources, traversal, absolute paths and backslashes', () => {
    for (const id of [
      'imported:other:agent.md',
      'imported:claude-user:../escape.md',
      'imported:claude-user:/abs/agent.md',
      'imported:claude-user:sub\\agent.md',
      'imported:claude-user:sub//agent.md',
      'imported:claude-user:',
    ]) {
      expect(parseTeammateRosterId(id)).toBeNull();
    }
  });

  it('refuses bare slugs and unknown prefixes', () => {
    for (const id of ['historian', 'expertx:foo', 'agent:historian', '', null, 42]) {
      expect(parseTeammateRosterId(id as unknown as string)).toBeNull();
    }
  });
});

describe('parseTeammateMentions', () => {
  it('finds a token at the start, mid-sentence and after a bracket', () => {
    const text = '@agent:expert:historian review this (@agent:imported:claude-user:geographer.md too)';
    const tokens = parseTeammateMentions(text);
    expect(tokens.map((t) => t.ref.rosterId)).toEqual([
      'expert:historian',
      'imported:claude-user:geographer.md',
    ]);
    expect(tokens[0].raw).toBe('@agent:expert:historian');
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe(tokens[0].raw);
    expect(text.slice(tokens[1].start, tokens[1].end)).toBe(tokens[1].raw);
  });

  it('keeps every occurrence in order (the service dedupes, the parser does not)', () => {
    const tokens = parseTeammateMentions('@agent:expert:a one @agent:expert:a two');
    expect(tokens).toHaveLength(2);
    expect(tokens[0].start).toBeLessThan(tokens[1].start);
  });

  it('ignores emails and glued prose', () => {
    expect(parseTeammateMentions('write me@agent:expert:historian now')).toEqual([]);
  });

  it('trims trailing sentence punctuation from the token', () => {
    const tokens = parseTeammateMentions('ask @agent:expert:historian, please.');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('@agent:expert:historian');
    expect(tokens[0].ref.rosterId).toBe('expert:historian');
  });

  it('ends the token at whitespace', () => {
    const tokens = parseTeammateMentions('@agent:expert:historian\nnext line');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].ref.rosterId).toBe('expert:historian');
  });

  it('returns nothing without the sigil', () => {
    expect(parseTeammateMentions('plain prose @expert:historian')).toEqual([]);
    expect(parseTeammateMentions('')).toEqual([]);
  });

  it('does not treat an invalid id as a mention', () => {
    expect(parseTeammateMentions('@agent:oops review')).toEqual([]);
  });
});

describe('findInvalidTeammateMentions', () => {
  it('flags a token-shaped mention whose id is not a roster id', () => {
    expect(findInvalidTeammateMentions('@agent:oops review this')).toEqual(['@agent:oops']);
  });

  it('flags only the invalid ones', () => {
    expect(findInvalidTeammateMentions('@agent:expert:historian and @agent:expert:.. go')).toEqual(['@agent:expert:..']);
  });

  it('respects word boundaries', () => {
    expect(findInvalidTeammateMentions('mail me@agent:oops')).toEqual([]);
  });

  it('returns nothing for valid or absent mentions', () => {
    expect(findInvalidTeammateMentions('@agent:expert:historian ok')).toEqual([]);
    expect(findInvalidTeammateMentions('no mentions')).toEqual([]);
  });
});

describe('stripTeammateMentions', () => {
  it('removes every occurrence and tidies the leftover whitespace', () => {
    expect(stripTeammateMentions('@agent:expert:historian review this @agent:expert:historian please'))
      .toBe('review this please');
  });

  it('keeps prose byte-identical when there is no token', () => {
    const text = 'keep   spaces\nand  lines\n';
    expect(stripTeammateMentions(text)).toBe(text);
  });

  it('returns an empty string for a token-only message', () => {
    expect(stripTeammateMentions('@agent:expert:historian')).toBe('');
  });

  it('leaves 8.4 tokens alone', () => {
    expect(stripTeammateMentions('@skill:apple/apple-notes do it')).toBe('@skill:apple/apple-notes do it');
  });

  it('keeps line structure around a removed token', () => {
    expect(stripTeammateMentions('first line\n@agent:expert:historian\nlast line')).toBe('first line\nlast line');
  });
});

describe('renderTeammateDispatchNote', () => {
  it('names one teammate and says the report arrives as a worker message', () => {
    const note = renderTeammateDispatchNote(['Historian']);
    expect(note).toContain('Historian');
    expect(note).toContain('teammate');
    expect(note).toContain('worker');
  });

  it('lists several teammates', () => {
    const note = renderTeammateDispatchNote(['Historian', 'Geographer']);
    expect(note).toContain('Historian');
    expect(note).toContain('Geographer');
  });

  it('is empty for no teammates', () => {
    expect(renderTeammateDispatchNote([])).toBe('');
  });
});
