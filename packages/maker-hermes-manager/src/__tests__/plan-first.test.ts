import { describe, expect, it } from 'vitest';

import {
  applyPlanFirstInstruction,
  PLAN_FIRST_DECISIONS_EXAMPLE,
  PLAN_FIRST_DECISIONS_FENCE,
  PLAN_FIRST_LOCK_REASON,
  PLAN_FIRST_TURN_INSTRUCTION,
} from '../plan-first.js';
import { toolCallPaths } from '../risk-paths.js';

function locked(toolName: string, toolInput: unknown): boolean {
  // Mirrors the reviewOrGuard Plan First clause: locked + any write path = blocked.
  return toolCallPaths({ toolName, toolInput }).length > 0;
}

describe('plan-first instruction (ROADMAP 11.7)', () => {
  it('names the fence and keeps owner text byte-identical below it', () => {
    const out = applyPlanFirstInstruction('Build user auth');
    expect(out.startsWith(PLAN_FIRST_TURN_INSTRUCTION)).toBe(true);
    expect(out.endsWith('\n\nBuild user auth')).toBe(true);
    expect(PLAN_FIRST_TURN_INSTRUCTION).toContain('```' + PLAN_FIRST_DECISIONS_FENCE);
  });

  it('teaches a parseable decisions schema with an example', () => {
    const parsed = JSON.parse(PLAN_FIRST_DECISIONS_EXAMPLE) as {
      decisions: Array<{ id: string; question: string; options: Array<{ id: string }> }>;
    };
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0]?.options.map((o) => o.id)).toEqual(['jwt', 'session']);
    expect(PLAN_FIRST_TURN_INSTRUCTION).toContain('defaultOptionId');
  });

  it('lock reason points at the decision UI, not at retrying', () => {
    expect(PLAN_FIRST_LOCK_REASON).toMatch(/decision cards|proceed/i);
    expect(PLAN_FIRST_LOCK_REASON).toMatch(/do not retry/i);
  });
});

describe('plan-first lock coverage (ROADMAP 11.7)', () => {
  it('locks every file-writing tool', () => {
    for (const tool of ['write_file', 'patch', 'edit', 'apply_patch', 'create_file', 'remove_file']) {
      expect(locked(tool, { path: 'src/auth.ts' })).toBe(true);
    }
  });

  it('locks terminal writes through the shell', () => {
    expect(locked('terminal', { command: 'echo x >> src/auth.ts' })).toBe(true);
    expect(locked('bash', { command: 'cat > /tmp/proofs/handoff-work/README.md' })).toBe(true);
  });

  it('leaves reads and listings unlocked', () => {
    expect(locked('read_file', { path: 'src/auth.ts' })).toBe(false);
    expect(locked('terminal', { command: 'ls -la src' })).toBe(false);
    expect(locked('terminal', { command: 'cat src/auth.ts' })).toBe(false);
  });
});
