/**
 * ROADMAP 11.1 — 3-tier progressive skill loading engine.
 *
 * Tier 1 (discovery): `buildDiscoveryCatalog` indexes installed skills into a
 * bounded list of `name` + `description` rows (~35 tokens each); `renderDiscoveryManifest`
 * turns that into the compact `<available_skills>` strip.
 * Tier 2 (activation): `activateSkill` loads one full `SKILL.md` body on demand, either
 * autonomously (the `cindy_skills` MCP tool) or from a deterministic composer pin.
 * Tier 3 (execution): scripts/ and references/ are indexed as *paths only*. Their
 * contents never enter this module, so a skill's heavy material stays out of prompt context
 * until the agent deliberately reads or runs it.
 *
 * Local-first and fail-closed: the catalog is derived from plain files on disk, unknown slugs
 * and chat-only sessions never fall back to another skill, and every path is checked for
 * containment. No clock, network, agent binary or model call is used here; `nowMs` is injected.
 *
 * Note: Hermes 0.22.7 already ships native progressive disclosure (`skills_list` /
 * `skill_view` plus a compact index in its own system prompt). This engine is Cindy's
 * deterministic, testable source of truth for the activation tool and composer pins; the
 * discovery strip is NOT injected into Hermes's system prompt, which would duplicate tokens.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import { shouldPruneSkillScanDirectory } from '../agents/shared/skill-scan-limits';

export const SKILL_CATALOG_VERSION = 1;
/** Hard cap on the bytes of one SKILL.md read into turn context (~8,000 tokens). */
export const MAX_SKILL_BYTES = 32 * 1024;
/** Tier 1 budget: 25 skills must fit comfortably under 1,000 discovery tokens. */
export const MAX_DISCOVERY_TOKENS = 1_000;
/** A larger library is still indexed, but the manifest stops adding rows past the budget. */
export const MAX_CATALOG_SKILLS = 200;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_ASSET_ENTRIES = 40;
const MAX_ASSET_DEPTH = 3;
const MANIFEST_HEADER =
  'You have access to specialized skills. Full instructions are NOT loaded into context to save tokens.\n' +
  'When a task matches a skill\'s description, call tool `activate_skill(skill_slug: "<slug>")` to retrieve full instructions before proceeding.\n' +
  'If that tool is not available in this session, the owner can pin one with @skill:<slug> in the composer instead.';

export interface SkillFrontmatter {
  name: string;
  description: string;
  author?: string;
  version?: string;
  triggers?: string[];
  requiresTools?: string[];
  /** Skill opts out of autonomous activation; a deterministic user pin still works. */
  disableModelActivation?: boolean;
}

export interface SkillManifestEntry {
  /** Canonical identifier, derived from the folder name. */
  slug: string;
  name: string;
  description: string;
  /** Absolute directory containing SKILL.md. */
  skillDir: string;
  /** Estimated token cost of loading the FULL SKILL.md. */
  fullTokenEstimate: number;
  hasScripts: boolean;
  hasReferences: boolean;
  disableModelActivation?: boolean;
}

export interface SkillDiscoveryCatalog {
  version: typeof SKILL_CATALOG_VERSION;
  compiledAtMs: number;
  totalSkills: number;
  estimatedDiscoveryTokens: number;
  skills: SkillManifestEntry[];
}

export interface SkillActivationResult {
  slug: string;
  name: string;
  /** SKILL.md body with frontmatter removed, bounded to MAX_SKILL_BYTES. */
  instructions: string;
  scriptsDir: string | null;
  referencesDir: string | null;
  /** Relative paths, e.g. `scripts/run_audit.sh`. Contents are never read. */
  availableScripts: string[];
  availableReferences: string[];
  truncated: boolean;
}

export type SkillActivationErrorCode =
  | 'UNKNOWN_SKILL'
  | 'PERMISSION_DENIED'
  | 'ACTIVATION_DISABLED'
  | 'PATH_ESCAPE'
  | 'MISSING_FILE';

export interface SkillActivationError {
  code: SkillActivationErrorCode;
  message: string;
  /** Close slugs, so the model can self-correct without another discovery call. */
  suggestions: string[];
}

