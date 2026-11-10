import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteArtifact,
  listArtifacts,
  readArtifact,
  saveArtifact,
} from '@cindy/maker-core/artifact-store';
import {
  libraryEntryToken,
  libraryKindSummary,
  searchLibrary,
} from '@cindy/maker-core/library-index';

import { scanLibrary } from '../library';

/**
 * Live proof test for ROADMAP 8.5b (Library Artifacts).
 *
 * Verifies that an artifact stored in the vault artifact store (`Cindy/Artifacts/`)
 * appears seamlessly in the Library alongside vault notes, auto-saved chats,
 * and generated summaries, with correct kind classification, filtering,
 * keyword searching, citations, and drag token generation.
 */
describe('ROADMAP 8.5b Live Proof — Library Artifacts', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-library-artifacts-live-'));

    // Populate standard vault notes
    fs.mkdirSync(path.join(tempVault, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(tempVault, 'memory', 'Project — Cindy.md'),
      '---\ntitle: Project — Cindy\ntags: [project]\n---\n# Project\nCore roadmap.',
      'utf8',
    );

    // Populate auto-saved chat transcript
    fs.mkdirSync(path.join(tempVault, 'Cindy', 'Chats'), { recursive: true });
    fs.writeFileSync(
      path.join(tempVault, 'Cindy', 'Chats', '2026-11-08-session-1-abcd1234.md'),
      '---\ntitle: Design session\n---\nWe designed the System Architecture Diagram today.',
      'utf8',
    );

    // Populate auto-generated summary
    fs.mkdirSync(path.join(tempVault, 'Cindy', 'Memory'), { recursive: true });
    fs.writeFileSync(
      path.join(tempVault, 'Cindy', 'Memory', '2026-11-08-session-1-abcd1234-summary.md'),
      '---\ntitle: Summary\n---\nSummary of session 1.',
      'utf8',
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempVault, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('proves live artifact store creation, library scanning, indexing, search, citation, and deletion', () => {
    // 1. Initial scan has 3 kinds (note, chat, summary), 0 artifacts
    const initialScan = scanLibrary(tempVault);
    expect(initialScan.ok).toBe(true);
    const initialSummary = libraryKindSummary(initialScan.entries);
    expect(initialSummary.map((s) => s.kind)).toEqual(['note', 'chat', 'summary']);

    // 2. Save an artifact into the vault artifact store
    const saved = saveArtifact(tempVault, {
      id: 'system-architecture-diagram',
      title: 'System Architecture Diagram',
      content: 'Core architecture and component topology overview.\n\n```mermaid\ngraph TD\n  Client --> Gateway\n  Gateway --> Hermes\n```',
      type: 'diagram',
      tags: ['architecture', 'diagram'],
    });

    expect(saved.id).toBe('system-architecture-diagram');
    expect(saved.path).toBe('Cindy/Artifacts/system-architecture-diagram.md');

    // Verify artifact is readable via artifact-store
    const stored = readArtifact(tempVault, 'system-architecture-diagram');
    expect(stored.title).toBe('System Architecture Diagram');
    expect(stored.content).toContain('graph TD');

    // 3. Scan library again - now includes all 4 sources: note, chat, summary, artifact!
    const scanWithArtifact = scanLibrary(tempVault);
    expect(scanWithArtifact.ok).toBe(true);
    expect(scanWithArtifact.entries).toHaveLength(4);

    const artifactEntry = scanWithArtifact.entries.find(
      (e) => e.path === 'Cindy/Artifacts/system-architecture-diagram.md',
    );
    expect(artifactEntry).toBeDefined();
    expect(artifactEntry?.kind).toBe('artifact');
    expect(artifactEntry?.title).toBe('System Architecture Diagram');
    expect(artifactEntry?.excerpt).toContain('Core architecture and component topology overview.');
    expect(artifactEntry?.tags).toEqual(['architecture', 'diagram']);

    // 4. Verify kind summary includes artifact with count 1
    const summary = libraryKindSummary(scanWithArtifact.entries);
    expect(summary).toEqual([
      { kind: 'note', count: 1 },
      { kind: 'chat', count: 1 },
      { kind: 'summary', count: 1 },
      { kind: 'artifact', count: 1 },
    ]);

    // 5. Verify search finds the artifact by keyword
    const searchResults = searchLibrary(scanWithArtifact.entries, 'architecture');
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].path).toBe('Cindy/Artifacts/system-architecture-diagram.md');

    // 6. Verify citation detection: the chat transcript mentioned "System Architecture Diagram"
    expect(artifactEntry?.citations).toEqual([
      'Cindy/Chats/2026-11-08-session-1-abcd1234.md',
    ]);

    // 7. Verify drag token generation
    const token = libraryEntryToken(artifactEntry!);
    expect(token).toBe('@vault-note:Cindy/Artifacts/system-architecture-diagram.md');

    // 8. Delete the artifact and verify library updates
    const deleted = deleteArtifact(tempVault, 'system-architecture-diagram');
    expect(deleted).toBe(true);

    const postDeleteScan = scanLibrary(tempVault);
    expect(postDeleteScan.entries).toHaveLength(3);
    expect(
      postDeleteScan.entries.find((e) => e.path === 'Cindy/Artifacts/system-architecture-diagram.md'),
    ).toBeUndefined();
  });
});
