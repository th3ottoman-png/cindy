/**
 * Vault ADR manager (ROADMAP 11.8).
 *
 * Pure-logic write / query over Architecture Decision Records. An ADR is a plain Markdown file in
 * the `docs/decisions/` house format. `recordAdr` writes one copy to the notes vault
 * (`<vault>/Cindy/Decisions/<YYYY-MM-DD>-<slug>.md`) and, when a workspace is given, one to the
 * repo (`<repo>/docs/decisions/<NNNN>-<slug>.md`). Every write is temp file + rename in the same
 * directory, never overwrites an existing ADR, redacts obvious credentials, and must stay inside
 * its root after symlinks are resolved.
 *
 * `matchAdrsForPrompt` is the session-start keyword match: no model call, no network. The matched
 * titles are kept per session in a small JSON file so the manifest strip can show exactly what was
 * injected (AGENTS.md §6.4: no hidden state).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactSecrets } from '../export/session-markdown';

export const ADR_VAULT_DIR = 'Cindy/Decisions';
export const ADR_REPO_DIR = 'docs/decisions';
export const ADR_STATUSES = ['Proposed', 'Accepted', 'Superseded', 'Rejected'] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

export const MAX_ADR_TITLE_CHARS = 140;
export const MAX_ADR_SECTION_CHARS = 8000;
export const DEFAULT_ADR_MATCH_LIMIT = 5;

export interface AdrInput {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  status?: string;
  decider?: string;
}

export type AdrErrorReason = 'invalid' | 'no-vault' | 'outside-root' | 'exists';
export type AdrError = { ok: false; reason: AdrErrorReason; message: string };

export interface AdrRecordResult {
  ok: true;
  title: string;
  date: string;
  /** Vault-relative path of the vault copy. */
  vaultPath: string;
  /** Repo-relative path of the repo copy, when a workspace was given. */
  repoPath?: string;
  /** Number given to the repo copy (`NNNN`). */
  repoNumber?: number;
  /** Why the repo copy was skipped, when it was. The vault copy still landed. */
  repoSkipped?: string;
}

export interface AdrSummary {
  title: string;
  /** Path relative to its root (vault or repo). */
  path: string;
  source: 'vault' | 'repo';
  status?: string;
  date?: string;
}

export interface AdrHit extends AdrSummary {
  score: number;
  /** First lines of the Decision section. */
  decision: string;
}

export interface NormalizedAdr {
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: AdrStatus;
  decider: string;
}