export type SkillActivationOutcome =
  | { ok: true; result: SkillActivationResult }
  | { ok: false; error: SkillActivationError };

/** Deliberately cheap and dependency-free: ~4 characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function oneLine(value: string): string {
  return value
    // Author-controlled frontmatter must never break the manifest's line structure or
    // forge its fixed <available_skills> boundary. Same discipline as the ghost roster.
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[<>]/g, ' ')
    .trim();
}

/** Remove a leading YAML frontmatter block without throwing on malformed YAML. */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) return markdown;
  const rest = markdown.slice(end + 4);
  return rest.startsWith('\n') ? rest.slice(1) : rest;
}

/**
 * Parse SKILL.md frontmatter. Malformed YAML falls back to the folder slug and the first
 * 160 characters of the markdown body (blueprint section 7), never throws.
 */
export function parseSkillFrontmatter(markdown: string, fallbackSlug: string): SkillFrontmatter {
  const body = stripFrontmatter(markdown);
  const fallbackDescription = oneLine(body).slice(0, 160) || `Skill ${fallbackSlug}`;
  const fallback: SkillFrontmatter = { name: fallbackSlug, description: fallbackDescription };
  if (!markdown.startsWith('---')) return fallback;

  let data: Record<string, unknown>;
  try {
    data = matter(markdown).data as Record<string, unknown>;
  } catch {
    return fallback;
  }
  if (!data || typeof data !== 'object') return fallback;

  const text = (key: string): string | undefined => {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? oneLine(value) : undefined;
  };
  const list = (key: string): string[] | undefined => {
    const value = data[key];
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is string => typeof item === 'string').map(oneLine);
  };
  const bool = (key: string): boolean | undefined =>
    typeof data[key] === 'boolean' ? (data[key] as boolean) : undefined;

  return {
    name: text('name') ?? fallbackSlug,
    description: text('description') ?? fallbackDescription,
    ...(text('author') ? { author: text('author') } : {}),
    ...(text('version') ? { version: text('version') } : {}),
    ...(list('triggers') ? { triggers: list('triggers') } : {}),
    ...(list('requiresTools') ? { requiresTools: list('requiresTools') } : {}),
    ...(bool('disableModelActivation') !== undefined
      ? { disableModelActivation: bool('disableModelActivation') }
      : {}),
  };
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isPlainDirectory(entry: fs.Dirent): boolean {
  return entry.isDirectory() && !entry.name.startsWith('.') && !shouldPruneSkillScanDirectory(entry.name);
}

/**
 * Index `<root>/<category>/<skill>/SKILL.md` and `<root>/<skill>/SKILL.md`.
 * Only two levels deep, matching the Hermes skills layout. Never follows symlinks.
 */
function collectSkillDirs(roots: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    for (const level1 of safeReadDir(root)) {
      if (level1.isSymbolicLink() || !isPlainDirectory(level1)) continue;
      const first = path.join(root, level1.name);
      if (fs.existsSync(path.join(first, 'SKILL.md'))) {
        const key = level1.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          found.push(first);
        }
        continue;
      }
      for (const level2 of safeReadDir(first)) {
        if (level2.isSymbolicLink() || !isPlainDirectory(level2)) continue;
        const second = path.join(first, level2.name);
        if (!fs.existsSync(path.join(second, 'SKILL.md'))) continue;
        const key = level2.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          found.push(second);
        }
      }
    }
  }
  return found;
}

function readBounded(filePath: string, maxBytes: number): { text: string; size: number } {
  const stat = fs.statSync(filePath);
  const buffer = Buffer.alloc(Math.min(Math.max(stat.size, 0), maxBytes));
  const fd = fs.openSync(filePath, 'r');
  try {
    if (buffer.length > 0) fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { text: buffer.toString('utf8'), size: stat.size };
}

function dirHasAssets(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && safeReadDir(dir).length > 0;
  } catch {
    return false;
  }
}

