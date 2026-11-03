import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadExperts } from '../expert-loader.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/experts-examples');

describe('docs/experts-examples', () => {
  it('ships the starter experts and every one loads cleanly', () => {
    const entries = loadExperts(EXAMPLES);
    expect(entries.map((e) => e.slug)).toEqual(['code-reviewer', 'expert-creator', 'orchestrator', 'prompt-engineer', 'repo-explainer', 'research-analyst']);
    for (const entry of entries) {
      expect(entry.error, entry.slug).toBeUndefined();
      expect(entry.expert!.agent).toBe('hermes');
      expect(entry.expert!.description.length, entry.slug).toBeGreaterThan(10);
      expect(entry.expert!.prompt.length, entry.slug).toBeGreaterThan(200);
    }
  });

  it('only the expert creator (draft_expert, 3.8) and the orchestrator (list_experts, 3.9b) list tools', () => {
    const withTools = loadExperts(EXAMPLES).filter((e) => (e.expert?.tools.length ?? 0) > 0);
    expect(withTools.map((e) => [e.slug, e.expert!.tools])).toEqual([
      ['expert-creator', ['draft_expert']],
      ['orchestrator', ['list_experts']],
    ]);
  });

  it('the orchestrator delegates only through Hermes workers started as experts (ROADMAP 3.9b)', () => {
    const prompt = loadExperts(EXAMPLES).find((e) => e.slug === 'orchestrator')!.expert!.prompt;
    for (const needle of ['list_experts', 'create_worker', '`agent`: `"hermes"`', '`expert`', 'expert-creator', 'Depth one', '`worker_permission_mode`: `"bypassPermissions"`']) {
      expect(prompt, needle).toContain(needle);
    }
  });

  it('only the research analyst keeps memory notes', () => {
    const memory = loadExperts(EXAMPLES).filter((e) => e.expert?.memory).map((e) => e.slug);
    expect(memory).toEqual(['research-analyst']);
  });
});
