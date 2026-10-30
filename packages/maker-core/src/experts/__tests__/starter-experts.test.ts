import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadExperts } from '../expert-loader.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/experts-examples');

describe('docs/experts-examples', () => {
  it('ships the four starter experts and every one loads cleanly', () => {
    const entries = loadExperts(EXAMPLES);
    expect(entries.map((e) => e.slug)).toEqual(['code-reviewer', 'prompt-engineer', 'repo-explainer', 'research-analyst']);
    for (const entry of entries) {
      expect(entry.error, entry.slug).toBeUndefined();
      expect(entry.expert!.agent).toBe('hermes');
      expect(entry.expert!.description.length, entry.slug).toBeGreaterThan(10);
      expect(entry.expert!.prompt.length, entry.slug).toBeGreaterThan(200);
    }
  });

  it('only the research analyst keeps memory notes', () => {
    const memory = loadExperts(EXAMPLES).filter((e) => e.expert?.memory).map((e) => e.slug);
    expect(memory).toEqual(['research-analyst']);
  });
});
