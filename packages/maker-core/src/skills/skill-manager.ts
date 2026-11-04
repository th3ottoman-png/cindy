/**
 * Skill manager (ROADMAP 4.4a).
 *
 * Skills live at `<skillsRoot>/<category>/<name>/SKILL.md` (Hermes layout). This module lists
 * installed skills, scans a candidate folder with static rules and returns a report, and installs
 * a local folder only after that report: HIGH findings block the install unless the caller
 * acknowledges them, symlinks always block it. Nothing is executed; the scan is a heuristic
 * reading aid, not a sandbox. Git-URL install and enable/disable are 4.4b.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import { shouldPruneSkillScanDirectory } from '../agents/shared/skill-scan-limits';

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface SkillFinding {
  severity: FindingSeverity;
  rule: string;
  /** Path relative to the scanned skill directory. */
  file: string;
  /** 1-based line, absent for whole-file findings. */
  line?: number;
  excerpt?: string;
}

export interface SkillScanReport {
  dir: string;
  /** From SKILL.md frontmatter; absent when SKILL.md is missing or invalid. */
  name?: string;
  description?: string;
  /** Set when the folder is not a valid skill; findings are then empty. */
  error?: string;
  fileCount: number;
  findings: SkillFinding[];
  /** `blocked` = has a symlink; `review` = has HIGH findings; otherwise `ok`. */
  verdict: 'ok' | 'review' | 'blocked' | 'invalid';
}

const MAX_FILES = 500;
const MAX_TEXT_BYTES = 512 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

interface Rule {
  severity: FindingSeverity;
  rule: string;
  test: RegExp;
}

const LINE_RULES: Rule[] = [
  { severity: 'high', rule: 'pipe-to-shell', test: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i },
  { severity: 'high', rule: 'decode-to-shell', test: /base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh\b/i },
  { severity: 'high', rule: 'recursive-delete-root-or-home', test: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|\/?$)/i },
  { severity: 'high', rule: 'reads-credentials', test: /(\.ssh\/|id_rsa|auth\.json|\.aws\/credentials|\.netrc|keychain)/i },
  { severity: 'high', rule: 'reads-env-file', test: /\b(cat|cp|scp|curl[^\n]*-d\s*@)\s+[^\n]*\.env\b/i },
  { severity: 'medium', rule: 'dynamic-eval', test: /\b(eval|exec)\s*\(/ },
  { severity: 'medium', rule: 'network-call', test: /\b(curl|wget|fetch|requests\.(get|post)|urllib|http\.client|axios)\b/i },
  { severity: 'medium', rule: 'privilege-escalation', test: /\bsudo\b|\bchmod\s+\+?[0-7]*[xs]/i },
  { severity: 'medium', rule: 'package-install', test: /\b(pip3?|npm|pnpm|yarn|brew|apt(-get)?|gem|cargo)\s+(install|i|add)\b/i },
];
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl']);

function walk(dir: string, rel: string, out: { files: string[]; symlinks: string[] }): void {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (out.files.length + out.symlinks.length > MAX_FILES) return;
    const r = path.join(rel, entry.name);
    if (entry.isSymbolicLink()) out.symlinks.push(r);
    else if (entry.isDirectory()) {
      if (entry.name === '.git' || shouldPruneSkillScanDirectory(entry.name)) continue;
      walk(dir, r, out);
    } else if (entry.isFile()) out.files.push(r);
  }
}

/** Read and validate `SKILL.md` frontmatter. */
function readSkillMeta(dir: string): { name: string; description?: string } | { error: string } {
  const file = path.join(dir, 'SKILL.md');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: 'SKILL.md not found' };
  }
  let data: Record<string, unknown>;
  try {
    data = matter(text).data;
  } catch (err) {
    return { error: `SKILL.md frontmatter is invalid: ${(err as Error).message}` };
  }
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) return { error: 'SKILL.md frontmatter needs a "name"' };
  if (!NAME_RE.test(name)) return { error: `skill name "${name}" must be a plain slug (letters, digits, . _ -)` };
  const description = typeof data.description === 'string' ? data.description.trim() : undefined;
  return { name, description };
}

