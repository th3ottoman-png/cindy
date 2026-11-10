/**
 * Local-first, file-backed artifact store (ROADMAP 8.5b).
 *
 * Stores conversation deliverables, diagrams, code snippets, schemas, and
 * documents in the user's notes vault under `<vault>/Cindy/Artifacts/<id>.md`.
 *
 * Each artifact is a plain Markdown file with YAML frontmatter (title, type,
 * session_id, created_at, tags).
 *
 * Strict containment: paths stay inside `<vault>/Cindy/Artifacts/`.
 * Atomic writes: `.tmp.<pid>.<uuid>` then `fs.renameSync`.
 * Secrets redacted before persisting.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactSecrets } from '../export/session-markdown.js';

export const ARTIFACTS_SUBDIR = 'Cindy/Artifacts';

export interface ArtifactMetadata {
  title: string;
  type: string;
  sessionId?: string;
  createdAt: string;
  tags: string[];
}

export interface StoredArtifactHeader {
  id: string;
  path: string; // vault-relative path: Cindy/Artifacts/<id>.md
  title: string;
  type: string;
  sessionId?: string;
  createdAt: string;
  tags: string[];
  mtimeMs: number;
}

export interface StoredArtifact extends StoredArtifactHeader {
  content: string;
}

export interface SaveArtifactInput {
  id?: string;
  title: string;
  content: string;
  type?: string;
  sessionId?: string;
  tags?: readonly string[];
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 50) || 'artifact';
}

function resolveArtifactsDir(vaultDir: string): string {
  if (!vaultDir || !vaultDir.trim()) {
    throw new Error('No vault directory specified');
  }
  const root = path.resolve(vaultDir);
  const artifactsDir = path.resolve(root, ARTIFACTS_SUBDIR);
  // Containment check
  if (!artifactsDir.startsWith(root)) {
    throw new Error('Artifacts directory escapes vault root');
  }
  return artifactsDir;
}

export function getArtifactsDir(vaultDir: string): string {
  return resolveArtifactsDir(vaultDir);
}

function ensureArtifactsDir(vaultDir: string): string {
  const dir = resolveArtifactsDir(vaultDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeId(id: string): string {
  const base = path.basename(id).replace(/\.md$/i, '');
  const clean = base.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return clean || `artifact-${Date.now()}`;
}

function parseFrontmatter(raw: string): { metadata: Partial<ArtifactMetadata>; content: string } {
  if (!raw.startsWith('---')) {
    return { metadata: {}, content: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    return { metadata: {}, content: raw };
  }
  const yamlBlock = raw.slice(3, end).trim();
  const content = raw.slice(end + 4).replace(/^\r?\n/, '');

  const metadata: Partial<ArtifactMetadata> = {};
  const tags: string[] = [];

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'title') metadata.title = value.replace(/^['"]|['"]$/g, '');
    else if (key === 'type') metadata.type = value.replace(/^['"]|['"]$/g, '');
    else if (key === 'sessionId' || key === 'session_id') {
      metadata.sessionId = value.replace(/^['"]|['"]$/g, '');
    } else if (key === 'createdAt' || key === 'created_at') {
      metadata.createdAt = value.replace(/^['"]|['"]$/g, '');
    } else if (key === 'tags') {
      if (value.startsWith('[') && value.endsWith(']')) {
        const items = value
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        tags.push(...items);
      }
    }
  }

  metadata.tags = tags;
  return { metadata, content };
}

function formatFrontmatter(meta: ArtifactMetadata): string {
  const lines = ['---'];
  lines.push(`title: ${JSON.stringify(meta.title)}`);
  lines.push(`type: ${meta.type || 'document'}`);
  if (meta.sessionId) lines.push(`session_id: ${meta.sessionId}`);
  lines.push(`created_at: ${meta.createdAt}`);
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Save an artifact atomically to `<vaultDir>/Cindy/Artifacts/<id>.md`.
 */
