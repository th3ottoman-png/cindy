import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bufferToFloat32,
  cosineSimilarity,
  DeterministicLocalEmbedder,
  float32ToBuffer,
  hybridSearchVault,
  normalizeVector,
  VaultSemanticIndex,
} from '../vault-semantic';

describe('Vector utilities', () => {
  it('computes cosine similarity accurately', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    const d = new Float32Array([-1, 0, 0]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0.0);
    expect(cosineSimilarity(a, d)).toBeCloseTo(-1.0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1]))).toBe(0);
  });

  it('normalizes vector to unit length', () => {
    const vec = new Float32Array([3, 4]);
    const norm = normalizeVector(vec);
    expect(norm[0]).toBeCloseTo(0.6);
    expect(norm[1]).toBeCloseTo(0.8);

    const zero = new Float32Array([0, 0, 0]);
    expect(normalizeVector(zero)).toEqual(zero);
  });

  it('roundtrips Float32Array to Buffer and back losslessly', () => {
    const original = new Float32Array([0.123, -4.567, 89.1011]);
    const buf = float32ToBuffer(original);
    const restored = bufferToFloat32(buf);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });
});

describe('DeterministicLocalEmbedder', () => {
  it('generates normalized embeddings of configured dimensions', async () => {
    const embedder = new DeterministicLocalEmbedder(128);
    const [vec] = await embedder.embed(['Architecture and system design principles']);

    expect(vec).toBeDefined();
    expect(vec!.length).toBe(128);

    let sumSq = 0;
    for (const v of vec!) sumSq += v * v;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 3);
  });

  it('scores semantically related sentences higher than unrelated sentences', async () => {
    const embedder = new DeterministicLocalEmbedder(128);
    const [query, similar, different] = await embedder.embed([
      'deploy application to cloud container',
      'docker deployment and container orchestration',
      'baking chocolate cake with strawberry frosting',
    ]);

    const simScore = cosineSimilarity(query!, similar!);
    const diffScore = cosineSimilarity(query!, different!);

    expect(simScore).toBeGreaterThan(diffScore);
  });
});

describe('VaultSemanticIndex & SQLite storage', () => {
  let tmpDir: string;
  let vaultDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-semantic-test-'));
    vaultDir = path.join(tmpDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes tables and indexes notes with cache skip on unchanged mtime', async () => {
    const index = new VaultSemanticIndex(db);
    index.init();

    const note1 = 'Legal compliance guidelines and audit standards.';
    const didIndex1 = await index.indexNote('docs/legal.md', note1, 1000);
    expect(didIndex1).toBe(true);

    // Second call with same mtime and content should skip
    const didIndex2 = await index.indexNote('docs/legal.md', note1, 1000);
    expect(didIndex2).toBe(false);

    // Call with modified mtime or content should re-index
    const didIndex3 = await index.indexNote('docs/legal.md', note1 + ' Updated.', 2000);
    expect(didIndex3).toBe(true);
  });

  it('searches indexed notes and prunes deleted notes', async () => {
    const index = new VaultSemanticIndex(db);
    index.init();

    await index.indexNote('infra/k8s.md', 'Kubernetes cluster deployment and helm charts', 1000);
    await index.indexNote('recipes/pasta.md', 'Boil salted water and cook spaghetti al dente', 1000);

    const hits = await index.search('container cluster orchestration', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe('infra/k8s.md');

    // Pruning
    const pruned = index.pruneMissing(new Set(['recipes/pasta.md']));
    expect(pruned).toBe(1);

    const hitsAfter = await index.search('container cluster orchestration');
    expect(hitsAfter.some((h) => h.path === 'infra/k8s.md')).toBe(false);
  });

  it('syncs all notes from a real vault directory', async () => {
    fs.writeFileSync(path.join(vaultDir, 'a.md'), 'Machine learning model training and inference pipelines');
    fs.writeFileSync(path.join(vaultDir, 'b.md'), 'Tax accounting and quarterly financial reports');

    const index = new VaultSemanticIndex(db);
    index.init();

    const sync1 = await index.syncVault(vaultDir);
    expect(sync1.indexed).toBe(2);
    expect(sync1.skipped).toBe(0);

    // Re-sync without changes should skip both
    const sync2 = await index.syncVault(vaultDir);
    expect(sync2.indexed).toBe(0);
    expect(sync2.skipped).toBe(2);
  });
});

describe('hybridSearchVault', () => {
  let tmpDir: string;
  let vaultDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-hybrid-test-'));
    vaultDir = path.join(tmpDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('combines keyword matches and conceptual semantic matches using RRF', async () => {
    // Note 1 contains exact keyword "kubernetes"
    fs.writeFileSync(path.join(vaultDir, 'k8s.md'), '# Infrastructure\nDetailed guide to kubernetes nodes and pods.');
    // Note 2 is conceptual: discusses container orchestration without saying "kubernetes"
    fs.writeFileSync(path.join(vaultDir, 'cloud.md'), '# Cloud Platform\nContainer orchestration and automated cluster scaling across nodes.');
    // Note 3 is unrelated
    fs.writeFileSync(path.join(vaultDir, 'gardening.md'), '# Plants\nWatering tomatoes and soil nutrient balance.');

    const index = new VaultSemanticIndex(db);
    index.init();
    await index.syncVault(vaultDir);

    // Query for "kubernetes" -> k8s.md will match keyword + semantic; cloud.md matches semantic
    const results = await hybridSearchVault(vaultDir, 'kubernetes', index, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    const hits = results as Array<{ path: string; matchType?: string; similarity?: number }>;

    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.path).toBe('k8s.md');
    expect(hits[0]!.matchType).toBe('hybrid');

    const cloudHit = hits.find((h) => h.path === 'cloud.md');
    expect(cloudHit).toBeDefined();
    expect(cloudHit!.matchType).toBe('semantic');
  });

  it('fails open to keyword search if semantic index is null', async () => {
    fs.writeFileSync(path.join(vaultDir, 'test.md'), 'Keyword alpha appears here.');

    const results = await hybridSearchVault(vaultDir, 'alpha', null);
    expect(Array.isArray(results)).toBe(true);
    const hits = results as Array<{ path: string; matchType?: string }>;

    expect(hits.length).toBe(1);
    expect(hits[0]!.path).toBe('test.md');
    expect(hits[0]!.matchType).toBe('keyword');
  });
});