/** Scan a skill folder. Never throws; never executes anything. */
export function scanSkill(dir: string): SkillScanReport {
  const abs = path.resolve(dir);
  const base: SkillScanReport = { dir: abs, fileCount: 0, findings: [], verdict: 'invalid' };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return { ...base, error: 'folder not found' };
  }
  if (!stat.isDirectory()) return { ...base, error: 'not a folder' };

  const meta = readSkillMeta(abs);
  if ('error' in meta) return { ...base, error: meta.error };

  const found = { files: [] as string[], symlinks: [] as string[] };
  walk(abs, '', found);
  const findings: SkillFinding[] = [];

  if (found.files.length + found.symlinks.length > MAX_FILES) {
    findings.push({ severity: 'high', rule: 'too-many-files', file: '.', excerpt: `more than ${MAX_FILES} files` });
  }
  for (const link of found.symlinks) findings.push({ severity: 'high', rule: 'symlink', file: link });

  for (const file of found.files.sort()) {
    const full = path.join(abs, file);
    if (SCRIPT_EXT.has(path.extname(file).toLowerCase())) findings.push({ severity: 'low', rule: 'contains-script', file });
    let buf: Buffer;
    try {
      const size = fs.statSync(full).size;
      if (size > MAX_TEXT_BYTES) {
        findings.push({ severity: 'medium', rule: 'large-file-not-scanned', file, excerpt: `${size} bytes` });
        continue;
      }
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (buf.includes(0)) {
      findings.push({ severity: 'medium', rule: 'binary-file-not-scanned', file });
      continue;
    }
    buf
      .toString('utf8')
      .split('\n')
      .forEach((text, i) => {
        for (const r of LINE_RULES) {
          if (r.test.test(text)) findings.push({ severity: r.severity, rule: r.rule, file, line: i + 1, excerpt: text.trim().slice(0, 160) });
        }
      });
  }

  const verdict = found.symlinks.length > 0 ? 'blocked' : findings.some((f) => f.severity === 'high') ? 'review' : 'ok';
  return { dir: abs, name: meta.name, description: meta.description, fileCount: found.files.length, findings, verdict };
}

export interface InstalledSkill {
  category: string;
  name: string;
  dir: string;
  description?: string;
}

