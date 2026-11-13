import { describe, expect, it } from 'vitest';

import {
  CLEAN_SLATE_HANDOFF_MARKER,
  assembleSessionHandoff,
  estimateHandoffTokens,
  extractOpenQuestions,
  extractSynthesisSections,
  filterCompletedPendingSteps,
  isCleanSlateHandoffText,
  parseCleanSlateHandoffPendingSteps,
} from '../session-handoff';

const SYNTHESIS = [
  '# Synthesis',
  '',
  '## Key Decisions & Architecture',
  '',
  '- The daemon owns all writes to config.yaml.',
  '- Registry-driven adapters; no central switch statements.',
  '',
  '## Facts Learned & Environment Details',
  '',
  '- Node 22 only.',
  '',
  '## Open Questions & Blockers',
  '',
  '- Is the reviewer budget worth the latency?',
  '',
  '## Next Actions & Pending Tasks',
  '',
  '- Land 11.5 handoff payload.',
].join('\n');

const FIXED_TIME = '2026-11-11T20:00:00.000Z';

describe('estimateHandoffTokens', () => {
  it('estimates UTF-8 bytes over 4, rounded up', () => {
    expect(estimateHandoffTokens('')).toBe(0);
    expect(estimateHandoffTokens('a'.repeat(8))).toBe(2);
    expect(estimateHandoffTokens('整')).toBe(1); // 3 bytes
  });
});

describe('extractSynthesisSections', () => {
  it('maps the generated Synthesis.md sections onto the payload buckets', () => {
    const sections = extractSynthesisSections(SYNTHESIS);
    expect(sections.constraints).toContain('daemon owns all writes');
    expect(sections.constraints).not.toContain('Node 22');
    expect(sections.questions).toContain('reviewer budget');
    expect(sections.nextSteps).toContain('Land 11.5');
  });

  it('keeps hand-edited headings with equivalent wording', () => {
    const sections = extractSynthesisSections(
      '## Decisions\n\nUse SQLite.\n\n## Open questions\n\nWhen?\n\n## TODO\n\nWrite tests.',
    );
    expect(sections.constraints).toBe('Use SQLite.');
    expect(sections.questions).toBe('When?');
    expect(sections.nextSteps).toBe('Write tests.');
  });

  it('falls back to the whole note as constraints when nothing is recognised', () => {
    const sections = extractSynthesisSections('Just a hand-written note.\nWith no headings.');
    expect(sections.constraints).toContain('hand-written note');
    expect(sections.questions).toBe('');
    expect(sections.nextSteps).toBe('');
  });

  it('returns empty sections for an empty note', () => {
    expect(extractSynthesisSections('')).toEqual({
      constraints: '',
      questions: '',
      nextSteps: '',
    });
    expect(extractSynthesisSections('   ')).toEqual({
      constraints: '',
      questions: '',
      nextSteps: '',
    });
  });
});

describe('extractOpenQuestions', () => {
  it('keeps interrogative sentences from the final message only', () => {
    expect(
      extractOpenQuestions([
        { role: 'user', content: 'Is the sky blue?' },
        { role: 'assistant', content: 'Yes. Should we ship it today?' },
        { role: 'user', content: 'Ship it.' },
      ]),
    ).toEqual([]);
    expect(
      extractOpenQuestions([
        { role: 'user', content: 'Is the sky blue?' },
        { role: 'assistant', content: 'Yes. Should we ship it today?' },
      ]),
    ).toEqual(['Should we ship it today?']);
  });

  it('captures a final user question the model never answered', () => {
    expect(
      extractOpenQuestions([
        { role: 'user', content: 'Continue the build.' },
        { role: 'assistant', content: 'Working on it.' },
        { role: 'user', content: 'Which flavour should the footer use? Mint or lemon?' },
      ]),
    ).toEqual(['Which flavour should the footer use?', 'Mint or lemon?']);
  });

  it('returns nothing for tool turns and empty input', () => {
    expect(extractOpenQuestions([])).toEqual([]);
    expect(extractOpenQuestions([{ role: 'tool', content: 'ok? ok?' }])).toEqual([]);
    expect(extractOpenQuestions([{ role: 'assistant', content: 'No question here.' }])).toEqual([]);
  });
});

