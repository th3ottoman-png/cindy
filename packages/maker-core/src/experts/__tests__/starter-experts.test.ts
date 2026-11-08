import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadExperts } from '../expert-loader.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/experts-examples');

describe('docs/experts-examples', () => {
  it('ships the starter experts and every one loads cleanly', () => {
    const entries = loadExperts(EXAMPLES);
    expect(entries.map((e) => e.slug)).toEqual(['code-reviewer', 'expert-creator', 'options-first', 'orchestrator', 'prompt-engineer', 'repo-explainer', 'research-analyst', 'vault-researcher']);
    for (const entry of entries) {
      expect(entry.error, entry.slug).toBeUndefined();
      expect(entry.expert!.agent).toBe('hermes');
      expect(entry.expert!.description.length, entry.slug).toBeGreaterThan(10);
      expect(entry.expert!.prompt.length, entry.slug).toBeGreaterThan(200);
    }
  });

  it('only the expert creator (draft_expert, 3.8), Options first (project reader, 3.10d), the orchestrator (list_experts, 3.9b), and vault researcher (search/read/list notes, 6.1) list tools', () => {
    const withTools = loadExperts(EXAMPLES).filter((e) => (e.expert?.tools.length ?? 0) > 0);
    expect(withTools.map((e) => [e.slug, e.expert!.tools])).toEqual([
      ['expert-creator', ['draft_expert']],
      ['options-first', ['read_project_file', 'search_project']],
      ['orchestrator', ['list_experts']],
      ['vault-researcher', ['search_notes', 'read_note', 'list_notes']],
    ]);
  });

  it('the orchestrator delegates only through Hermes workers started as experts (ROADMAP 3.9b)', () => {
    const prompt = loadExperts(EXAMPLES).find((e) => e.slug === 'orchestrator')!.expert!.prompt;
    for (const needle of ['list_experts', 'create_worker', '`agent`: `"hermes"`', '`expert`', 'expert-creator', 'Depth one', '`worker_permission_mode`: `"bypassPermissions"`']) {
      expect(prompt, needle).toContain(needle);
    }
  });

  it('only Options first is locked, to toolsets that cannot write, run or act (ROADMAP 3.10)', () => {
    const locked = loadExperts(EXAMPLES).filter((e) => e.expert?.toolsets);
    expect(locked.map((e) => [e.slug, e.expert!.toolsets])).toEqual([['options-first', ['session_search', 'todo', 'web']]]);
    const prompt = locked[0]!.expert!.prompt;
    for (const needle of ['options', 'stop', 'Ask expert', 'Go ahead', 'read_project_file', 'search_project', 'cannot write']) expect(prompt, needle).toContain(needle);
    // ROADMAP 3.10d: the read-only project reader is the only Cindy tool it opts into.
    expect(locked[0]!.expert!.tools.sort()).toEqual(['read_project_file', 'search_project']);
  });

  it('only the research analyst keeps memory notes', () => {
    const memory = loadExperts(EXAMPLES).filter((e) => e.expert?.memory).map((e) => e.slug);
    expect(memory).toEqual(['research-analyst']);
  });
});
