import { describe, it, expect } from 'vitest';
import {
  splitThoughts,
  structureBrainDumpPrompt,
} from '../prompt-structurer.js';

describe('prompt-structurer', () => {
  describe('splitThoughts', () => {
    it('splits text by newlines and sentence punctuation', () => {
      const text = 'I want to build a feature. Because it is useful. Never do X; always do Y.';
      const thoughts = splitThoughts(text);
      expect(thoughts).toContain('I want to build a feature.');
      expect(thoughts).toContain('Because it is useful.');
      expect(thoughts).toContain('Never do X');
      expect(thoughts).toContain('always do Y.');
    });

    it('returns empty array for empty or whitespace text', () => {
      expect(splitThoughts('')).toEqual([]);
      expect(splitThoughts('   ')).toEqual([]);
    });
  });

  describe('structureBrainDumpPrompt', () => {
    it('structures stream-of-consciousness text into 4 clear sections', () => {
      const raw = `hey so basically I want to add a git sync button in cindy because right now we have to manually copy commits into Obsidian.
Don't touch any existing notes outside memory folder. Never make network calls.
Needs to pass all tests and update the project note.`;

      const result = structureBrainDumpPrompt(raw);

      expect(result.raw).toBe(raw);
      expect(result.sections.goal).toContain('Add a git sync button in cindy');
      expect(result.sections.context).toContain('manually copy commits');

      expect(result.sections.guardrails.some((g) => g.includes('outside memory folder'))).toBe(true);
      expect(result.sections.guardrails.some((g) => g.includes('Never make network calls'))).toBe(true);

      expect(result.sections.doneCriteria.some((d) => d.includes('pass all tests'))).toBe(true);

      // Verify Markdown formatting
      expect(result.structuredMarkdown).toContain('## Goal');
      expect(result.structuredMarkdown).toContain('## Context & Background');
      expect(result.structuredMarkdown).toContain('## Guardrails & Constraints');
      expect(result.structuredMarkdown).toContain('## Done Criteria');
      expect(result.structuredMarkdown).toContain('- [ ]');
    });

    it('handles short text with sensible defaults', () => {
      const raw = 'Create a script to backup sqlite database.';
      const result = structureBrainDumpPrompt(raw);

      expect(result.sections.goal).toBe('Create a script to backup sqlite database.');
      expect(result.sections.context).toBeTruthy();
      expect(result.sections.guardrails.length).toBeGreaterThan(0);
      expect(result.sections.doneCriteria.length).toBeGreaterThan(0);
      expect(result.structuredMarkdown).toContain('## Goal');
      expect(result.structuredMarkdown).toContain('Create a script to backup sqlite database.');
    });

    it('returns empty result when input is empty', () => {
      const result = structureBrainDumpPrompt('');
      expect(result.raw).toBe('');
      expect(result.structuredMarkdown).toBe('');
      expect(result.sections.goal).toBe('');
    });
  });
});
