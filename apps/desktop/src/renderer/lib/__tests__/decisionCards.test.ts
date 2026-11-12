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

describe('parseDecisionBlocks matrix fence (ROADMAP 11.7b)', () => {
  const MATRIX = [
    '```cindy-matrix',
    '{"matrix":{"title":"How should users sign in?","criteria":["Scalability","Revocation","Complexity","Mobile fit"],"rows":[{"id":"jwt","label":"JWT in header","summary":"Stateless","scores":["High","Low","Medium","High"]},{"id":"session","label":"Server sessions","summary":"Sticky storage","scores":["Medium","High","Low","Medium"]},{"id":"oauth","label":"OAuth delegated","summary":"Delegated","scores":["High","Medium","High","High"]},{"id":"magic","label":"Magic links","summary":"No passwords","scores":["Medium","High","Low","High"]}],"defaultOptionId":"jwt"}}',
    '```',
  ].join('\n');

  it('parses the matrix into one decision with criteria and scores', () => {
    const { decisions, cleanedText } = parseDecisionBlocks(`Compare these:\n\n${MATRIX}\n\nDone`);
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    expect(d?.id).toBe('matrix');
    expect(d?.question).toBe('How should users sign in?');
    expect(d?.criteria).toEqual(['Scalability', 'Revocation', 'Complexity', 'Mobile fit']);
    expect(d?.options).toHaveLength(4);
    expect(d?.options[0]).toMatchObject({ id: 'jwt', label: 'JWT in header', detail: 'Stateless' });
    expect(d?.options[0]?.scores).toEqual(['High', 'Low', 'Medium', 'High']);
    expect(d?.defaultOptionId).toBe('jwt');
    expect(cleanedText).not.toContain('cindy-matrix');
    expect(cleanedText).toContain('Compare these:');
    expect(cleanedText).toContain('Done');
  });

  it('parses a same-line matrix fence', () => {
    const { decisions } = parseDecisionBlocks(
      '```cindy-matrix{"matrix":{"title":"T?","criteria":["A","B"],"rows":[{"id":"x","label":"X","scores":["1","2"]},{"id":"y","label":"Y","scores":["3","4"]}]}}```',
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.criteria).toEqual(['A', 'B']);
    expect(decisions[0]?.options[1]?.scores).toEqual(['3', '4']);
  });

  it('strips an unparseable matrix without surfacing raw JSON', () => {
    const { decisions, cleanedText } = parseDecisionBlocks('```cindy-matrix\nnot json\n```');
    expect(decisions).toEqual([]);
    expect(cleanedText).not.toContain('not json');
  });

  it('drops matrices missing criteria or rows', () => {
    const { decisions } = parseDecisionBlocks(
      [
        '```cindy-matrix',
        '{"matrix":{"title":"No criteria","rows":[{"id":"x","label":"X"},{"id":"y","label":"Y"}]}}',
        '```',
        '```cindy-matrix',
        '{"matrix":{"title":"No rows","criteria":["A","B"]}}',
        '```',
        '```cindy-matrix',
        '{"matrix":{"title":"One row only","criteria":["A","B"],"rows":[{"id":"x","label":"X"}]}}',
        '```',
      ].join('\n'),
    );
    expect(decisions).toEqual([]);
  });

  it('trims row scores to the criteria width and drops empty cells', () => {
    const { decisions } = parseDecisionBlocks(
      '```cindy-matrix\n{"matrix":{"title":"T?","criteria":["A","B"],"rows":[{"id":"x","label":"X","scores":["1","2","extra"]},{"id":"y","label":"Y","scores":[null,""]}]}}\n```',
    );
    expect(decisions[0]?.options[0]?.scores).toEqual(['1', '2']);
    expect(decisions[0]?.options[1]?.scores).toBeUndefined();
  });

  it('parses decisions and matrix blocks in one message (ids dedupe across fences)', () => {
    const { decisions } = parseDecisionBlocks(`${BLOCK}\n${MATRIX}`);
    expect(decisions.map((d) => d.id)).toEqual(['auth', 'db', 'matrix']);
  });
});
