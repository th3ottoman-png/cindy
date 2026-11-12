import { describe, expect, it } from 'vitest';
import { parseDecisionBlocks } from '../decisionCards.js';

const BLOCK = [
  '```cindy-decisions',
  '{"decisions":[{"id":"auth","question":"How should users sign in?","options":[{"id":"jwt","label":"JWT in header","detail":"Stateless"},{"id":"session","label":"Server sessions","detail":"Easy revoke"}],"defaultOptionId":"jwt"},{"id":"db","question":"Where to store users?","options":[{"id":"sqlite","label":"SQLite"},{"id":"pg","label":"Postgres"}]}]}',
  '```',
].join('\n');

describe('parseDecisionBlocks (ROADMAP 11.7)', () => {
  it('extracts decisions and strips the fence from display text', () => {
    const { decisions, cleanedText } = parseDecisionBlocks(`Intro line\n\n${BLOCK}\n\nOutro`);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ id: 'auth', defaultOptionId: 'jwt' });
    expect(decisions[0]?.options).toHaveLength(2);
    expect(cleanedText).not.toContain('cindy-decisions');
    expect(cleanedText).toContain('Intro line');
    expect(cleanedText).toContain('Outro');
  });

  it('parses a same-line fence (no newlines around the JSON)', () => {
    const { decisions, cleanedText } = parseDecisionBlocks(
      '```cindy-decisions{"decisions":[{"id":"a","question":"Q?","options":[{"id":"x","label":"X"},{"id":"y","label":"Y"}]}]}```',
    );
    expect(decisions).toHaveLength(1);
    expect(cleanedText).not.toContain('cindy-decisions');
  });
  it('ignores text without the fence', () => {
    const { decisions, cleanedText } = parseDecisionBlocks('Just a normal reply.');
    expect(decisions).toEqual([]);
    expect(cleanedText).toBe('Just a normal reply.');
  });

  it('strips unparseable blocks without surfacing raw JSON', () => {
    const { decisions, cleanedText } = parseDecisionBlocks('```cindy-decisions\nnot json\n```');
    expect(decisions).toEqual([]);
    expect(cleanedText).not.toContain('not json');
  });

  it('drops malformed decisions but keeps the valid ones', () => {
    const { decisions } = parseDecisionBlocks(
      '```cindy-decisions\n{"decisions":[{"id":"","question":"blank id"},{"id":"one","question":"Only one option?","options":[{"id":"a","label":"A"}]},{"id":"ok","question":"Good?","options":[{"id":"y","label":"Yes"},{"id":"n","label":"No"}]}]}\n```',
    );
    expect(decisions.map((d) => d.id)).toEqual(['ok']);
  });

  it('dedupes repeat ids and ignores unknown defaults', () => {
    const { decisions } = parseDecisionBlocks(
      '```cindy-decisions\n{"decisions":[{"id":"a","question":"Q?","options":[{"id":"x","label":"X"},{"id":"y","label":"Y"}],"defaultOptionId":"ghost"},{"id":"a","question":"Q2?","options":[{"id":"x","label":"X"},{"id":"y","label":"Y"}]}]}\n```',
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.defaultOptionId).toBeUndefined();
  });
});
