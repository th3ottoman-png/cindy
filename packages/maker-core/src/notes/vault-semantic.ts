/**
 * Local semantic and hybrid search engine for notes vault (ROADMAP 7.3).
 *
 * Implements local embedding caching in SQLite (vault-embeddings.db), cosine similarity,
 * a pure deterministic local fallback embedder (zero external network or cloud dependencies),
 * and Reciprocal Rank Fusion (RRF) hybrid search combining keyword and vector retrieval.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

import {
  checkNotePath,
  listNotes,
  searchNotes,
  type NoteError,
  type NoteInfo,
  type SearchHit,
} from './vault-notes.js';
import { redactSecrets } from '../export/session-markdown.js';

export interface EmbeddingClient {
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Compute cosine similarity between two vectors. */
export function cosineSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, sim));
}

/** Normalize a vector to unit length (L2 norm). */
export function normalizeVector(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i]! * vec[i]!;
  }
  if (norm === 0) return vec;
  const sqrt = Math.sqrt(norm);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i]! / sqrt;
  }
  return out;
}

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.byteLength; i++) {
    view[i] = buf[i]!;
  }
  return new Float32Array(ab);
}

/**
 * Fast deterministic local embedder (zero-cloud, zero-process fallback).
 * Uses character n-grams and token hashing with IDF-like term frequency
 * into a fixed dense vector space, normalized to unit length.
 */
export class DeterministicLocalEmbedder implements EmbeddingClient {
  readonly dimensions: number;

  constructor(dimensions = 128) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedSingle(text));
  }

  private embedSingle(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    const cleaned = text.toLowerCase().trim();
    if (!cleaned) return vec;

    const words = cleaned.split(/[\s,.;:!?()[\]{}"'`<>/\\]+/).filter((w) => w.length > 0);

    for (const word of words) {
      const wHash = this.fnv1a(word);
      const idx = Math.abs(wHash) % this.dimensions;
      const sign = (wHash & 1) === 0 ? 1 : -1;
      vec[idx] += sign * (1 + Math.log(word.length));

      // Character trigrams
      if (word.length >= 3) {
        for (let i = 0; i <= word.length - 3; i++) {
          const tri = word.slice(i, i + 3);
          const tHash = this.fnv1a(tri);
          const tIdx = Math.abs(tHash) % this.dimensions;
          const tSign = (tHash & 1) === 0 ? 0.5 : -0.5;
          vec[tIdx] += tSign;
        }
      }
    }

    return normalizeVector(vec);
  }

  private fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash;
  }
}

/**
 * HTTP Embedding client connecting to local OpenAI-compatible or Ollama embedding endpoints.
 * Automatically falls back to DeterministicLocalEmbedder if the local server is unreachable.
 */
export class HttpEmbeddingClient implements EmbeddingClient {
  readonly dimensions: number;
  private readonly fallback: DeterministicLocalEmbedder;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string = 'nomic-embed-text',
    dimensions = 768,
    private readonly endpointKind: 'ollama' | 'openai' = 'ollama',
  ) {
    this.dimensions = dimensions;
    this.fallback = new DeterministicLocalEmbedder(dimensions);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    try {
      if (this.endpointKind === 'ollama') {
        const url = new URL('/api/embed', this.baseUrl).toString();
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = (await res.json()) as { embeddings?: number[][] };
          if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
            return data.embeddings.map((arr) => normalizeVector(new Float32Array(arr)));
          }
        }
      } else {
        const url = new URL('/v1/embeddings', this.baseUrl).toString();
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
          if (Array.isArray(data.data) && data.data.length === texts.length) {
            return data.data.map((item) => normalizeVector(new Float32Array(item.embedding)));
          }
        }
      }
    } catch {
      // Fallback open on offline local server
    }
    return this.fallback.embed(texts);
  }
}

export interface SemanticSearchResult {
  path: string;
  similarity: number;
}