/** List `<skillsRoot>/<category>/<skill>/SKILL.md`, sorted. A missing root is an empty list. */
export function listInstalledSkills(skillsRoot: string): InstalledSkill[] {
  const out: InstalledSkill[] = [];
  let cats: fs.Dirent[];
  try {
    cats = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const cat of cats) {
    if (!cat.isDirectory() || cat.name.startsWith('.') || shouldPruneSkillScanDirectory(cat.name)) continue;
    let skills: fs.Dirent[] = [];
    try {
      skills = fs.readdirSync(path.join(skillsRoot, cat.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of skills) {
      if (!s.isDirectory() || s.name.startsWith('.')) continue;
      const dir = path.join(skillsRoot, cat.name, s.name);
      const meta = readSkillMeta(dir);
      if ('error' in meta) continue;
      out.push({ category: cat.name, name: meta.name, dir, description: meta.description });
    }
  }
  return out.sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`));
}

export interface InstallSkillOptions {
  skillsRoot: string;
  /** Category folder under skillsRoot; created if missing. */
  category: string;
  /** Install even with HIGH findings (never overrides `blocked`). The caller shows the report first. */
  acknowledgeHigh?: boolean;
}

// ── Enable / disable / uninstall (ROADMAP 4.4b) ─────────────────────────────
//
// Hermes 0.22.5 has no skill off-switch — probed against a scratch home: no `skills
// disable` CLI subcommand, no `config.yaml` key, no `state.db` table; a `.disabled/`
// category inside the skills root is still loaded (dot-dirs are treated as categories)
// and `enabled: false` frontmatter is ignored. So disable = move the skill folder out of
// the skills root into a sibling `disabledRoot` Hermes never scans; enable = move it back.
// Both are plain renames on the same volume: reversible, file-backed, human-editable.

export interface ListedSkill extends InstalledSkill {
  enabled: boolean;
}

/** Union of `<skillsRoot>` (enabled) and `<disabledRoot>` (disabled), sorted. */
export function listSkillsWithState(skillsRoot: string, disabledRoot: string): ListedSkill[] {
  const enabled = listInstalledSkills(skillsRoot).map((s) => ({ ...s, enabled: true }));
  const disabled = listInstalledSkills(disabledRoot).map((s) => ({ ...s, enabled: false }));
  return [...enabled, ...disabled].sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`));
}

function validSlug(value: string): boolean {
  return NAME_RE.test(value);
}

export type SetSkillEnabledResult =
  | { ok: true; enabled: boolean; dir: string }
  | { ok: false; reason: 'bad-name' | 'not-found' | 'target-exists' | 'not-a-directory'; message: string };

/** Move `<category>/<name>` between the two roots. Never overwrites an existing target. */
export function setSkillEnabled(opts: {
  skillsRoot: string;
  disabledRoot: string;
  category: string;
  name: string;
  enabled: boolean;
}): SetSkillEnabledResult {
  const { skillsRoot, disabledRoot, category, name, enabled } = opts;
  if (!validSlug(category) || !validSlug(name)) {
    return { ok: false, reason: 'bad-name', message: `category and name must be plain slugs (got "${category}/${name}")` };
  }
  const fromRoot = enabled ? disabledRoot : skillsRoot;
  const toRoot = enabled ? skillsRoot : disabledRoot;
  const source = path.join(fromRoot, category, name);
  const target = path.join(toRoot, category, name);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return { ok: false, reason: 'not-found', message: `${source} does not exist` };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, reason: 'not-a-directory', message: `${source} is not a plain skill folder` };
  }
  if (fs.existsSync(target)) {
    return { ok: false, reason: 'target-exists', message: `${target} already exists; remove it first (never overwritten)` };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  return { ok: true, enabled, dir: target };
}

export type UninstallSkillResult =
  | { ok: true; dir: string }
  | { ok: false; reason: 'bad-name' | 'not-found' | 'not-a-directory'; message: string };

/**
 * Remove `<root>/<category>/<name>` for good. `root` may be the skills root or the
 * disabled root. Refuses symlinks and non-directories; slugs cannot escape the root
 * (NAME_RE rejects leading dots and slashes).
 */
export function uninstallSkill(opts: { root: string; category: string; name: string }): UninstallSkillResult {
  const { root, category, name } = opts;
  if (!validSlug(category) || !validSlug(name)) {
    return { ok: false, reason: 'bad-name', message: `category and name must be plain slugs (got "${category}/${name}")` };
  }
  const dir = path.join(root, category, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return { ok: false, reason: 'not-found', message: `${dir} does not exist` };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, reason: 'not-a-directory', message: `${dir} is not a plain skill folder` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, dir };
}

/** Skill names in the Hermes bundled manifest (`<skillsRoot>/.bundled_manifest`, lines `name:hash`). */
export function readBundledSkillNames(skillsRoot: string): Set<string> {
  const out = new Set<string>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(skillsRoot, '.bundled_manifest'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    const name = (i === -1 ? line : line.slice(0, i)).trim();
    if (name) out.add(name);
  }
  return out;
}

export type InstallSkillResult =
  | { installed: true; dir: string; report: SkillScanReport }
  | { installed: false; reason: 'invalid' | 'blocked' | 'needs-acknowledgement' | 'exists' | 'bad-category'; message: string; report: SkillScanReport };

/** Scan, then copy `srcDir` to `<skillsRoot>/<category>/<name>` atomically (temp dir + rename). */
export function installSkill(srcDir: string, opts: InstallSkillOptions): InstallSkillResult {
  const report = scanSkill(srcDir);
  const refuse = (reason: Extract<InstallSkillResult, { installed: false }>['reason'], message: string): InstallSkillResult => ({
    installed: false,
    reason,
    message,
    report,
  });
  if (report.verdict === 'invalid') return refuse('invalid', report.error ?? 'not a valid skill');
  if (report.verdict === 'blocked') return refuse('blocked', 'skill contains symlinks; remove them first');
  if (!NAME_RE.test(opts.category)) return refuse('bad-category', `category "${opts.category}" must be a plain slug`);
  if (report.verdict === 'review' && !opts.acknowledgeHigh) {
    return refuse('needs-acknowledgement', 'HIGH findings; read the report and install again with acknowledgement');
  }

  const target = path.join(opts.skillsRoot, opts.category, report.name as string);
  if (fs.existsSync(target)) return refuse('exists', `${target} already exists; remove it first (never overwritten)`);

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(parent, `.install-${report.name}-`));
  try {
    fs.cpSync(report.dir, tmp, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return !(base === '.git' || (src !== report.dir && shouldPruneSkillScanDirectory(base)));
      },
    });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return { installed: true, dir: target, report };
}