export interface BuildDiscoveryCatalogOptions {
  /** Skill roots, in priority order. Missing roots are ignored. */
  roots: readonly string[];
  /** Injected clock, so the catalog is deterministic in tests and at session assembly. */
  nowMs?: number;
  /** Chat-only sessions get no catalog at all (fail closed, blueprint section 7). */
  chatOnly?: boolean;
}

/** Compile the Tier 1 catalog. Returns `null` only for chat-only mode. */
export function buildDiscoveryCatalog(
  options: BuildDiscoveryCatalogOptions,
): SkillDiscoveryCatalog | null {
  if (options.chatOnly) return null;

  const skills: SkillManifestEntry[] = [];
  for (const dir of collectSkillDirs(options.roots)) {
    if (skills.length >= MAX_CATALOG_SKILLS) break;
    let text: string;
    try {
      text = readBounded(path.join(dir, 'SKILL.md'), MAX_SKILL_BYTES).text;
    } catch {
      continue;
    }
    const slug = path.basename(dir);
    const frontmatter = parseSkillFrontmatter(text, slug);
    skills.push({
      slug,
      name: frontmatter.name,
      description: oneLine(frontmatter.description).slice(0, MAX_DESCRIPTION_CHARS),
      skillDir: dir,
      fullTokenEstimate: estimateTokens(text),
      hasScripts: dirHasAssets(path.join(dir, 'scripts')),
      hasReferences: dirHasAssets(path.join(dir, 'references')),
      ...(frontmatter.disableModelActivation ? { disableModelActivation: true } : {}),
    });
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));

  const estimatedDiscoveryTokens = skills.reduce(
    (sum, entry) => sum + estimateTokens(`- ${entry.slug}: ${entry.description}\n`),
    estimateTokens(`<available_skills>\n${MANIFEST_HEADER}\n\n</available_skills>\n`),
  );
  return {
    version: SKILL_CATALOG_VERSION,
    compiledAtMs: options.nowMs ?? 0,
    totalSkills: skills.length,
    estimatedDiscoveryTokens,
    skills,
  };
}

/** Compact Tier 1 strip. Empty catalog = zero injection, never an empty shell tag. */
export function renderDiscoveryManifest(catalog: SkillDiscoveryCatalog): string {
  if (catalog.skills.length === 0) return '';
  const lines = ['<available_skills>', MANIFEST_HEADER, ''];
  let used = estimateTokens(lines.join('\n') + '\n</available_skills>\n');
  let omitted = 0;
  for (const entry of catalog.skills) {
    const line = `- ${entry.slug}: ${oneLine(entry.description).slice(0, MAX_DESCRIPTION_CHARS)}`;
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > MAX_DISCOVERY_TOKENS) {
      omitted = catalog.skills.length - lines.length + 3;
      break;
    }
    lines.push(line);
    used += cost;
  }
  if (omitted > 0) lines.push(`- ... ${omitted} more skills omitted (discovery token budget)`);
  lines.push('</available_skills>');
  return lines.join('\n');
}

/** True when `target`'s real path is inside `base`. Symlinks that escape are refused. */
function contained(base: string, target: string): boolean {
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    return realTarget === realBase || realTarget.startsWith(`${realBase}${path.sep}`);
  } catch {
    return false;
  }
}

/** Index asset paths only. File contents are never read; escaping symlinks are skipped. */
function listAssets(skillDir: string, kind: 'scripts' | 'references'): string[] {
  const rootDir = path.join(skillDir, kind);
  if (!contained(skillDir, rootDir)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_ASSET_DEPTH || out.length >= MAX_ASSET_ENTRIES) return;
    for (const entry of safeReadDir(dir)) {
      if (out.length >= MAX_ASSET_ENTRIES) return;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldPruneSkillScanDirectory(entry.name)) walk(full, nextRel, depth + 1);
      } else if (entry.isFile() && contained(skillDir, full)) {
        out.push(`${kind}/${nextRel}`);
      }
    }
  };
  walk(rootDir, '', 0);
  return out.sort();
}

export interface ActivateSkillOptions {
  catalog: SkillDiscoveryCatalog;
  slug: string;
  /** `model` = autonomous MCP call (default); `user` = deterministic composer pin. */
  source?: 'model' | 'user';
  chatOnly?: boolean;
  maxBytes?: number;
}