export interface StoredEmbeddingRow {
  path: string;
  mtime_ms: number;
  hash: string;
  embedding: Buffer;
  dimensions: number;
  updated_at_ms: number;
}

/**
 * SQLite-backed Vault Semantic Index storing dense note vectors.
 */
export class VaultSemanticIndex {
  private readonly embedder: EmbeddingClient;

  constructor(
    private readonly db: Database.Database,
    embedder?: EmbeddingClient,
  ) {
    this.embedder = embedder ?? new DeterministicLocalEmbedder();
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_embeddings (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_note_embeddings_mtime ON note_embeddings(mtime_ms);
      CREATE TABLE IF NOT EXISTS semantic_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Index a single note if newly added or modified. Returns true if indexed, false if skipped (cached). */
  async indexNote(relPath: string, content: string, mtimeMs: number): Promise<boolean> {
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    const existing = this.db
      .prepare('SELECT mtime_ms, hash FROM note_embeddings WHERE path = ?')
      .get(relPath) as { mtime_ms: number; hash: string } | undefined;

    if (existing && existing.mtime_ms === mtimeMs && existing.hash === hash) {
      return false;
    }

    const textToEmbed = `${relPath}\n${content.slice(0, 8000)}`;
    const [vec] = await this.embedder.embed([textToEmbed]);
    if (!vec) return false;

    const buf = float32ToBuffer(vec);
    this.db
      .prepare(
        `INSERT INTO note_embeddings (path, mtime_ms, hash, embedding, dimensions, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           hash = excluded.hash,
           embedding = excluded.embedding,
           dimensions = excluded.dimensions,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(relPath, mtimeMs, hash, buf, vec.length, Date.now());

    return true;
  }

  removeNote(relPath: string): void {
    this.db.prepare('DELETE FROM note_embeddings WHERE path = ?').run(relPath);
  }

  pruneMissing(existingPaths: Set<string>): number {
    const rows = this.db.prepare('SELECT path FROM note_embeddings').all() as Array<{ path: string }>;
    let pruned = 0;
    const del = this.db.prepare('DELETE FROM note_embeddings WHERE path = ?');
    for (const row of rows) {
      if (!existingPaths.has(row.path)) {
        del.run(row.path);
        pruned++;
      }
    }
    return pruned;
  }

  /** Query semantic similarity against all cached note vectors. */
  async search(
    query: string,
    opts: { limit?: number; minSimilarity?: number } = {},
  ): Promise<SemanticSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const [queryVec] = await this.embedder.embed([trimmed]);
    if (!queryVec) return [];

    const rows = this.db
      .prepare('SELECT path, embedding, dimensions FROM note_embeddings')
      .all() as Array<{ path: string; embedding: Buffer; dimensions: number }>;

    const results: SemanticSearchResult[] = [];
    const minSim = opts.minSimilarity ?? 0.05;

    for (const row of rows) {
      if (row.dimensions !== queryVec.length) continue;
      const docVec = bufferToFloat32(row.embedding);
      const similarity = cosineSimilarity(queryVec, docVec);
      if (similarity >= minSim) {
        results.push({ path: row.path, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return opts.limit !== undefined ? results.slice(0, opts.limit) : results;
  }

  /** Synchronize the SQLite embedding store against files in the vault. */
  async syncVault(
    vaultDir: string,
    listNotesFn: (dir: string) => NoteInfo[] | NoteError = listNotes,
  ): Promise<{ indexed: number; skipped: number; pruned: number }> {
    const notes = listNotesFn(vaultDir);
    if (!Array.isArray(notes)) {
      return { indexed: 0, skipped: 0, pruned: 0 };
    }

    const existingPaths = new Set(notes.map((n) => n.path));
    const pruned = this.pruneMissing(existingPaths);

    let indexed = 0;
    let skipped = 0;

    for (const note of notes) {
      const filePath = path.join(vaultDir, note.path);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const didIndex = await this.indexNote(note.path, content, note.mtimeMs);
      if (didIndex) indexed++;
      else skipped++;
    }

    return { indexed, skipped, pruned };
  }
}

export interface HybridSearchOptions {
  limit?: number;
  keywordWeight?: number;
  vectorWeight?: number;
  maxSnippets?: number;
  maxFileBytes?: number;
  minSimilarity?: number;
}

/**
 * Reciprocal Rank Fusion (RRF) hybrid search combining keyword search and semantic vector search.
 */
export async function hybridSearchVault(
  vaultDir: string,
  query: string,
  semanticIndex: VaultSemanticIndex | null,
  opts: HybridSearchOptions = {},
): Promise<SearchHit[] | NoteError> {
  const keywordHits = searchNotes(vaultDir, query, {
    maxSnippets: opts.maxSnippets,
    maxFileBytes: opts.maxFileBytes,
  });

  if (!Array.isArray(keywordHits) && !semanticIndex) {
    return keywordHits;
  }

  const validKeywordHits: SearchHit[] = Array.isArray(keywordHits) ? keywordHits : [];
  let semanticHits: SemanticSearchResult[] = [];

  if (semanticIndex) {
    try {
      semanticHits = await semanticIndex.search(query, {
        limit: opts.limit ? opts.limit * 2 : 50,
        minSimilarity: opts.minSimilarity,
      });
    } catch {
      semanticHits = [];
    }
  }

  // If no semantic hits, return keyword hits with matchType: 'keyword'
  if (semanticHits.length === 0) {
    return validKeywordHits.map((hit) => ({
      ...hit,
      matchType: 'keyword',
    }));
  }

  // Reciprocal Rank Fusion
  const RRF_K = 60;
  const kwWeight = opts.keywordWeight ?? 1.0;
  const vecWeight = opts.vectorWeight ?? 1.2;

  const scoreMap = new Map<
    string,
    {
      score: number;
      kwHit?: SearchHit;
      semHit?: SemanticSearchResult;
      matchType: 'keyword' | 'semantic' | 'hybrid';
    }
  >();

  validKeywordHits.forEach((hit, rank) => {
    const rrf = kwWeight / (RRF_K + (rank + 1));
    scoreMap.set(hit.path, {
      score: rrf,
      kwHit: hit,
      matchType: 'keyword',
    });
  });

  semanticHits.forEach((sem, rank) => {
    const rrf = vecWeight / (RRF_K + (rank + 1));
    const existing = scoreMap.get(sem.path);
    if (existing) {
      existing.score += rrf;
      existing.semHit = sem;
      existing.matchType = 'hybrid';
    } else {
      scoreMap.set(sem.path, {
        score: rrf,
        semHit: sem,
        matchType: 'semantic',
      });
    }
  });

  const merged: SearchHit[] = [];
  const maxSnippets = opts.maxSnippets ?? 3;

  for (const [filePath, data] of scoreMap.entries()) {
    let snippets: SearchHit['snippets'] = [];
    if (data.kwHit?.snippets?.length) {
      snippets = data.kwHit.snippets;
    } else {
      // For semantic-only matches, extract first non-empty lines as preview snippets
      try {
        const fullPath = path.join(vaultDir, filePath);
        if (fs.existsSync(fullPath)) {
          const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
          let count = 0;
          for (let i = 0; i < lines.length && count < maxSnippets; i++) {
            const line = lines[i]!.trim();
            if (line && !line.startsWith('---') && !line.startsWith('#')) {
              snippets.push({ line: i + 1, text: redactSecrets(line).slice(0, 200) });
              count++;
            }
          }
        }
      } catch {}
    }

    merged.push({
      path: filePath,
      score: Math.round(data.score * 10000),
      snippets,
      similarity: data.semHit ? Math.round(data.semHit.similarity * 1000) / 1000 : undefined,
      matchType: data.matchType,
    });
  }

  merged.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return opts.limit !== undefined ? merged.slice(0, opts.limit) : merged;
}
