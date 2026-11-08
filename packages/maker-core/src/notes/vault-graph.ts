import * as fs from 'node:fs';
import * as path from 'node:path';

import { listNotes } from './vault-notes.js';

export interface VaultGraphNode {
  path: string;
  title: string;
  tags: string[];
  outgoingLinks: string[];
  mtimeMs: number;
}

export interface VaultGraph {
  nodes: Record<string, VaultGraphNode>;
  tags: Record<string, string[]>;
  backlinks: Record<string, string[]>;
  totalNotes: number;
  scannedAt: string;
}

const MAX_NOTE_SCAN_BYTES = 512 * 1024; // 512 KB

/**
 * Normalizes a tag to lowercase without leading #.
 */
export function normalizeTag(tag: string): string {
  const cleaned = tag.trim().replace(/^#+/, '');
  return cleaned.toLowerCase();
}

/**
 * Extracts YAML frontmatter and body from note markdown text.
 */
function extractFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const endIdx = text.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: '', body: text };
  const frontmatter = text.slice(3, endIdx).trim();
  const body = text.slice(endIdx + 4).trim();
  return { frontmatter, body };
}

/**
 * Extracts tags and title from frontmatter text.
 */
function parseFrontmatterTagsAndTitle(fm: string): { tags: string[]; title?: string } {
  const tags: string[] = [];
  let title: string | undefined;

  const lines = fm.split('\n');
  let inTagsList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Check title
    if (!title) {
      const titleMatch = line.match(/^title:\s*(?:"([^"]+)"|'([^']+)'|([^\n\r]+))/);
      if (titleMatch) {
        title = (titleMatch[1] ?? titleMatch[2] ?? titleMatch[3])?.trim();
      }
    }

    // Check tags list
    if (line.startsWith('tags:')) {
      const rest = line.slice(5).trim();
      if (rest.startsWith('[') && rest.endsWith(']')) {
        const items = rest
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        for (const item of items) tags.push(normalizeTag(item));
        inTagsList = false;
      } else {
        inTagsList = true;
      }
      continue;
    }

    if (inTagsList) {
      if (line.startsWith('- ')) {
        const item = line.slice(2).trim().replace(/^['"]|['"]$/g, '');
        if (item) tags.push(normalizeTag(item));
      } else if (!line.startsWith('#') && line.includes(':')) {
        inTagsList = false;
      }
    }
  }

  return { tags, title };
}

/**
 * Parses tags, wikilinks, and title from a note's content.
 */
export function parseNoteLinksAndTags(
  relPath: string,
  content: string,
): { title: string; tags: string[]; outgoingLinks: string[] } {
  const { frontmatter, body } = extractFrontmatter(content);
  const { tags: fmTags, title: fmTitle } = parseFrontmatterTagsAndTitle(frontmatter);

  // Fallback title from first markdown heading or filename
  let title = fmTitle;
  if (!title) {
    const headingMatch = body.match(/^#\s+([^\n\r]+)/m);
    if (headingMatch && headingMatch[1]) {
      title = headingMatch[1].trim();
    } else {
      const base = path.basename(relPath);
      title = base.endsWith('.md') ? base.slice(0, -3) : base;
    }
  }

  // Strip fenced code blocks before searching for inline links & tags
  const sanitizedBody = body.replace(/```[\s\S]*?```/g, '');

  // Extract inline hashtags (e.g. #tag or #cindy-ai, avoiding hex colors #fff or URLs)
  const inlineTags: string[] = [];
  const tagRegex = /(?:^|\s)#([a-zA-Z0-9_\-\u4e00-\u9fa5]+)(?=\s|$|[.,;:!?])/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(sanitizedBody)) !== null) {
    const candidate = match[1];
    // Ignore pure numeric anchors or hex codes
    if (candidate && !/^[0-9a-fA-F]{3,6}$/.test(candidate) && !/^\d+$/.test(candidate)) {
      inlineTags.push(normalizeTag(candidate));
    }
  }

  // Extract Obsidian Wikilinks: [[TargetNote]] or [[TargetNote|Alias]]
  const outgoingLinks: string[] = [];
  const wikilinkRegex = /\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?\]\]/g;
  while ((match = wikilinkRegex.exec(sanitizedBody)) !== null) {
    const target = match[1]?.trim();
    if (target && !outgoingLinks.includes(target)) {
      outgoingLinks.push(target);
    }
  }

  // Extract standard markdown links to .md notes: [title](path/to/note.md)
  const mdLinkRegex = /\[[^\]]*\]\(([^)#?]+\.md)\)/g;
  while ((match = mdLinkRegex.exec(sanitizedBody)) !== null) {
    const target = match[1]?.trim();
    if (target && !outgoingLinks.includes(target)) {
      outgoingLinks.push(target);
    }
  }

  // Deduplicate tags
  const combinedTags = Array.from(new Set([...fmTags, ...inlineTags]));

  return {
    title,
    tags: combinedTags,
    outgoingLinks,
  };
}

/**
 * Resolves a wikilink target (which might be just a note title or basename)
 * to a relative note path in the vault.
 */
function resolveLinkTarget(target: string, availablePaths: string[]): string | undefined {
  const normalizedTarget = target.endsWith('.md') ? target : `${target}.md`;

  // 1. Direct path match
  for (const p of availablePaths) {
    if (p.toLowerCase() === normalizedTarget.toLowerCase() || p.toLowerCase() === target.toLowerCase()) {
      return p;
    }
  }

  // 2. Basename match (e.g. "Synthesis" matches "Cindy/Memory/Synthesis.md")
  const targetBase = path.basename(normalizedTarget).toLowerCase();
  for (const p of availablePaths) {
    if (path.basename(p).toLowerCase() === targetBase) {
      return p;
    }
  }

  return undefined;
}

/**
 * Scans the entire vault to build the complete tag explorer index and backlink graph.
 */
export function scanVaultGraph(vaultDir: string, maxNotes = 2000): VaultGraph {
  const notesList = listNotes(vaultDir, { limit: maxNotes });
  if (!Array.isArray(notesList)) {
    return {
      nodes: {},
      tags: {},
      backlinks: {},
      totalNotes: 0,
      scannedAt: new Date().toISOString(),
    };
  }

  const nodes: Record<string, VaultGraphNode> = {};
  const tagsMap: Record<string, Set<string>> = {};
  const availablePaths = notesList.map((n) => n.path);

  // 1. Parse each note
  for (const noteEntry of notesList) {
    const rel = noteEntry.path;
    const fullPath = path.join(vaultDir, rel);

    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_NOTE_SCAN_BYTES) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const { title, tags, outgoingLinks } = parseNoteLinksAndTags(rel, content);

      nodes[rel] = {
        path: rel,
        title,
        tags,
        outgoingLinks,
        mtimeMs: stat.mtimeMs,
      };

      for (const t of tags) {
        if (!tagsMap[t]) tagsMap[t] = new Set();
        tagsMap[t].add(rel);
      }
    } catch {
      // Ignore unreadable or transiently deleted files
    }
  }

  // 2. Build backlinks index
  const backlinksMap: Record<string, Set<string>> = {};
  for (const [sourcePath, node] of Object.entries(nodes)) {
    for (const rawTarget of node.outgoingLinks) {
      const resolvedTarget = resolveLinkTarget(rawTarget, availablePaths);
      if (resolvedTarget && resolvedTarget !== sourcePath) {
        if (!backlinksMap[resolvedTarget]) backlinksMap[resolvedTarget] = new Set();
        backlinksMap[resolvedTarget].add(sourcePath);
      }
    }
  }

  // 3. Serialize Sets to Arrays
  const tags: Record<string, string[]> = {};
  for (const [t, pathsSet] of Object.entries(tagsMap)) {
    tags[t] = Array.from(pathsSet).sort();
  }

  const backlinks: Record<string, string[]> = {};
  for (const [targetPath, sourcesSet] of Object.entries(backlinksMap)) {
    backlinks[targetPath] = Array.from(sourcesSet).sort();
  }

  return {
    nodes,
    tags,
    backlinks,
    totalNotes: Object.keys(nodes).length,
    scannedAt: new Date().toISOString(),
  };
}
