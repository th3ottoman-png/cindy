/**
 * Skills manager host (ROADMAP 4.4b). Lists the Hermes home's installed skills, scans a
 * candidate (local folder or git clone) with the 4.4a static rules, installs only after
 * that report has been shown, and toggles/uninstalls installed skills.
 *
 * Enable/disable: Hermes 0.22.5 has no skill off-switch (probed — no CLI subcommand, no
 * config key, no state table; dot-categories still load; `enabled: false` frontmatter is
 * ignored), so disable moves the folder out of the skills root into a sibling
 * `skills-disabled/` root Hermes never scans; enable moves it back (both plain renames).
 *
 * Built-in skills (names in `<skillsRoot>/.bundled_manifest`) are listed but never
 * toggled or uninstalled: moving one would break Hermes's bundled-manifest hash tracking
 * and `hermes update` would silently re-seed it.
 *
 * This module is Electron-free: every side effect is injected so the host runs under
 * plain vitest. The production wiring (hermes home resolution, `git clone`) lives in
 * `skillsDesktop.ts`. The git clone is the only outbound call and runs exclusively when
 * the renderer explicitly scans a git URL (AGENTS §3).
 */

import {
  installSkill,
  listSkillsWithState,
  readBundledSkillNames,
  scanSkill,
  setSkillEnabled,
  uninstallSkill,
  type InstallSkillResult,
  type SkillScanReport,
} from '@cindy/maker-core/skills';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface SkillRow {
  /** `<category>/<name>` — the stable row id. */
  id: string;
  category: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Built-in (bundled-manifest) skill: listed, never toggled or uninstalled. */
  builtin: boolean;
}

export interface SkillsView {
  skills: SkillRow[];
  skillsRoot: string;
  disabledRoot: string;
}

export interface SkillScanRequest {
  source: 'local' | 'git';
  /** Local source: absolute or ~-less path of the candidate folder. */
  path?: string;
  /** Git source: clone URL (https://…, git@…, ssh://…). */
  url?: string;
  /** Git source: subdirectory inside the clone that holds the skill (monorepos). */
  subdir?: string;
}

export interface SkillScanResponse {
  report: SkillScanReport;
  /** Git scans only: one-shot token the install call consumes (clone kept in temp). */
  preparedId?: string;
  /** Git scans of multi-skill repos: candidate subdirectories to pick from. */
  candidates?: string[];
}

export interface SkillInstallRequest {
  source: 'local' | 'prepared';
  path?: string;
  preparedId?: string;
  category: string;
  acknowledgeHigh?: boolean;
}

export interface SkillsHostDeps {
  roots(): { skillsRoot: string; disabledRoot: string };
  /** Clone `url` into the empty directory `destDir`; rejects on failure (production: git). */
  clone(url: string, destDir: string): Promise<void>;
  /** Base for temp clones (tests inject a tmp dir; production defaults to os.tmpdir()). */
  tmpdir?(): string;
  /** Prepared-clone TTL in ms (tests inject a small value). Default 10 minutes. */
  preparedTtlMs?: number;
}

export interface SkillsHost {
  list(): Promise<SkillsView>;
  scan(request: unknown): Promise<SkillScanResponse>;
  install(request: unknown): Promise<InstallSkillResult>;
  setEnabled(request: unknown): Promise<SkillsView>;
  uninstall(request: unknown): Promise<SkillsView>;
}

const GIT_URL_RE = /^(https:\/\/\S+|git@[^:\s]+:\S+|ssh:\/\/\S+)$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const PREPARED_CAP = 8;
const DEFAULT_PREPARED_TTL_MS = 10 * 60 * 1000;

function requireSlug(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new Error(`${field} must be a plain slug (letters, digits, . _ -)`);
  }
  return value;
}

