import { describe, it, expect } from 'vitest';
import { PromptStructurerHost } from '../promptStructurer';
import { structureBrainDumpPrompt } from '@cindy/maker-core/prompt-structurer';

describe('promptStructurer live proof (ROADMAP 7.6)', () => {
  it('live structures an unstructured brain dump into a disciplined execution prompt', async () => {
    const host = new PromptStructurerHost();

    const unstructuredBrainDump = `
      So basically we need to build the screen share redaction mode for Cindy.
      The issue is that when users share screens during pair programming, secrets or API keys might get displayed.
      Never transmit unredacted frames to external networks and avoid third-party cloud OCR.
      Done when redaction masks render over detected secret patterns and unit tests pass.
    `;

    const result = await host.refinePrompt(unstructuredBrainDump);

    expect(result.raw).toBe(unstructuredBrainDump.trim());
    expect(result.sections.goal).toContain('Build the screen share redaction mode for Cindy');
    expect(result.sections.context).toContain('secrets or API keys might get displayed');
    expect(result.sections.guardrails.some((g) => g.toLowerCase().includes('never transmit'))).toBe(true);
    expect(result.sections.doneCriteria.some((d) => d.toLowerCase().includes('redaction masks render'))).toBe(true);

    // Verify markdown headers
    expect(result.structuredMarkdown).toMatch(/## Goal\n.+/);
    expect(result.structuredMarkdown).toMatch(/## Context & Background\n.+/);
    expect(result.structuredMarkdown).toMatch(/## Guardrails & Constraints\n- .+/);
    expect(result.structuredMarkdown).toMatch(/## Done Criteria\n- \[ \] .+/);
  });

  it('handles stream-of-consciousness thought fragments with casual filler', () => {
    const stream = 'um hey look i want to refactor the session compaction. because sessions get too huge. don\'t touch the original json files. verify that 100% tests pass.';
    const result = structureBrainDumpPrompt(stream);

    expect(result.sections.goal).toContain('Refactor the session compaction');
    expect(result.sections.guardrails.some((g) => g.toLowerCase().includes("don't touch"))).toBe(true);
    expect(result.sections.doneCriteria.some((d) => d.toLowerCase().includes('tests pass'))).toBe(true);
    expect(result.structuredMarkdown).toContain('## Goal');
  });
});