function realDir(dir: string): string | undefined {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function inside(root: string, target: string): boolean {
  const r = path.relative(root, target);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** Create `root/rel` one level at a time, re-checking containment after each. */
function ensureDirInside(root: string, rel: string): string | undefined {
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const real = realDir(current);
    if (!real || !inside(root, real)) return undefined;
  }
  return current;
}

/**
 * Temp file in the same directory, then rename. Returns false, writing nothing, when the target
 * already exists: an ADR is a record, so it is never replaced.
 */
function writeNewFileAtomic(target: string, content: string): boolean {
  if (fs.existsSync(target)) return false;
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function slugifyAdrTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

function cleanSection(value: unknown): string {
  return typeof value === 'string' ? redactSecrets(value.replace(/\r\n/g, '\n').trim()) : '';
}

/** Validates an ADR against the house schema. Returns every problem, not just the first. */
export function validateAdrInput(input: AdrInput): { ok: true; adr: NormalizedAdr } | AdrError {
  const problems: string[] = [];
  const title = typeof input?.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) problems.push('title is required');
  else if (title.length > MAX_ADR_TITLE_CHARS) problems.push(`title is ${title.length} chars; the limit is ${MAX_ADR_TITLE_CHARS}`);
  else if (!slugifyAdrTitle(title)) problems.push('title needs at least one letter or digit');

  const context = cleanSection(input?.context);
  const decision = cleanSection(input?.decision);
  const consequences = cleanSection(input?.consequences);
  if (!context) problems.push('context is required');
  if (!decision) problems.push('decision is required');
  for (const [name, text] of [['context', context], ['decision', decision], ['consequences', consequences]] as const) {
    if (text.length > MAX_ADR_SECTION_CHARS) problems.push(`${name} is ${text.length} chars; the limit is ${MAX_ADR_SECTION_CHARS}`);
  }

  const rawStatus = typeof input?.status === 'string' ? input.status.trim() : '';
  const status = rawStatus
    ? ADR_STATUSES.find((s) => s.toLowerCase() === rawStatus.toLowerCase())
    : 'Accepted';
  if (!status) problems.push(`status must be one of: ${ADR_STATUSES.join(', ')}`);

  if (problems.length > 0 || !status) return { ok: false, reason: 'invalid', message: problems.join('; ') };
  const decider = typeof input.decider === 'string' && input.decider.trim()
    ? redactSecrets(input.decider.replace(/\s+/g, ' ').trim()).slice(0, 200)
    : 'agent';
  return { ok: true, adr: { title: redactSecrets(title), context, decision, consequences, status, decider } };
}

/** Body headings go below `##` so a section cannot forge a sibling ADR section. */
function demote(text: string): string {
  return text.replace(/^(#{1,2})(\s)/gm, '###$2');
}

export function renderAdrMarkdown(adr: NormalizedAdr, opts: { date: string; number?: number }): string {
  const heading = opts.number !== undefined
    ? `# ADR ${String(opts.number).padStart(4, '0')} — ${adr.title}`
    : `# ADR — ${adr.title}`;
  const lines = [
    heading,
    '',
    `- **Status:** ${adr.status}`,
    `- **Date:** ${opts.date}`,
    `- **Decider:** ${adr.decider}`,
    '',
    '## Context',
    '',
    demote(adr.context),
    '',
    '## Decision',
    '',
    demote(adr.decision),
    '',
  ];
  if (adr.consequences) lines.push('## Consequences', '', demote(adr.consequences), '');
  return lines.join('\n');
}

function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nextRepoNumber(dir: string): number {
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d{4})-.*\.md$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Write an ADR to the vault and, when `repoDir` is a git repo or already has `docs/decisions/`,
 * to the repo too. The vault copy is the record; a repo problem is reported, never fatal.
 */
export function recordAdr(
  vaultDir: string,
  input: AdrInput,
  opts: { repoDir?: string | null; now?: Date } = {},
): AdrRecordResult | AdrError {
  const checked = validateAdrInput(input);
  if (!checked.ok) return checked;
  const { adr } = checked;
  const vaultRoot = vaultDir ? realDir(vaultDir) : undefined;
  if (!vaultRoot) return { ok: false, reason: 'no-vault', message: 'vault folder does not exist' };

  const date = localDate(opts.now ?? new Date());
  const slug = slugifyAdrTitle(adr.title);
  const vaultFolder = ensureDirInside(vaultRoot, ADR_VAULT_DIR);
  if (!vaultFolder) return { ok: false, reason: 'outside-root', message: 'the vault decisions folder leaves the vault' };
  const vaultName = `${date}-${slug}.md`;
  if (!writeNewFileAtomic(path.join(vaultFolder, vaultName), renderAdrMarkdown(adr, { date }))) {
    return { ok: false, reason: 'exists', message: `an ADR already exists at ${ADR_VAULT_DIR}/${vaultName}; pick a more specific title` };
  }
  const result: AdrRecordResult = { ok: true, title: adr.title, date, vaultPath: `${ADR_VAULT_DIR}/${vaultName}` };

  const repoDir = opts.repoDir?.trim();
  if (!repoDir) return result;
  try {
    const repoRoot = realDir(repoDir);
    if (!repoRoot) return { ...result, repoSkipped: 'workspace folder does not exist' };
    const hasDecisions = realDir(path.join(repoRoot, ADR_REPO_DIR)) !== undefined;
    if (!hasDecisions && !fs.existsSync(path.join(repoRoot, '.git'))) {
      return { ...result, repoSkipped: `workspace is not a git repo and has no ${ADR_REPO_DIR}/` };
    }
    const repoFolder = ensureDirInside(repoRoot, ADR_REPO_DIR);
    if (!repoFolder) return { ...result, repoSkipped: `${ADR_REPO_DIR}/ leaves the workspace` };
    if (fs.readdirSync(repoFolder).some((name) => name.replace(/^\d{4}-/, '') === `${slug}.md`)) {
      return { ...result, repoSkipped: `an ADR named ${slug} already exists in ${ADR_REPO_DIR}/` };
    }
    // A number taken since the scan makes the write refuse; rescan and take the next one.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const number = nextRepoNumber(repoFolder);
      const repoName = `${String(number).padStart(4, '0')}-${slug}.md`;
      if (writeNewFileAtomic(path.join(repoFolder, repoName), renderAdrMarkdown(adr, { date, number }))) {
        return { ...result, repoPath: `${ADR_REPO_DIR}/${repoName}`, repoNumber: number };
      }
    }
    return { ...result, repoSkipped: 'could not claim an ADR number' };
  } catch (err) {
    return { ...result, repoSkipped: err instanceof Error ? err.message : String(err) };
  }
}

interface LoadedAdr extends AdrSummary {
  body: string;
  decision: string;
}

function decisionSection(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^##\s+Decision\s*$/.test(line));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

function parseAdr(text: string, relPath: string, source: 'vault' | 'repo'): LoadedAdr {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(relPath, '.md');
  const title = heading.replace(/^ADR(\s+\d+)?\s*[—–:-]\s*/i, '').trim() || heading;
  const status = /^\s*-\s*\*\*Status:\*\*\s*(.+)$/m.exec(text)?.[1]?.trim();
  const date = /^\s*-\s*\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1]
    ?? /^(\d{4}-\d{2}-\d{2})-/.exec(path.basename(relPath))?.[1];
  return { title, path: relPath, source, status, date, body: text, decision: decisionSection(text) };
}

function loadAdrs(root: string | undefined, rel: string, source: 'vault' | 'repo'): LoadedAdr[] {
  if (!root) return [];
  const realRoot = realDir(root);
  const dir = realRoot ? realDir(path.join(realRoot, rel)) : undefined;
  if (!realRoot || !dir || !inside(realRoot, dir)) return [];
  const out: LoadedAdr[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue;
    try {
      const file = fs.realpathSync(path.join(dir, name));
      if (!inside(realRoot, file) || !fs.statSync(file).isFile()) continue;
      out.push(parseAdr(fs.readFileSync(file, 'utf8'), `${rel}/${name}`, source));
    } catch {
      // unreadable ADR: skip it, the rest still load
    }
  }
  return out;
}

function loadAllAdrs(vaultDir: string | null | undefined, repoDir?: string | null): LoadedAdr[] {
  const repo = loadAdrs(repoDir ?? undefined, ADR_REPO_DIR, 'repo');
  const repoTitles = new Set(repo.map((adr) => adr.title.toLowerCase()));
  // record_adr writes both copies; show the repo one (it carries the number) and drop its twin.
  const vault = loadAdrs(vaultDir ?? undefined, ADR_VAULT_DIR, 'vault').filter((adr) => !repoTitles.has(adr.title.toLowerCase()));
  return [...repo, ...vault];
}

function summary(adr: LoadedAdr): AdrSummary {
  return { title: adr.title, path: adr.path, source: adr.source, ...(adr.status ? { status: adr.status } : {}), ...(adr.date ? { date: adr.date } : {}) };
}

export function listAdrs(vaultDir: string | null | undefined, opts: { repoDir?: string | null } = {}): AdrSummary[] {
  return loadAllAdrs(vaultDir, opts.repoDir).map(summary);
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'any', 'are', 'because', 'before', 'being', 'between', 'build', 'but',
  'can', 'could', 'does', 'doing', 'for', 'from', 'has', 'have', 'help', 'here', 'how', 'into', 'its', 'just', 'like',
  'make', 'more', 'need', 'not', 'now', 'only', 'other', 'our', 'out', 'over', 'please', 'should', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'use', 'using', 'want',
  'was', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'adr', 'decision', 'decisions', 'record', 'context', 'status', 'accepted', 'date', 'decider', 'consequences',
]);

/** Lower-case keywords of 3+ characters, stopwords and duplicates removed. */
export function adrKeywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

function scoreAdr(adr: LoadedAdr, keywords: string[]): { score: number; titleHits: number; bodyHits: number } {
  const title = new Set(adrKeywords(adr.title));
  const body = new Set(adrKeywords(adr.body));
  let titleHits = 0;
  let bodyHits = 0;
  for (const word of keywords) {
    if (title.has(word)) titleHits += 1;
    else if (body.has(word)) bodyHits += 1;
  }
  return { score: titleHits * 3 + bodyHits, titleHits, bodyHits };
}

function toHit(adr: LoadedAdr, score: number): AdrHit {
  return { ...summary(adr), score, decision: adr.decision.slice(0, 400) };
}

/** Keyword search over ADR titles and bodies. An empty query lists every ADR, newest first. */
export function queryAdrs(
  vaultDir: string | null | undefined,
  query: string,
  opts: { repoDir?: string | null; limit?: number } = {},
): AdrHit[] {
  const adrs = loadAllAdrs(vaultDir, opts.repoDir);
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const keywords = adrKeywords(query ?? '');
  if (keywords.length === 0) {
    return adrs
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.path.localeCompare(a.path))
      .slice(0, limit)
      .map((adr) => toHit(adr, 0));
  }
  return adrs
    .map((adr) => ({ adr, ...scoreAdr(adr, keywords) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (b.adr.date ?? '').localeCompare(a.adr.date ?? ''))
    .slice(0, limit)
    .map((row) => toHit(row.adr, row.score));
}

/**
 * Session-start match (ROADMAP 11.8). Stricter than `queryAdrs` so an unrelated prompt injects
 * nothing. An ADR matches when the prompt has one distinctive title keyword (one that appears in
 * at most a third of all ADR titles, so "sqlite" counts and a word every title shares does not),
 * or two title keywords, or three body keywords.
 */
export function matchAdrsForPrompt(
  prompt: string,
  vaultDir: string | null | undefined,
  opts: { repoDir?: string | null; limit?: number } = {},
): AdrSummary[] {
  const keywords = adrKeywords(prompt ?? '');
  if (keywords.length === 0) return [];
  const limit = Math.max(1, opts.limit ?? DEFAULT_ADR_MATCH_LIMIT);
  const adrs = loadAllAdrs(vaultDir, opts.repoDir);
  const titleCount = new Map<string, number>();
  for (const adr of adrs) {
    for (const word of adrKeywords(adr.title)) titleCount.set(word, (titleCount.get(word) ?? 0) + 1);
  }
  const commonAbove = Math.max(1, Math.floor(adrs.length / 3));
  const distinctive = (adr: LoadedAdr): boolean => {
    const title = new Set(adrKeywords(adr.title));
    return keywords.some((word) => title.has(word) && (titleCount.get(word) ?? 0) <= commonAbove);
  };
  return adrs
    .map((adr) => ({ adr, ...scoreAdr(adr, keywords) }))
    .filter((row) => distinctive(row.adr) || row.titleHits >= 2 || row.bodyHits >= 3)
    .sort((a, b) => b.score - a.score || (b.adr.date ?? '').localeCompare(a.adr.date ?? ''))
    .slice(0, limit)
    .map((row) => summary(row.adr));
}

/** The first-turn block. Titles and paths only; the agent reads a full ADR with `query_adrs`. */
export function buildRelevantAdrsPreamble(adrs: AdrSummary[]): string {
  if (adrs.length === 0) return '';
  const rows = adrs.map((adr) => `- ${adr.title}${adr.status ? ` (${adr.status})` : ''} — ${adr.path}`);
  return [
    '[Relevant past decisions (ADRs)]',
    'These decisions are already settled. Follow them and cite the ADR title when it applies; do not re-open one unless the owner asks.',
    ...rows,
    '[/Relevant past decisions (ADRs)]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-session record of what was injected (file-backed, for the manifest strip)
// ---------------------------------------------------------------------------

export interface SessionAdrsEntry {
  /** Workspace the session started in; `record_adr` writes the repo copy there. */
  workspaceDir?: string;
  adrs: AdrSummary[];
}

export interface SessionAdrsFile {
  sessions: Record<string, SessionAdrsEntry>;
}

const MAX_TRACKED_SESSIONS = 500;

function cleanSummary(value: unknown): AdrSummary | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.title !== 'string' || typeof row.path !== 'string') return null;
  if (row.source !== 'vault' && row.source !== 'repo') return null;
  return {
    title: row.title,
    path: row.path,
    source: row.source,
    ...(typeof row.status === 'string' ? { status: row.status } : {}),
    ...(typeof row.date === 'string' ? { date: row.date } : {}),
  };
}

/** Fails open: a missing or corrupt file reads as empty. */
export function loadSessionAdrs(filePath: string): SessionAdrsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { sessions?: unknown };
    const sessions: Record<string, SessionAdrsEntry> = {};
    if (parsed?.sessions && typeof parsed.sessions === 'object') {
      for (const [id, raw] of Object.entries(parsed.sessions as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as { workspaceDir?: unknown; adrs?: unknown };
        sessions[id] = {
          ...(typeof entry.workspaceDir === 'string' && entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
          adrs: Array.isArray(entry.adrs) ? entry.adrs.map(cleanSummary).filter((a): a is AdrSummary => a !== null) : [],
        };
      }
    }
    return { sessions };
  } catch {
    return { sessions: {} };
  }
}

export function getSessionAdrs(filePath: string, sessionId: string): SessionAdrsEntry {
  return loadSessionAdrs(filePath).sessions[sessionId] ?? { adrs: [] };
}

/** Atomic write. Keeps the newest `MAX_TRACKED_SESSIONS` entries so the file cannot grow forever. */
export function setSessionAdrs(filePath: string, sessionId: string, entry: SessionAdrsEntry): void {
  if (!sessionId) return;
  const file = loadSessionAdrs(filePath);
  delete file.sessions[sessionId];
  file.sessions[sessionId] = {
    ...(entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
    adrs: entry.adrs,
  };
  const ids = Object.keys(file.sessions);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_SESSIONS))) delete file.sessions[id];
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