export function saveArtifact(vaultDir: string, input: SaveArtifactInput): StoredArtifact {
  const dir = ensureArtifactsDir(vaultDir);
  const title = input.title.trim() || 'Untitled Artifact';
  const type = input.type?.trim() || 'document';
  const tags = input.tags ? [...input.tags] : [];

  let id = input.id ? sanitizeId(input.id) : '';
  if (!id) {
    const slug = slugify(title);
    const date = new Date().toISOString().slice(0, 10);
    const hash = crypto.randomBytes(4).toString('hex');
    id = `${date}-${slug}-${hash}`;
  }

  const filename = `${id}.md`;
  const targetPath = path.join(dir, filename);
  const root = path.resolve(vaultDir);

  // Containment verification
  if (!targetPath.startsWith(dir)) {
    throw new Error('Target artifact path escapes artifacts directory');
  }

  const createdAt = new Date().toISOString();
  const metadata: ArtifactMetadata = {
    title,
    type,
    sessionId: input.sessionId,
    createdAt,
    tags,
  };

  const cleanContent = redactSecrets(input.content || '');
  const frontmatter = formatFrontmatter(metadata);
  const fullText = `${frontmatter}\n\n${cleanContent}\n`;

  // Atomic write via temp file in same directory
  const tempPath = path.join(dir, `.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tempPath, fullText, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }

  const stat = fs.statSync(targetPath);
  const relPath = path.relative(root, targetPath).replace(/\\/g, '/');

  return {
    id,
    path: relPath,
    title,
    type,
    sessionId: input.sessionId,
    createdAt,
    tags,
    mtimeMs: stat.mtimeMs,
    content: cleanContent,
  };
}

/**
 * List all artifacts in `<vaultDir>/Cindy/Artifacts`.
 */
export function listArtifacts(vaultDir: string): StoredArtifactHeader[] {
  const dir = resolveArtifactsDir(vaultDir);
  if (!fs.existsSync(dir)) return [];

  const root = path.resolve(vaultDir);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: StoredArtifactHeader[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      const raw = fs.readFileSync(fullPath, 'utf8').slice(0, 10_000);
      const { metadata } = parseFrontmatter(raw);
      const id = entry.name.replace(/\.md$/i, '');
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

      results.push({
        id,
        path: relPath,
        title: metadata.title || id,
        type: metadata.type || 'document',
        sessionId: metadata.sessionId,
        createdAt: metadata.createdAt || new Date(stat.mtimeMs).toISOString(),
        tags: metadata.tags || [],
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Read a single artifact from `<vaultDir>/Cindy/Artifacts`.
 */
export function readArtifact(vaultDir: string, idOrPath: string): StoredArtifact {
  const dir = resolveArtifactsDir(vaultDir);
  const root = path.resolve(vaultDir);

  let targetPath: string;
  if (idOrPath.includes('/') || idOrPath.includes('\\')) {
    targetPath = path.resolve(root, idOrPath);
  } else {
    const filename = idOrPath.endsWith('.md') ? idOrPath : `${idOrPath}.md`;
    targetPath = path.join(dir, filename);
  }

  // Containment check
  if (!targetPath.startsWith(dir)) {
    throw new Error('Artifact path escapes artifacts directory');
  }

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Artifact not found: ${idOrPath}`);
  }

  const stat = fs.statSync(targetPath);
  const raw = fs.readFileSync(targetPath, 'utf8');
  const { metadata, content } = parseFrontmatter(raw);
  const id = path.basename(targetPath).replace(/\.md$/i, '');
  const relPath = path.relative(root, targetPath).replace(/\\/g, '/');

  return {
    id,
    path: relPath,
    title: metadata.title || id,
    type: metadata.type || 'document',
    sessionId: metadata.sessionId,
    createdAt: metadata.createdAt || new Date(stat.mtimeMs).toISOString(),
    tags: metadata.tags || [],
    mtimeMs: stat.mtimeMs,
    content,
  };
}

/**
 * Delete an artifact from `<vaultDir>/Cindy/Artifacts`.
 */
export function deleteArtifact(vaultDir: string, idOrPath: string): boolean {
  const dir = resolveArtifactsDir(vaultDir);
  const root = path.resolve(vaultDir);

  let targetPath: string;
  if (idOrPath.includes('/') || idOrPath.includes('\\')) {
    targetPath = path.resolve(root, idOrPath);
  } else {
    const filename = idOrPath.endsWith('.md') ? idOrPath : `${idOrPath}.md`;
    targetPath = path.join(dir, filename);
  }

  if (!targetPath.startsWith(dir)) {
    throw new Error('Artifact path escapes artifacts directory');
  }

  if (!fs.existsSync(targetPath)) {
    return false;
  }

  fs.unlinkSync(targetPath);
  return true;
}
