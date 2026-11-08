import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPinnedNotesPreamble,
  getPinnedNotesForSession,
  loadPinnedNotes,
  pinNoteToSession,
  quickCaptureNote,
  savePinnedNotes,
  unpinNoteFromSession,
} from '../vault-capture';

describe('vault-capture', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-capture-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('quickCaptureNote', () => {
    it('creates a new target note when it does not exist', () => {
      const res = quickCaptureNote(tmpDir, {
        content: 'Remember to verify sqlite db indexes.',
        targetFile: 'Inbox.md',
        tags: ['db', '#perf'],
        title: 'DB Optimization',
        sourceSessionId: 'sess-1234',
        sourceSessionTitle: 'Backend Architecture',
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.relPath).toBe('Inbox.md');
      expect(res.created).toBe(true);

      const content = fs.readFileSync(path.join(tmpDir, 'Inbox.md'), 'utf8');
      expect(content).toContain('# Inbox');
      expect(content).toContain('### Captured');
      expect(content).toContain('— DB Optimization');
      expect(content).toContain('> Source: "Backend Architecture" (`sess-1234`)');
      expect(content).toContain('#db #perf');
      expect(content).toContain('Remember to verify sqlite db indexes.');
    });

    it('appends to an existing note without overwriting prior content', () => {
      const target = path.join(tmpDir, 'Inbox.md');
      fs.writeFileSync(target, '# Inbox\n\nInitial capture item.\n', 'utf8');

      const res = quickCaptureNote(tmpDir, {
        content: 'Second quick captured thought.',
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.created).toBe(false);

      const content = fs.readFileSync(target, 'utf8');
      expect(content).toContain('Initial capture item.');
      expect(content).toContain('Second quick captured thought.');
    });

    it('redacts obvious secrets in captured content', () => {
      const res = quickCaptureNote(tmpDir, {
        content: 'Production key is sk-ant-api03-1234567890abcdef1234567890abcdef1234567890abcdef.',
      });

      expect(res.ok).toBe(true);
      const content = fs.readFileSync(path.join(tmpDir, 'Inbox.md'), 'utf8');
      expect(content).not.toContain('sk-ant-api03-1234567890abcdef1234567890abcdef1234567890abcdef');
      expect(content).toContain('[redacted]');
    });

    it('rejects invalid, empty, or oversized content', () => {
      expect(quickCaptureNote(tmpDir, { content: '' }).ok).toBe(false);
      expect(quickCaptureNote(tmpDir, { content: '   ' }).ok).toBe(false);
      expect(quickCaptureNote(tmpDir, { content: 'a'.repeat(9000) }).ok).toBe(false);
    });

    it('rejects path traversal attempts outside vault', () => {
      const res = quickCaptureNote(tmpDir, {
        content: 'Malicious content',
        targetFile: '../escaped.md',
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('outside-vault');
    });
  });

  describe('pinned-notes state', () => {
    it('loads safely from nonexistent or empty file', () => {
      const nonExistent = path.join(tmpDir, 'pinned.json');
      const config = loadPinnedNotes(nonExistent);
      expect(config.sessions).toEqual({});
      expect(config.globalPins).toEqual([]);
    });

    it('pins and unpins notes per session atomically', () => {
      const configFile = path.join(tmpDir, 'pinned.json');

      const pinRes1 = pinNoteToSession(configFile, 'session-a', 'docs/spec.md');
      expect(pinRes1.ok).toBe(true);
      expect(pinRes1.pinnedNotes).toEqual(['docs/spec.md']);

      const pinRes2 = pinNoteToSession(configFile, 'session-a', 'docs/architecture.md');
      expect(pinRes2.ok).toBe(true);
      expect(pinRes2.pinnedNotes).toEqual(['docs/spec.md', 'docs/architecture.md']);

      // Deduplication check
      const pinResDup = pinNoteToSession(configFile, 'session-a', 'docs/spec.md');
      expect(pinResDup.pinnedNotes).toEqual(['docs/spec.md', 'docs/architecture.md']);

      const retrieved = getPinnedNotesForSession(configFile, 'session-a');
      expect(retrieved).toEqual(['docs/spec.md', 'docs/architecture.md']);

      // Unpin
      const unpinRes = unpinNoteFromSession(configFile, 'session-a', 'docs/spec.md');
      expect(unpinRes.ok).toBe(true);
      expect(unpinRes.pinnedNotes).toEqual(['docs/architecture.md']);

      const afterUnpin = getPinnedNotesForSession(configFile, 'session-a');
      expect(afterUnpin).toEqual(['docs/architecture.md']);
    });
  });

  describe('buildPinnedNotesPreamble', () => {
    it('assembles formatted markdown envelopes from existing vault notes', () => {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs', 'spec.md'), '# Spec\nCore specification rules.\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'todo.md'), '# Todo\n- Item 1\n- Item 2\n', 'utf8');

      const preamble = buildPinnedNotesPreamble(tmpDir, ['docs/spec.md', 'todo.md']);
      expect(preamble).toContain('The following reference notes are pinned');
      expect(preamble).toContain('[Pinned Vault Note: docs/spec.md]');
      expect(preamble).toContain('Core specification rules.');
      expect(preamble).toContain('[/Pinned Vault Note: docs/spec.md]');
      expect(preamble).toContain('[Pinned Vault Note: todo.md]');
      expect(preamble).toContain('- Item 1');
    });

    it('returns empty string when no notes are provided or found', () => {
      expect(buildPinnedNotesPreamble(tmpDir, [])).toBe('');
      expect(buildPinnedNotesPreamble(tmpDir, ['missing.md'])).toBe('');
    });
  });
});