describe('assembleSessionHandoff', () => {
  const sources = {
    synthesis: SYNTHESIS,
    gitDiff:
      'diff --git a/roadmap.md b/roadmap.md\n--- a/roadmap.md\n+++ b/roadmap.md\n@@ -1 +1 @@\n-old\n+new',
    modifiedFiles: ['roadmap.md', 'status.md'],
    activeDecisions: ['Use the amber card for blast radius'],
    pendingNextSteps: ['Run the live proof'],
    unresolvedQuestions: ['Does the owner want Codex sessions seeded too?'],
    workingDir: '/work/cindy',
    sessionTitle: 'Phase 11 wrap-up',
    generatedAt: FIXED_TIME,
  };

  it('assembles every payload section in order', () => {
    const { prompt, tokenCount, truncated } = assembleSessionHandoff(sources);
    expect(prompt).toContain('# Session handoff — clean slate');
    expect(prompt).toContain('- Working directory: /work/cindy');
    expect(prompt).toContain(`- Handoff generated: ${FIXED_TIME}`);
    expect(prompt).toContain('- Handoff from session: Phase 11 wrap-up');
    const positions = [
      '## 1. Active decisions and architecture constraints',
      '## 2. Working tree state (uncommitted)',
      '## 3. Pending next steps',
      '## 4. Unresolved questions',
    ].map((heading) => prompt.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).toContain('daemon owns all writes');
    expect(prompt).toContain('- Use the amber card for blast radius');
    expect(prompt).toContain('Files with uncommitted changes (2):');
    expect(prompt).toContain('- roadmap.md');
    expect(prompt).toContain('- status.md');
    expect(prompt).toContain('+++ b/roadmap.md');
    expect(prompt).toContain('- Run the live proof');
    expect(prompt).toContain('Land 11.5 handoff payload');
    expect(prompt).toContain('- Does the owner want Codex sessions seeded too?');
    expect(prompt).toContain('reviewer budget');
    expect(truncated).toEqual({ diff: false, synthesis: false, payload: false });
    expect(tokenCount).toBe(estimateHandoffTokens(prompt));
    expect(tokenCount).toBeLessThanOrEqual(4000);
  });

  it('states None recorded. / No uncommitted changes. when a source is empty', () => {
    const { prompt } = assembleSessionHandoff({ generatedAt: FIXED_TIME });
    expect(prompt).toContain('None recorded.');
    expect(prompt).toContain('No uncommitted changes.');
    expect(prompt).toContain('- Working directory: unknown');
    expect(prompt).not.toContain('Handoff from session');
    expect(prompt.match(/None recorded\./g)?.length).toBe(4);
  });

  it('redacts secrets from every section', () => {
    const { prompt } = assembleSessionHandoff({
      synthesis:
        '## Key Decisions & Architecture\n\nUse sk-abcdefghijklmnopqrstuv for the API.' +
        '\n\n## Open Questions & Blockers\n\nWhat about Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig?',
      gitDiff: '+const conf = "api_key = \\"supersecret123\\"";\n+password: hunter2hunter2',
      modifiedFiles: ['config.yaml'],
      pendingNextSteps: ['Rotate the secret: token = "abcd1234efgh5678"'],
      unresolvedQuestions: ['Is the old sk-abcdefghijklmnopqrstuv still valid?'],
      workingDir: '/work',
      generatedAt: FIXED_TIME,
    });
    expect(prompt).not.toContain('abcdefghijklmnopqrstuv');
    expect(prompt).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(prompt).not.toContain('supersecret123');
    expect(prompt).not.toContain('hunter2hunter2');
    expect(prompt).not.toContain('abcd1234efgh5678');
    expect(prompt).toContain('[redacted]');
  });

  it('trims the diff first and says so when the budget is tight', () => {
    const bigDiff = Array.from(
      { length: 400 },
      (_, i) => `+line ${i} ${'x'.repeat(80)}`,
    ).join('\n');
    const { prompt, tokenCount, truncated } = assembleSessionHandoff(
      { ...sources, gitDiff: bigDiff },
      { maxPromptTokens: 500 },
    );
    expect(truncated.diff).toBe(true);
    expect(prompt).toContain('[diff truncated:');
    expect(tokenCount).toBeLessThanOrEqual(500);
    expect(prompt).toContain('daemon owns all writes');
    expect(prompt).toContain('- Does the owner want Codex sessions seeded too?');
  });

  it('never exceeds the budget even with multi-byte text', () => {
    const cjk = '整'.repeat(2000); // 3 bytes per character
    const { prompt, tokenCount, truncated } = assembleSessionHandoff(
      {
        synthesis: `## Key Decisions & Architecture\n\n${cjk}`,
        gitDiff: cjk,
        generatedAt: FIXED_TIME,
      },
      { maxPromptTokens: 300 },
    );
    expect(tokenCount).toBeLessThanOrEqual(300);
    expect(truncated.payload || truncated.diff || truncated.synthesis).toBe(true);
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('caps list items and marks the overflow', () => {
    const items = Array.from({ length: 60 }, (_, i) => `question ${i}`);
    const { prompt } = assembleSessionHandoff(
      { unresolvedQuestions: items, generatedAt: FIXED_TIME },
      { maxListItems: 10 },
    );
    expect(prompt).toContain('- question 0');
    expect(prompt).toContain('- question 9');
    expect(prompt).not.toContain('- question 10');
    expect(prompt).toContain('- [50 more items omitted]');
  });

  it('dedupes provided items', () => {
    const { prompt } = assembleSessionHandoff({
      pendingNextSteps: ['Do the thing', 'Do the thing', '  ', 'Do the thing '],
      generatedAt: FIXED_TIME,
    });
    expect(prompt.match(/- Do the thing/g)?.length).toBe(1);
  });

  it('fences the diff so author content cannot break the payload structure', () => {
    const { prompt } = assembleSessionHandoff({
      gitDiff: '+```js\ncode\n+```',
      generatedAt: FIXED_TIME,
    });
    expect(prompt).toContain('````diff');
    expect(prompt).toContain('````\n');
  });
});

describe('owner-stated constraints in section 1 (ROADMAP 11.5 follow-up)', () => {
  const base = {
    workingDir: '/work',
    generatedAt: FIXED_TIME,
    activeDecisions: ['Use the amber card for blast radius'],
  };

  it('renders the constraints above the decisions, verbatim', () => {
    const { prompt } = assembleSessionHandoff({
      ...base,
      constraints: ['Never commit, never touch any other file.'],
    });
    const section = prompt.slice(prompt.indexOf('## 1. Active decisions'));
    const constraintAt = section.indexOf('Owner-stated constraints (do not violate):');
    const decisionAt = section.indexOf('Use the amber card for blast radius');
    expect(constraintAt).toBeGreaterThan(-1);
    expect(constraintAt).toBeLessThan(decisionAt);
    expect(section).toContain('- Never commit, never touch any other file.');
  });

  it('shows the constraint group only when constraints were recorded', () => {
    expect(assembleSessionHandoff({ ...base }).prompt).toContain('None recorded.');
    expect(assembleSessionHandoff({ ...base }).prompt).not.toContain('Owner-stated constraints');
    expect(
      assembleSessionHandoff({ ...base, constraints: ['Never commit.'] }).prompt,
    ).toContain('Owner-stated constraints (do not violate):');
  });

  it('redacts a secret that appears in a constraint', () => {
    const { prompt } = assembleSessionHandoff({
      ...base,
      constraints: ['Never paste api_key="sk-abcdefghijklmnopqrstuvwx" into a chat.'],
    });
    expect(prompt).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });
});

describe('clean-slate payload round-trip (ROADMAP 11.5 follow-up)', () => {
  const payload = () =>
    assembleSessionHandoff({
      workingDir: '/work',
      generatedAt: FIXED_TIME,
      pendingNextSteps: ['Append beta to notes.txt', 'Run the gates'],
    }).prompt;

  it('stamps a marker a later handoff can recognise', () => {
    expect(payload().startsWith(CLEAN_SLATE_HANDOFF_MARKER)).toBe(true);
    expect(isCleanSlateHandoffText(payload())).toBe(true);
    expect(isCleanSlateHandoffText('Step 1 now: append alpha. Never commit.')).toBe(false);
  });

  it('recognises a payload written before the marker existed', () => {
    expect(isCleanSlateHandoffText('# Session handoff — clean slate\n\nstuff')).toBe(true);
  });

  it('reads back the pending steps from section 3', () => {
    expect(parseCleanSlateHandoffPendingSteps(payload())).toEqual([
      'Append beta to notes.txt',
      'Run the gates',
    ]);
  });

  it('drops carried steps the later turns already report as done', () => {
    const later = [
      { role: 'user', content: 'Go on.' },
      { role: 'assistant', content: 'Step 1 done — I appended beta to notes.txt.' },
    ];
    expect(
      filterCompletedPendingSteps(['Append beta to notes.txt', 'Run the gates'], later),
    ).toEqual(['Run the gates']);
  });

  it('keeps a step when no later turn reports it (never silently drops work)', () => {
    const later = [{ role: 'assistant', content: 'Appended alpha to notes.txt.' }];
    expect(filterCompletedPendingSteps(['Append beta to notes.txt'], later)).toEqual([
      'Append beta to notes.txt',
    ]);
  });

  it('ignores completion words that belong to another step', () => {
    const later = [{ role: 'assistant', content: 'Done. Run the gates next.' }];
    expect(filterCompletedPendingSteps(['Run the gates'], later)).toEqual(['Run the gates']);
  });
});
