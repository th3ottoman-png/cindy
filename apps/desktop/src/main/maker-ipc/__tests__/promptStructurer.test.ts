import { describe, it, expect, vi } from 'vitest';
import { PromptStructurerHost, registerPromptStructurerHandlers } from '../promptStructurer';
import { MAKER_INVOKE } from '../channels';

describe('PromptStructurerHost', () => {
  it('structures raw brain-dump text into goal, context, guardrails, done criteria', async () => {
    const host = new PromptStructurerHost();
    const raw = `
      Hey so basically I want to implement git sync with the notes vault.
      Right now notes and git are completely separated and that's annoying.
      Don't use any external network calls and avoid cloud telemetry.
      Done when all unit tests pass and live proof is verified.
    `;

    const res = await host.refinePrompt(raw);
    expect(res.raw).toBe(raw.trim());
    expect(res.sections.goal).toContain('Implement git sync with the notes vault');
    expect(res.sections.guardrails.some((g) => g.toLowerCase().includes("don't use any external"))).toBe(true);
    expect(res.sections.doneCriteria.some((d) => d.toLowerCase().includes('all unit tests pass'))).toBe(true);
    expect(res.structuredMarkdown).toContain('## Goal');
    expect(res.structuredMarkdown).toContain('## Context & Background');
    expect(res.structuredMarkdown).toContain('## Guardrails & Constraints');
    expect(res.structuredMarkdown).toContain('## Done Criteria');
  });

  it('uses model output when refineWithModel returns valid draft', async () => {
    const mockModel = vi.fn().mockResolvedValue(`
      Create automatic session compaction.
      Because long sessions hit context limits.
      Never delete original session files.
      Done when tests pass.
    `);

    const host = new PromptStructurerHost({ refineWithModel: mockModel });
    const res = await host.refinePrompt('rough messy thoughts');

    expect(mockModel).toHaveBeenCalledWith('rough messy thoughts');
    expect(res.sections.goal).toContain('Create automatic session compaction');
    expect(res.structuredMarkdown).toContain('## Goal');
  });

  it('falls back to deterministic structurer when model throws', async () => {
    const mockModel = vi.fn().mockRejectedValue(new Error('Model offline'));

    const host = new PromptStructurerHost({ refineWithModel: mockModel });
    const res = await host.refinePrompt('Please fix the broken build. Make sure not to touch node 24.');

    expect(res.sections.goal).toContain('Fix the broken build');
    expect(res.sections.guardrails.some((g) => g.includes('touch node 24'))).toBe(true);
  });

  it('registers IPC handler and invokes refinePrompt', async () => {
    const host = new PromptStructurerHost();
    const handlers: Record<string, Function> = {};
    const mockIpc = {
      handle: (channel: string, fn: Function) => {
        handlers[channel] = fn;
      },
    } as any;

    const assertSenderTrusted = vi.fn();
    registerPromptStructurerHandlers(mockIpc, () => host, assertSenderTrusted);

    expect(handlers[MAKER_INVOKE.PROMPT_STRUCTURER_REFINE]).toBeTypeOf('function');

    const result = await handlers[MAKER_INVOKE.PROMPT_STRUCTURER_REFINE](
      { senderFrame: {} },
      { text: 'I want to build screen redaction. Avoid recording passwords.' },
    );

    expect(assertSenderTrusted).toHaveBeenCalled();
    expect(result.sections.goal).toContain('Build screen redaction');
    expect(result.structuredMarkdown).toContain('## Goal');
  });
});