export function createSkillsHost(deps: SkillsHostDeps): SkillsHost {
  const prepared = new Map<string, { cloneDir: string; skillDir: string; expires: number }>();
  const ttl = deps.preparedTtlMs ?? DEFAULT_PREPARED_TTL_MS;

  function sweepPrepared(): void {
    const now = Date.now();
    for (const [id, p] of prepared) {
      if (p.expires <= now) {
        fs.rmSync(p.cloneDir, { recursive: true, force: true });
        prepared.delete(id);
      }
    }
    while (prepared.size > PREPARED_CAP) {
      const oldest = prepared.keys().next().value as string;
      fs.rmSync(prepared.get(oldest)!.cloneDir, { recursive: true, force: true });
      prepared.delete(oldest);
    }
  }

  /** Locate the skill folder inside a fresh clone: optional subdir, root, or exactly one 1-level subdir. */
  function findSkillDir(cloneDir: string, subdir?: string): { dir: string } | { candidates: string[] } {
    if (subdir) {
      const dir = path.join(cloneDir, subdir);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
        throw new Error(`no SKILL.md at ${subdir}/ in the clone`);
      }
      return { dir };
    }
    if (fs.existsSync(path.join(cloneDir, 'SKILL.md'))) return { dir: cloneDir };
    const matches: string[] = [];
    for (const entry of fs.readdirSync(cloneDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (fs.existsSync(path.join(cloneDir, entry.name, 'SKILL.md'))) matches.push(entry.name);
    }
    if (matches.length === 1) return { dir: path.join(cloneDir, matches[0]) };
    return { candidates: matches };
  }

  function parseScan(request: unknown): SkillScanRequest {
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const source = r.source;
    if (source !== 'local' && source !== 'git') throw new Error('source must be "local" or "git"');
    const out: SkillScanRequest = { source };
    if (source === 'local') {
      if (typeof r.path !== 'string' || r.path.trim() === '') throw new Error('path (folder) required');
      out.path = r.path;
    } else {
      if (typeof r.url !== 'string' || !GIT_URL_RE.test(r.url.trim())) {
        throw new Error('url must be a git URL (https://…, git@…, ssh://…)');
      }
      out.url = r.url.trim();
      if (r.subdir !== undefined) {
        if (typeof r.subdir !== 'string' || r.subdir.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
          throw new Error('subdir must be a relative path inside the clone');
        }
        out.subdir = r.subdir;
      }
    }
    return out;
  }

  return {
    async list() {
      const { skillsRoot, disabledRoot } = deps.roots();
      const bundled = readBundledSkillNames(skillsRoot);
      const skills: SkillRow[] = listSkillsWithState(skillsRoot, disabledRoot).map((s) => ({
        id: `${s.category}/${s.name}`,
        category: s.category,
        name: s.name,
        ...(s.description ? { description: s.description } : {}),
        enabled: s.enabled,
        builtin: bundled.has(s.name),
      }));
      return { skills, skillsRoot, disabledRoot };
    },

    async scan(request) {
      sweepPrepared();
      const req = parseScan(request);
      if (req.source === 'local') {
        return { report: scanSkill(req.path as string) };
      }
      // git: clone (the only outbound call, on this explicit request), locate, scan, keep temp.
      const cloneDir = fs.mkdtempSync(path.join(deps.tmpdir?.() ?? os.tmpdir(), 'cindy-skill-clone-'));
      try {
        await deps.clone(req.url as string, cloneDir);
      } catch (err) {
        fs.rmSync(cloneDir, { recursive: true, force: true });
        throw new Error(`git clone failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const found = findSkillDir(cloneDir, req.subdir);
      if ('candidates' in found) {
        fs.rmSync(cloneDir, { recursive: true, force: true });
        if (found.candidates.length === 0) throw new Error('no SKILL.md found at the clone root or one level below');
        return {
          report: { dir: req.url as string, fileCount: 0, findings: [], verdict: 'invalid', error: 'repo contains several skills; pick a subdirectory' },
          candidates: found.candidates,
        };
      }
      const report = scanSkill(found.dir);
      const preparedId = `prep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      prepared.set(preparedId, { cloneDir, skillDir: found.dir, expires: Date.now() + ttl });
      sweepPrepared();
      return { report, preparedId };
    },

    async install(request) {
      sweepPrepared();
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const category = requireSlug(r.category, 'category');
      const acknowledgeHigh = r.acknowledgeHigh === true;
      const { skillsRoot } = deps.roots();

      let srcDir: string;
      let cleanup: string | null = null;
      if (r.source === 'local') {
        if (typeof r.path !== 'string' || r.path.trim() === '') throw new Error('path (folder) required');
        srcDir = r.path;
      } else if (r.source === 'prepared') {
        if (typeof r.preparedId !== 'string') throw new Error('preparedId required');
        const p = prepared.get(r.preparedId);
        if (!p) throw new Error('prepared clone expired; scan again');
        prepared.delete(r.preparedId); // one-shot
        cleanup = p.cloneDir;
        srcDir = p.skillDir;
      } else {
        throw new Error('source must be "local" or "prepared"');
      }

      try {
        return installSkill(srcDir, { skillsRoot, category, acknowledgeHigh });
      } finally {
        if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
      }
    },

    async setEnabled(request) {
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const category = requireSlug(r.category, 'category');
      const name = requireSlug(r.name, 'name');
      if (typeof r.enabled !== 'boolean') throw new Error('enabled (boolean) required');
      const { skillsRoot, disabledRoot } = deps.roots();
      if (readBundledSkillNames(skillsRoot).has(name)) {
        throw new Error(`"${name}" is a built-in skill; built-ins are managed by Hermes updates and cannot be toggled here`);
      }
      const result = setSkillEnabled({ skillsRoot, disabledRoot, category, name, enabled: r.enabled });
      if (!result.ok) throw new Error(result.message);
      return this.list();
    },

    async uninstall(request) {
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const category = requireSlug(r.category, 'category');
      const name = requireSlug(r.name, 'name');
      const { skillsRoot, disabledRoot } = deps.roots();
      if (readBundledSkillNames(skillsRoot).has(name)) {
        throw new Error(`"${name}" is a built-in skill; built-ins are managed by Hermes updates and cannot be removed here`);
      }
      const inEnabled = fs.existsSync(path.join(skillsRoot, category, name));
      const inDisabled = fs.existsSync(path.join(disabledRoot, category, name));
      if (!inEnabled && !inDisabled) throw new Error(`unknown skill: ${category}/${name}`);
      const result = uninstallSkill({ root: inEnabled ? skillsRoot : disabledRoot, category, name });
      if (!result.ok) throw new Error(result.message);
      return this.list();
    },
  };
}

export interface SkillsHandlerDeps {
  host: SkillsHost;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production: send to every BrowserWindow. */
  broadcast(channel: string, payload?: unknown): void;
}

/** maker:skills:* IPC: the Settings section lists, scans, installs and toggles skills. */
export function registerSkillsHandlers(registry: IpcHandlerRegistry, deps: SkillsHandlerDeps): void {
  registry.handle(MAKER_INVOKE.SKILLS_LIST, async (event) => {
    deps.assertTrusted(event);
    return deps.host.list();
  });
  registry.handle(MAKER_INVOKE.SKILLS_SCAN, async (event, request: unknown) => {
    deps.assertTrusted(event);
    return deps.host.scan(request);
  });
  registry.handle(MAKER_INVOKE.SKILLS_INSTALL, async (event, request: unknown) => {
    deps.assertTrusted(event);
    const result = await deps.host.install(request);
    deps.broadcast(MAKER_PUSH.SKILLS_CHANGED);
    return result;
  });
  registry.handle(MAKER_INVOKE.SKILLS_SET_ENABLED, async (event, request: unknown) => {
    deps.assertTrusted(event);
    const fresh = await deps.host.setEnabled(request);
    deps.broadcast(MAKER_PUSH.SKILLS_CHANGED);
    return fresh;
  });
  registry.handle(MAKER_INVOKE.SKILLS_UNINSTALL, async (event, request: unknown) => {
    deps.assertTrusted(event);
    const fresh = await deps.host.uninstall(request);
    deps.broadcast(MAKER_PUSH.SKILLS_CHANGED);
    return fresh;
  });
}