/** Tier 2 activation. Every failure is a structured, closed result; nothing is guessed. */
export function activateSkill(options: ActivateSkillOptions): SkillActivationOutcome {
  const { catalog, source = 'model', chatOnly = false } = options;
  if (chatOnly) {
    return {
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: 'Skill activation is disabled in chat-only mode.', suggestions: [] },
    };
  }
  const wanted = String(options.slug ?? '').trim().toLowerCase();
  const allSlugs = catalog.skills.map((entry) => entry.slug);
  const fail = (code: SkillActivationErrorCode, message: string, suggestions: string[] = []): SkillActivationOutcome => ({
    ok: false,
    error: { code, message, suggestions },
  });
  if (!wanted) return fail('UNKNOWN_SKILL', 'A skill_slug is required.');

  const entry = catalog.skills.find((candidate) => candidate.slug.toLowerCase() === wanted);
  if (!entry) {
    const suggestions = allSlugs
      .filter((slug) => slug.includes(wanted) || wanted.includes(slug) || slug.startsWith(wanted.slice(0, 4)))
      .slice(0, 8);
    return fail(
      'UNKNOWN_SKILL',
      `Skill '${options.slug}' is not installed. Available skills: ${allSlugs.join(', ') || '(none)'}`,
      suggestions,
    );
  }
  if (entry.disableModelActivation && source === 'model') {
    return fail(
      'ACTIVATION_DISABLED',
      `Skill '${entry.slug}' has disabled autonomous activation; the owner must pin it with @skill:${entry.slug}.`,
      [entry.slug],
    );
  }
  if (!contained(entry.skillDir, entry.skillDir)) {
    return fail('PATH_ESCAPE', `Skill directory for '${entry.slug}' could not be resolved.`);
  }

  const skillFile = path.join(entry.skillDir, 'SKILL.md');
  if (!contained(entry.skillDir, skillFile)) {
    return fail('PATH_ESCAPE', `SKILL.md for '${entry.slug}' resolves outside its skill directory.`);
  }
  const maxBytes = Math.min(options.maxBytes ?? MAX_SKILL_BYTES, MAX_SKILL_BYTES);
  let read: { text: string; size: number };
  try {
    read = readBounded(skillFile, maxBytes);
  } catch {
    return fail('MISSING_FILE', `SKILL.md for '${entry.slug}' is missing or unreadable.`);
  }
  const truncated = read.size > maxBytes;
  const instructions =
    stripFrontmatter(read.text).trim() +
    (truncated ? '\n\n[Truncated: skill file exceeds 32KB]' : '');

  const scriptsDir = path.join(entry.skillDir, 'scripts');
  const referencesDir = path.join(entry.skillDir, 'references');
  return {
    ok: true,
    result: {
      slug: entry.slug,
      name: entry.name,
      instructions,
      scriptsDir: fs.existsSync(scriptsDir) ? scriptsDir : null,
      referencesDir: fs.existsSync(referencesDir) ? referencesDir : null,
      availableScripts: listAssets(entry.skillDir, 'scripts'),
      availableReferences: listAssets(entry.skillDir, 'references'),
      truncated,
    },
  };
}

/** Markdown payload returned by the `activate_skill` MCP tool (blueprint section 4). */
export function formatSkillActivation(result: SkillActivationResult): string {
  const lines = [
    `# Skill Activated: ${result.name} (${result.slug})`,
    '',
    '## Instructions',
    result.instructions,
    '',
    '## Available Assets',
  ];
  if (result.availableScripts.length === 0 && result.availableReferences.length === 0) {
    lines.push('- No scripts or references. Use only the instructions above.');
  } else {
    for (const asset of result.availableScripts) lines.push(`- Scripts: ${asset} (run via bash tool, do not read into context)`);
    for (const asset of result.availableReferences) lines.push(`- References: ${asset} (read via file tools only if needed)`);
    if (result.scriptsDir) lines.push(`- Scripts directory: ${result.scriptsDir}`);
    if (result.referencesDir) lines.push(`- References directory: ${result.referencesDir}`);
  }
  return lines.join('\n');
}
