import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteArtifact,
  getArtifactsDir,
  listArtifacts,
  readArtifact,
  saveArtifact,
} from '../artifact-store';

describe('artifact-store', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-artifacts-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempVault, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('resolves the artifacts directory within vault', () => {
    const dir = getArtifactsDir(tempVault);
    expect(dir).toBe(path.join(tempVault, 'Cindy', 'Artifacts'));
  });

  it('saves an artifact atomically with YAML frontmatter and redacts secrets', () => {
    const artifact = saveArtifact(tempVault, {
      title: 'Database Schema v2',
      content: 'Here is the schema for users.\nAPI_KEY=sk-ant-api03-secretvalue123456789012345678901234567890',
      type: 'schema',
      sessionId: 'test-session-123',
      tags: ['db', 'schema'],
    });

    expect(artifact.id).toMatch(/^\d{4}-\d{2}-\d{2}-database-schema-v2-[0-9a-f]{8}$/);
    expect(artifact.path).toBe(`Cindy/Artifacts/${artifact.id}.md`);
    expect(artifact.title).toBe('Database Schema v2');
    expect(artifact.type).toBe('schema');
    expect(artifact.sessionId).toBe('test-session-123');
    expect(artifact.tags).toEqual(['db', 'schema']);
    expect(artifact.content).not.toContain('sk-ant-api03-secretvalue123456789012345678901234567890');
    expect(artifact.content).toContain('[redacted]');

    // Check disk content
    const fullPath = path.join(tempVault, artifact.path);
    expect(fs.existsSync(fullPath)).toBe(true);
    const diskContent = fs.readFileSync(fullPath, 'utf8');
    expect(diskContent).toContain('title: "Database Schema v2"');
    expect(diskContent).toContain('type: schema');
    expect(diskContent).toContain('session_id: test-session-123');
  });

  it('lists stored artifacts ordered by mtime descending', () => {
    saveArtifact(tempVault, {
      id: 'art-1',
      title: 'First Artifact',
      content: 'First content',
      type: 'code',
    });

    saveArtifact(tempVault, {
      id: 'art-2',
      title: 'Second Artifact',
      content: 'Second content',
      type: 'diagram',
    });

    const list = listArtifacts(tempVault);
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.id).sort()).toEqual(['art-1', 'art-2']);
    expect(list.find((a) => a.id === 'art-1')?.type).toBe('code');
    expect(list.find((a) => a.id === 'art-2')?.type).toBe('diagram');
  });

  it('reads a stored artifact by id or path', () => {
    saveArtifact(tempVault, {
      id: 'my-doc',
      title: 'My Document',
      content: 'Detailed markdown specifications.',
      type: 'document',
    });

    const byId = readArtifact(tempVault, 'my-doc');
    expect(byId.title).toBe('My Document');
    expect(byId.content).toContain('Detailed markdown specifications.');

    const byPath = readArtifact(tempVault, 'Cindy/Artifacts/my-doc.md');
    expect(byPath.title).toBe('My Document');
  });

  it('deletes an artifact by id or path', () => {
    saveArtifact(tempVault, {
      id: 'to-delete',
      title: 'Temporary Note',
      content: 'Will be deleted',
    });

    expect(deleteArtifact(tempVault, 'to-delete')).toBe(true);
    expect(listArtifacts(tempVault)).toHaveLength(0);
    expect(deleteArtifact(tempVault, 'nonexistent')).toBe(false);
  });

  it('blocks directory traversal / escaping artifacts directory', () => {
    expect(() => {
      saveArtifact(tempVault, {
        id: '../../escape',
        title: 'Escape Attempt',
        content: 'Evil content',
      });
    }).not.toThrow(); // ID is sanitized so it cannot escape

    // Verify sanitized target does not escape
    const list = listArtifacts(tempVault);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('escape');
    expect(list[0].path).toBe('Cindy/Artifacts/escape.md');

    // Explicit path traversal read throws
    expect(() => {
      readArtifact(tempVault, '../../etc/passwd');
    }).toThrow(/escapes/);
  });
});
