import { describe, expect, it } from 'vitest';

import {
  findInvalidTeammateMentions,
  findTeammateMentionTrigger,
  parseTeammateMentions,
  parseTeammateRosterId,
  renderTeammateDispatchNote,
  stripTeammateMentions,
  teammateBindingId,
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

describe('findTeammateMentionTrigger (ROADMAP 12.3b picker ownership)', () => {
  it('fires on a bare @agent: at the start of the text', () => {
    expect(findTeammateMentionTrigger('@agent:')).toEqual({
      start: 0,
      end: 7,
      query: 'agent:',
      term: '',
    });
  });

  it('fires after whitespace and carries the typed term', () => {
    const text = 'bring in @agent:hist';
    expect(findTeammateMentionTrigger(text)).toEqual({
      start: 9,
      end: text.length,
      query: 'agent:hist',
      term: 'hist',
    });
  });

  it('fires on the last line of a multi-line draft', () => {
    const text = 'first line\n@agent:expert:';
    expect(findTeammateMentionTrigger(text)).toMatchObject({
      start: 11,
      query: 'agent:expert:',
      term: 'expert:',
    });
  });

  it('accepts the same boundary characters as the 8.4 trigger', () => {
    for (const before of ['(', '[', '{', '"', "'", '>', '-', ' ', '\t']) {
      const text = before + '@agent:';
      expect(findTeammateMentionTrigger(text)).toMatchObject({ start: before.length });
    }
  });

  it('does not fire inside a word (name@host is prose)', () => {
    expect(findTeammateMentionTrigger('write name@agent:expert:x')).toBeNull();
  });

  it('does not fire once a space ends the token', () => {
    expect(findTeammateMentionTrigger('@agent:expert:historian do it')).toBeNull();
    expect(findTeammateMentionTrigger('@agent: ')).toBeNull();
  });

  it('leaves bare @ and other kinds to the file/attachment panels', () => {
    expect(findTeammateMentionTrigger('@')).toBeNull();
    expect(findTeammateMentionTrigger('@hist')).toBeNull();
    expect(findTeammateMentionTrigger('@skill:sea')).toBeNull();
    expect(findTeammateMentionTrigger('@expert:hist')).toBeNull();
    expect(findTeammateMentionTrigger('@agent')).toBeNull();
  });

  it('does not fire on an earlier token when the caret moved on', () => {
    expect(findTeammateMentionTrigger('@agent:expert:historian and then @other')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(findTeammateMentionTrigger('')).toBeNull();
  });

  it('treats an overlong query as prose, like the 8.4 trigger', () => {
    expect(findTeammateMentionTrigger('@agent:' + 'x'.repeat(60))).toBeNull();
  });
});

describe('teammateBindingId (ROADMAP 12.3b: binding-store normalization)', () => {
  it('strips the expert: prefix to the bare slug the binding store keeps', () => {
    expect(teammateBindingId('expert:geographer')).toBe('geographer');
    expect(teammateBindingId('expert:code_reviewer.v2')).toBe('code_reviewer.v2');
  });

  it('keeps an imported id whole (the binding store accepts it as-is)', () => {
    expect(teammateBindingId('imported:claude-user:academic-historian.md'))
      .toBe('imported:claude-user:academic-historian.md');
  });

  it('passes a bare slug through unchanged', () => {
    expect(teammateBindingId('geographer')).toBe('geographer');
  });

  it('returns an unknown id unchanged so the binding store can refuse it', () => {
    expect(teammateBindingId('not-a-roster-id')).toBe('not-a-roster-id');
  });
});
