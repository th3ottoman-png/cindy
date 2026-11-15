/**
 * Last-known-good (LKG) config snapshots and rollback (ROADMAP 14.5, blueprint §4 & §7, ADR 0015).
 *
 * Snapshots only config-layer files (`~/.cindy-harness/*.yaml`, `*.json`, `experts/<slug>/*`,
 * and `~/.hermes-cindy/config.yaml`), strictly excluding credentials, `.env`, keys, DBs, and
 * runtime directories. Supports atomic staging, SHA-256 verification, retention pruning,
 * app-closed guard for `hermes/config.yaml`, and rollback with `.pre-rollback-<stamp>` backup.
 */

import * as crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import matter from 'gray-matter';

import { assertNotDailyHermes } from './context.js';
import { runChecks } from './runner.js';
import { createRegistry } from './registry.js';
import type {
  CheckResult,
  DoctorContext,
  DoctorPack,
  DoctorReport,
  Severity,
} from './types.js';

export const FIXED_SMALL_JSON_FILES = [
  'housekeeping.json',
  'plugins.json',
  'security.json',
  'vault.json',
] as const;

const FIXED_HARNESS_YAML_FILES = [
  'providers.yaml',
  'routing.yaml',
  'guardrails.yaml',
  'web-budget.yaml',
] as const;

const EXCLUDED_PATH_SEGMENTS = new Set(['session-homes', 'cache', 'installs', 'logs']);
const STAMP_DIR_REGEX = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,3}))?Z$/;
const MS_PER_DAY = 86_400_000;

export const DEFAULT_DOCTOR_SETTINGS: DoctorSettings = {
  lkgKeep: 20,
  lkgMinDays: 14,
  runOnStart: true,
};

export interface DoctorSettings {
  lkgKeep: number;
  lkgMinDays: number;
  runOnStart: boolean;
}

export interface LkgSnapshotFileEntry {
  rel: string;
  sha256: string;
  bytes: number;
}

export interface LkgSnapshotVersions {
  capturedAt: string;
  node: string;
  pnpm: { version: string | null };
  hermes: { version: string | null; path: string | null; pinned: string | null };
  claude: { version: string | null; path: string | null };
  codex: { version: string | null; path: string | null };
  pi: { version: string | null; path: string | null };
}

export interface LkgSnapshotManifest {
  formatVersion: 1;
  stamp: string;
  createdAt: string;
  reason: string;
  reportCounts: Record<Severity, number>;
  files: LkgSnapshotFileEntry[];
}

export interface LkgSnapshotRecord {
  stamp: string;
  dir: string;
  createdMs: number;
  manifest: LkgSnapshotManifest | null;
  valid: boolean;
  validationError?: string;
}

export interface CreateLkgSnapshotOptions {
  reason?: string;
  report?: DoctorReport;
  packs?: readonly DoctorPack[];
}

export interface CreateLkgSnapshotResult {
  stamp: string;
  dir: string;
  manifest: LkgSnapshotManifest;
  versions: LkgSnapshotVersions;
  pruned: string[];
}

export interface PruneLkgSnapshotsResult {
  kept: string[];
  removed: string[];
}

export interface LkgDiffResult {
  hasSnapshot: boolean;
  stamp?: string;
  snapshotValid: boolean;
  snapshotError?: string;
  changed: string[];
  added: string[];
  removed: string[];
  totalSnapshotFiles: number;
}

export interface LkgRollbackPlanItem {
  rel: string;
  destPath: string;
  snapshotFilePath: string;
  sha256: string;
  bytes: number;
  wouldMoveAside: boolean;
}

export interface LkgRollbackPlan {
  ok: boolean;
  stamp: string;
  requiresAppClosed: boolean;
  items: LkgRollbackPlanItem[];
  refusedReason?: 'app-running' | 'invalid-stamp' | 'not-found' | 'invalid-manifest' | 'integrity-error' | 'invalid-path';
  error?: string;
}

export interface RollbackLkgOptions {
  stamp: string;
  fileRel?: string;
  fileRels?: string[];
  packs?: readonly DoctorPack[];
  skipRecheck?: boolean;
}

export interface RollbackLkgResult {
  ok: boolean;
  stamp: string;
  restored: string[];
  movedAside: string[];
  refusedReason?: LkgRollbackPlan['refusedReason'];
  error?: string;
  configReport?: DoctorReport;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function resolveLkgRootDir(ctx: DoctorContext): string {
  return path.join(ctx.paths.harnessDir, 'doctor', 'lkg');
}

export function formatSnapshotStamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

export function parseSnapshotStampMs(stamp: string): number | null {
  const match = STAMP_DIR_REGEX.exec(stamp);
  if (!match) return null;
  const [, datePart, hh, mm, ss, msRaw] = match;
  const msPart = msRaw ? `.${msRaw.padEnd(3, '0')}` : '.000';
  const parsed = Date.parse(`${datePart}T${hh}:${mm}:${ss}${msPart}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Returns true if `rel` touches any excluded file/extension/directory:
 * `.env*`, `auth.json`, `*.key`, `*token*`, `*credential*`, `*secret*`,
 * `*.db*`, `*.sqlite*`, `session-homes/`, `cache/`, `installs/`, `logs/`.
 */
export function isExcludedSnapshotRelPath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/')) return true;
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return true;
    const lower = seg.toLowerCase();
    if (EXCLUDED_PATH_SEGMENTS.has(lower)) return true;
    if (lower.includes('token') || lower.includes('credential') || lower.includes('secret')) {
      return true;
    }
  }

  const base = segments[segments.length - 1]!.toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'auth.json') return true;
  if (base.endsWith('.key')) return true;
  if (/\.(?:db|sqlite\d*)(?:$|[-.])/.test(base)) return true;
  return false;
}

export async function loadDoctorSettings(ctx: DoctorContext): Promise<DoctorSettings> {
  const cfgPath = path.join(ctx.paths.harnessDir, 'doctor', 'doctor.yaml');
  let raw: string;
  try {
    const st = await fs.lstat(cfgPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ...DEFAULT_DOCTOR_SETTINGS };
    }
    raw = await fs.readFile(cfgPath, 'utf8');
  } catch {
    return { ...DEFAULT_DOCTOR_SETTINGS };
  }

  try {
    const parsed = matter(`---\n${raw}\n---\n`, {});
    const data = parsed.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ...DEFAULT_DOCTOR_SETTINGS };
    }
    const rec = data as Record<string, unknown>;
    const lkgKeep =
      typeof rec.lkg_keep === 'number' && Number.isInteger(rec.lkg_keep) && rec.lkg_keep >= 0
        ? rec.lkg_keep
        : DEFAULT_DOCTOR_SETTINGS.lkgKeep;
    const lkgMinDays =
      typeof rec.lkg_min_days === 'number' && Number.isFinite(rec.lkg_min_days) && rec.lkg_min_days >= 0
        ? rec.lkg_min_days
        : DEFAULT_DOCTOR_SETTINGS.lkgMinDays;
    const runOnStart =
      typeof rec.run_on_start === 'boolean' ? rec.run_on_start : DEFAULT_DOCTOR_SETTINGS.runOnStart;
    return { lkgKeep, lkgMinDays, runOnStart };
  } catch {
    return { ...DEFAULT_DOCTOR_SETTINGS };
  }
}

function upsertYamlScalarLine(lines: string[], key: string, value: string): void {
  const regex = new RegExp(`^(\\s*)${key}\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    if (regex.test(lines[i]!)) {
      const indent = lines[i]!.match(regex)?.[1] ?? '';
      lines[i] = `${indent}${key}: ${value}`;
      return;
    }
  }
  lines.push(`${key}: ${value}`);
}

/**
 * Atomically persist Cindy Doctor settings to `~/.cindy-harness/doctor/doctor.yaml`,
 * preserving any existing keys and comments.
 */
export async function saveDoctorSettings(
  ctx: DoctorContext,
  patch: Partial<DoctorSettings>,
): Promise<DoctorSettings> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);
  const current = await loadDoctorSettings(ctx);
  const next: DoctorSettings = {
    lkgKeep:
      typeof patch.lkgKeep === 'number' && Number.isInteger(patch.lkgKeep) && patch.lkgKeep >= 0
        ? patch.lkgKeep
        : current.lkgKeep,
    lkgMinDays:
      typeof patch.lkgMinDays === 'number' && Number.isFinite(patch.lkgMinDays) && patch.lkgMinDays >= 0
        ? patch.lkgMinDays
        : current.lkgMinDays,
    runOnStart: typeof patch.runOnStart === 'boolean' ? patch.runOnStart : current.runOnStart,
  };

  const cfgPath = path.join(ctx.paths.harnessDir, 'doctor', 'doctor.yaml');
  await fs.mkdir(path.dirname(cfgPath), { recursive: true });

  let raw = '';
  try {
    const st = await fs.lstat(cfgPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlinked doctor.yaml: ${cfgPath}`);
    }
    if (st.isFile()) {
      raw = await fs.readFile(cfgPath, 'utf8');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }

  const lines = raw.length > 0 ? raw.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  if (lines.length === 0 || patch.lkgKeep !== undefined) {
    upsertYamlScalarLine(lines, 'lkg_keep', String(next.lkgKeep));
  }
  if (lines.length === 0 || patch.lkgMinDays !== undefined) {
    upsertYamlScalarLine(lines, 'lkg_min_days', String(next.lkgMinDays));
  }
  upsertYamlScalarLine(lines, 'run_on_start', next.runOnStart ? 'true' : 'false');

  const tmpPath = path.join(
    path.dirname(cfgPath),
    `.doctor.yaml.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  await fs.writeFile(tmpPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(tmpPath, cfgPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  return next;
}

export interface DiscoveredConfigFile {
  rel: string;
  absPath: string;
}

async function isRegularNonSymlinkFile(filePath: string): Promise<boolean> {
  try {
    const st = await fs.lstat(filePath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

export async function collectConfigSnapshotCandidates(
  ctx: DoctorContext,
): Promise<DiscoveredConfigFile[]> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);

  const candidates = new Map<string, string>();
  const addCandidate = async (rel: string, absPath: string): Promise<void> => {
    if (isExcludedSnapshotRelPath(rel)) return;
    if (await isRegularNonSymlinkFile(absPath)) {
      candidates.set(rel, absPath);
    }
  };

  for (const name of FIXED_HARNESS_YAML_FILES) {
    await addCandidate(`harness/${name}`, path.join(ctx.paths.harnessDir, name));
  }

  for (const name of FIXED_SMALL_JSON_FILES) {
    await addCandidate(`harness/${name}`, path.join(ctx.paths.harnessDir, name));
  }

  try {
    const rootEntries = await fs.readdir(ctx.paths.harnessDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.name.endsWith('-sessions.json')) {
        await addCandidate(`harness/${entry.name}`, path.join(ctx.paths.harnessDir, entry.name));
      }
    }
  } catch {
    // harnessDir missing or unreadable; handled gracefully
  }

  const expertsDir = path.join(ctx.paths.harnessDir, 'experts');
  try {
    const expertsDirStat = await fs.lstat(expertsDir);
    if (!expertsDirStat.isSymbolicLink() && expertsDirStat.isDirectory()) {
      const slugEntries = await fs.readdir(expertsDir, { withFileTypes: true });
      for (const entry of slugEntries) {
        if (entry.name.startsWith('.')) continue;
        const slugDir = path.join(expertsDir, entry.name);
        let slugStat: Stats;
        try {
          slugStat = await fs.lstat(slugDir);
        } catch {
          continue;
        }
        if (slugStat.isSymbolicLink() || !slugStat.isDirectory()) continue;
        await addCandidate(
          `harness/experts/${entry.name}/expert.md`,
          path.join(slugDir, 'expert.md'),
        );
        await addCandidate(
          `harness/experts/${entry.name}/tools.yaml`,
          path.join(slugDir, 'tools.yaml'),
        );
      }
    }
  } catch {
    // expertsDir missing is optional
  }

  await addCandidate('hermes/config.yaml', path.join(ctx.paths.hermesHome, 'config.yaml'));

  return [...candidates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, absPath]) => ({ rel, absPath }));
}

async function readCurrentConfigFilesWithHashes(ctx: DoctorContext): Promise<
  Array<{ rel: string; absPath: string; bytesBuf: Buffer; sha256: string; bytes: number }>
> {
  const candidates = await collectConfigSnapshotCandidates(ctx);
  const out: Array<{ rel: string; absPath: string; bytesBuf: Buffer; sha256: string; bytes: number }> = [];
  for (const item of candidates) {
    try {
      const st = await fs.lstat(item.absPath);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const buf = await fs.readFile(item.absPath);
      out.push({
        rel: item.rel,
        absPath: item.absPath,
        bytesBuf: buf,
        sha256: sha256Hex(buf),
        bytes: buf.byteLength,
      });
    } catch {
      // File disappeared or unreadable between discovery and read
    }
  }
  return out;
}

export function buildVersionsFromResults(
  ctx: DoctorContext,
  capturedAt: string,
  results: readonly CheckResult[],
): LkgSnapshotVersions {
  const byId = new Map(results.map((r) => [r.id, r]));
  const strOrNull = (val: unknown): string | null => (typeof val === 'string' && val.length > 0 ? val : null);

  const nodeEv = byId.get('env.node')?.evidence;
  const pnpmEv = byId.get('env.pnpm')?.evidence;
  const hermesPresentEv = byId.get('runtime.hermes.present')?.evidence;
  const hermesPinEv = byId.get('runtime.hermes.pin')?.evidence;
  const claudeEv = byId.get('runtime.claude.present')?.evidence;
  const codexEv = byId.get('runtime.codex.present')?.evidence;
  const piEv = byId.get('runtime.pi.present')?.evidence;

  return {
    capturedAt,
    node: strOrNull(nodeEv?.node) ?? (ctx.host?.node ?? process.versions.node).replace(/^v/, ''),
    pnpm: {
      version: strOrNull(pnpmEv?.installed) ?? strOrNull(pnpmEv?.pinned),
    },
    hermes: {
      version: strOrNull(hermesPresentEv?.version) ?? strOrNull(hermesPinEv?.installed),
      path: strOrNull(hermesPresentEv?.path) ?? strOrNull(hermesPresentEv?.launcherPath),
      pinned: ctx.hermesPinnedVersion ?? null,
    },
    claude: {
      version: strOrNull(claudeEv?.version),
      path: strOrNull(claudeEv?.path),
    },
    codex: {
      version: strOrNull(codexEv?.version),
      path: strOrNull(codexEv?.path),
    },
    pi: {
      version: strOrNull(piEv?.version),
      path: strOrNull(piEv?.path),
    },
  };
}

function isValidManifest(raw: unknown): raw is LkgSnapshotManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if (obj.formatVersion !== 1) return false;
  if (typeof obj.stamp !== 'string' || !STAMP_DIR_REGEX.test(obj.stamp)) return false;
  if (typeof obj.createdAt !== 'string') return false;
  if (typeof obj.reason !== 'string') return false;
  if (!obj.reportCounts || typeof obj.reportCounts !== 'object' || Array.isArray(obj.reportCounts)) {
    return false;
  }
  if (!Array.isArray(obj.files)) return false;
  for (const item of obj.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const f = item as Record<string, unknown>;
    if (
      typeof f.rel !== 'string' ||
      isExcludedSnapshotRelPath(f.rel) ||
      typeof f.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      typeof f.bytes !== 'number' ||
      !Number.isInteger(f.bytes) ||
      f.bytes < 0
    ) {
      return false;
    }
  }
  return true;
}

async function readSnapshotManifest(dir: string): Promise<{
  manifest: LkgSnapshotManifest | null;
  error?: string;
}> {
  const manifestPath = path.join(dir, 'manifest.json');
  try {
    const st = await fs.lstat(manifestPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { manifest: null, error: 'manifest.json is missing or not a regular file' };
    }
    const text = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!isValidManifest(parsed)) {
      return { manifest: null, error: 'manifest.json failed schema validation' };
    }
    return { manifest: parsed };
  } catch (err) {
    return {
      manifest: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listLkgSnapshots(ctx: DoctorContext): Promise<LkgSnapshotRecord[]> {
  const lkgRoot = resolveLkgRootDir(ctx);
  let entries: string[];
  try {
    const rootStat = await fs.lstat(lkgRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
    entries = await fs.readdir(lkgRoot);
  } catch {
    return [];
  }

  const records: LkgSnapshotRecord[] = [];
  for (const name of entries) {
    const createdMs = parseSnapshotStampMs(name);
    if (createdMs === null) continue;
    const dir = path.join(lkgRoot, name);
    let st: Stats;
    try {
      st = await fs.lstat(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;

    const { manifest, error } = await readSnapshotManifest(dir);
    records.push({
      stamp: name,
      dir,
      createdMs,
      manifest,
      valid: manifest !== null && manifest.stamp === name,
      ...(error
        ? { validationError: error }
        : manifest && manifest.stamp !== name
          ? { validationError: `manifest stamp ${manifest.stamp} does not match directory ${name}` }
          : {}),
    });
  }

  return records.sort((a, b) => b.createdMs - a.createdMs || b.stamp.localeCompare(a.stamp));
}

export async function pruneLkgSnapshots(
  ctx: DoctorContext,
  settingsOverride?: Partial<DoctorSettings>,
): Promise<PruneLkgSnapshotsResult> {
  const settings = { ...(await loadDoctorSettings(ctx)), ...settingsOverride };
  const lkgRoot = resolveLkgRootDir(ctx);
  let entries: string[];
  try {
    const rootStat = await fs.lstat(lkgRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { kept: [], removed: [] };
    }
    entries = await fs.readdir(lkgRoot);
  } catch {
    return { kept: [], removed: [] };
  }

  const candidates: Array<{ stamp: string; dir: string; createdMs: number }> = [];
  for (const name of entries) {
    const createdMs = parseSnapshotStampMs(name);
    if (createdMs === null) continue;
    const dir = path.join(lkgRoot, name);
    let st: Stats;
    try {
      st = await fs.lstat(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    candidates.push({ stamp: name, dir, createdMs });
  }

  candidates.sort((a, b) => b.createdMs - a.createdMs || b.stamp.localeCompare(a.stamp));

  const nowMs = ctx.now().getTime();
  const minAgeMs = settings.lkgMinDays * MS_PER_DAY;
  const kept: string[] = [];
  const removed: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i]!;
    const ageMs = nowMs - item.createdMs;
    const keepByCount = i < settings.lkgKeep;
    const keepByAge = ageMs < minAgeMs;
    if (keepByCount || keepByAge) {
      kept.push(item.stamp);
    } else {
      await fs.rm(item.dir, { recursive: true, force: false });
      removed.push(item.stamp);
    }
  }

  return { kept, removed };
}

async function resolveUniqueStamp(lkgRoot: string, baseDate: Date): Promise<{ stamp: string; createdAt: string }> {
  let ms = baseDate.getTime();
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const d = new Date(ms + attempt);
    const stamp = formatSnapshotStamp(d);
    try {
      await fs.lstat(path.join(lkgRoot, stamp));
    } catch {
      return { stamp, createdAt: d.toISOString() };
    }
  }
  throw new Error('Could not allocate unique LKG snapshot stamp after 1000 attempts');
}

export async function createLkgSnapshot(
  ctx: DoctorContext,
  options: CreateLkgSnapshotOptions = {},
): Promise<CreateLkgSnapshotResult> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);

  const packs = options.packs ?? (await import('./packs/index.js')).ALL_PACKS;
  const report =
    options.report ??
    (await runChecks(createRegistry(packs), { ...ctx, includeApi: false }, {
      cost: ['instant', 'fast'],
    }));

  const lkgRoot = resolveLkgRootDir(ctx);
  await fs.mkdir(lkgRoot, { recursive: true });

  const { stamp, createdAt } = await resolveUniqueStamp(lkgRoot, ctx.now());
  const finalDir = path.join(lkgRoot, stamp);
  const stagingDir = path.join(lkgRoot, `.tmp-${stamp}-${process.pid}-${crypto.randomUUID()}`);

  const discovered = await readCurrentConfigFilesWithHashes(ctx);
  const versions = buildVersionsFromResults(ctx, createdAt, report.results);
  const manifest: LkgSnapshotManifest = {
    formatVersion: 1,
    stamp,
    createdAt,
    reason: options.reason ?? 'manual',
    reportCounts: { ...report.counts },
    files: discovered.map((f) => ({
      rel: f.rel,
      sha256: f.sha256,
      bytes: f.bytes,
    })),
  };

  try {
    await fs.mkdir(path.join(stagingDir, 'files'), { recursive: true });
    for (const file of discovered) {
      const destPath = path.join(stagingDir, 'files', file.rel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, file.bytesBuf);
    }
    await fs.writeFile(path.join(stagingDir, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await fs.rename(stagingDir, finalDir);
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const pruned = manifest.reason.startsWith('pre-fix:')
    ? { kept: [] as string[], removed: [] as string[] }
    : await pruneLkgSnapshots(ctx);
  return {
    stamp,
    dir: finalDir,
    manifest,
    versions,
    pruned: pruned.removed,
  };
}

export async function diffAgainstLatestLkg(ctx: DoctorContext): Promise<LkgDiffResult> {
  const allSnapshots = await listLkgSnapshots(ctx);
  const snapshots = allSnapshots.filter(
    (snap) => !snap.valid || !snap.manifest || !snap.manifest.reason.startsWith('pre-fix:'),
  );
  if (snapshots.length === 0) {
    return {
      hasSnapshot: false,
      snapshotValid: true,
      changed: [],
      added: [],
      removed: [],
      totalSnapshotFiles: 0,
    };
  }

  const latest = snapshots[0]!;
  if (!latest.valid || !latest.manifest) {
    return {
      hasSnapshot: true,
      stamp: latest.stamp,
      snapshotValid: false,
      snapshotError: latest.validationError ?? 'invalid manifest.json',
      changed: [],
      added: [],
      removed: [],
      totalSnapshotFiles: 0,
    };
  }

  const expectedByRel = new Map<string, LkgSnapshotFileEntry>();
  for (const entry of latest.manifest.files) {
    expectedByRel.set(entry.rel, entry);
  }

  const currentFiles = await readCurrentConfigFilesWithHashes(ctx);
  const currentByRel = new Map<string, string>(currentFiles.map((f) => [f.rel, f.sha256]));

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [rel, entry] of expectedByRel) {
    const snapCopyPath = path.join(latest.dir, 'files', rel);
    try {
      const st = await fs.lstat(snapCopyPath);
      if (st.isSymbolicLink() || !st.isFile()) {
        return {
          hasSnapshot: true,
          stamp: latest.stamp,
          snapshotValid: false,
          snapshotError: `snapshot file ${rel} is missing or not a regular file`,
          changed: [],
          added: [],
          removed: [],
          totalSnapshotFiles: latest.manifest.files.length,
        };
      }
      const snapBytes = await fs.readFile(snapCopyPath);
      if (sha256Hex(snapBytes) !== entry.sha256) {
        return {
          hasSnapshot: true,
          stamp: latest.stamp,
          snapshotValid: false,
          snapshotError: `snapshot file ${rel} sha256 mismatch against manifest.json`,
          changed: [],
          added: [],
          removed: [],
          totalSnapshotFiles: latest.manifest.files.length,
        };
      }
    } catch {
      return {
        hasSnapshot: true,
        stamp: latest.stamp,
        snapshotValid: false,
        snapshotError: `snapshot file ${rel} could not be read`,
        changed: [],
        added: [],
        removed: [],
        totalSnapshotFiles: latest.manifest.files.length,
      };
    }

    const liveHash = currentByRel.get(rel);
    if (liveHash === undefined) {
      removed.push(rel);
    } else if (liveHash !== entry.sha256) {
      changed.push(rel);
    }
  }

  for (const rel of currentByRel.keys()) {
    if (!expectedByRel.has(rel)) {
      added.push(rel);
    }
  }

  changed.sort();
  added.sort();
  removed.sort();

  return {
    hasSnapshot: true,
    stamp: latest.stamp,
    snapshotValid: true,
    changed,
    added,
    removed,
    totalSnapshotFiles: latest.manifest.files.length,
  };
}

export function resolveRestoreDestination(ctx: DoctorContext, rel: string): string | null {
  if (isExcludedSnapshotRelPath(rel)) return null;
  if (rel === 'hermes/config.yaml') {
    return path.join(ctx.paths.hermesHome, 'config.yaml');
  }
  if (rel.startsWith('harness/')) {
    const sub = rel.slice('harness/'.length);
    const dest = path.resolve(ctx.paths.harnessDir, sub);
    const root = path.resolve(ctx.paths.harnessDir);
    if (dest !== root && dest.startsWith(`${root}${path.sep}`)) {
      return dest;
    }
  }
  return null;
}

async function isAppRunning(ctx: DoctorContext): Promise<boolean> {
  if (ctx.appRunning !== undefined) {
    return ctx.appRunning;
  }
  const { detectAppRunningState } = await import('./packs/processes.js');
  const state = await detectAppRunningState(ctx);
  return state.running;
}

async function assertNoSymlinkInRelativeChain(baseDir: string, targetPath: string): Promise<void> {
  const rel = path.relative(baseDir, targetPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing restore outside allowed root: ${targetPath}`);
  }
  const parts = rel.split(path.sep).filter(Boolean);
  let cursor = baseDir;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const st = await fs.lstat(cursor);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to traverse or overwrite symlink: ${cursor}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw err;
    }
  }
}

export async function planLkgRollback(
  ctx: DoctorContext,
  options: RollbackLkgOptions,
): Promise<LkgRollbackPlan> {
  const failPlan = (
    refusedReason: LkgRollbackPlan['refusedReason'],
    error: string,
    requiresAppClosed = false,
  ): LkgRollbackPlan => ({
    ok: false,
    stamp: options.stamp,
    requiresAppClosed,
    items: [],
    refusedReason,
    error,
  });

  if (!STAMP_DIR_REGEX.test(options.stamp)) {
    return failPlan('invalid-stamp', `Invalid snapshot stamp: ${options.stamp}`);
  }

  const snapDir = path.join(resolveLkgRootDir(ctx), options.stamp);
  try {
    const st = await fs.lstat(snapDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return failPlan('not-found', `Snapshot ${options.stamp} not found`);
    }
  } catch {
    return failPlan('not-found', `Snapshot ${options.stamp} not found`);
  }

  const { manifest, error: manifestError } = await readSnapshotManifest(snapDir);
  if (!manifest || manifest.stamp !== options.stamp) {
    return failPlan(
      'invalid-manifest',
      manifestError ?? `Snapshot ${options.stamp} has an invalid manifest.json`,
    );
  }

  const normalizedFilter = options.fileRel?.replace(/\\/g, '/').trim();
  const normalizedFilters = options.fileRels
    ? options.fileRels.map((rel) => rel.replace(/\\/g, '/').trim())
    : normalizedFilter !== undefined
      ? [normalizedFilter]
      : null;

  if (normalizedFilters !== null) {
    for (const rel of normalizedFilters) {
      if (isExcludedSnapshotRelPath(rel) || !resolveRestoreDestination(ctx, rel)) {
        return failPlan('invalid-path', `Unsupported or excluded restore target: ${rel}`);
      }
    }
  }

  const filterSet = normalizedFilters ? new Set(normalizedFilters) : null;
  const selectedEntries = filterSet
    ? manifest.files.filter((f) => filterSet.has(f.rel))
    : manifest.files;

  if (selectedEntries.length === 0) {
    return failPlan(
      'not-found',
      normalizedFilter
        ? `File ${normalizedFilter} is not present in snapshot ${options.stamp}`
        : `Snapshot ${options.stamp} contains no restorable config files`,
    );
  }

  const requiresAppClosed = selectedEntries.some((f) => f.rel.startsWith('hermes/'));
  if (requiresAppClosed) {
    assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);
  }

  const items: LkgRollbackPlanItem[] = [];
  for (const entry of selectedEntries) {
    const destPath = resolveRestoreDestination(ctx, entry.rel);
    if (!destPath) {
      return failPlan('invalid-path', `Refused restore target ${entry.rel}`, requiresAppClosed);
    }

    const baseRoot = entry.rel.startsWith('hermes/') ? ctx.paths.hermesHome : ctx.paths.harnessDir;
    try {
      await assertNoSymlinkInRelativeChain(baseRoot, destPath);
    } catch (err) {
      return failPlan(
        'invalid-path',
        err instanceof Error ? err.message : String(err),
        requiresAppClosed,
      );
    }

    const snapFilePath = path.join(snapDir, 'files', entry.rel);
    try {
      const st = await fs.lstat(snapFilePath);
      if (st.isSymbolicLink() || !st.isFile()) {
        return failPlan(
          'integrity-error',
          `Snapshot file ${entry.rel} is missing or not a regular file`,
          requiresAppClosed,
        );
      }
      const buf = await fs.readFile(snapFilePath);
      const actualSha = sha256Hex(buf);
      if (buf.byteLength !== entry.bytes || actualSha !== entry.sha256) {
        return failPlan(
          'integrity-error',
          `Snapshot integrity error: ${entry.rel} sha256 mismatch (expected ${entry.sha256}, got ${actualSha})`,
          requiresAppClosed,
        );
      }
    } catch (err) {
      return failPlan(
        'integrity-error',
        `Could not verify snapshot file ${entry.rel}: ${err instanceof Error ? err.message : String(err)}`,
        requiresAppClosed,
      );
    }

    let wouldMoveAside = false;
    try {
      await fs.lstat(destPath);
      wouldMoveAside = true;
    } catch {
      wouldMoveAside = false;
    }

    items.push({
      rel: entry.rel,
      destPath,
      snapshotFilePath: snapFilePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
      wouldMoveAside,
    });
  }

  if (requiresAppClosed && (await isAppRunning(ctx))) {
    return {
      ok: false,
      stamp: options.stamp,
      requiresAppClosed: true,
      items,
      refusedReason: 'app-running',
      error:
        'Refused to restore hermes/config.yaml while Cindy desktop app is running. Close Cindy first and retry.',
    };
  }

  return {
    ok: true,
    stamp: options.stamp,
    requiresAppClosed,
    items,
  };
}

async function writeFileAtomically(destPath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(destPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(destPath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function rollbackLkgSnapshot(
  ctx: DoctorContext,
  options: RollbackLkgOptions,
): Promise<RollbackLkgResult> {
  const plan = await planLkgRollback(ctx, options);
  if (!plan.ok) {
    return {
      ok: false,
      stamp: options.stamp,
      restored: [],
      movedAside: [],
      refusedReason: plan.refusedReason,
      error: plan.error,
    };
  }

  const rollbackStamp = formatSnapshotStamp(ctx.now());
  const movedAside: string[] = [];
  const restored: string[] = [];

  for (const item of plan.items) {
    const buf = await fs.readFile(item.snapshotFilePath);
    if (buf.byteLength !== item.bytes || sha256Hex(buf) !== item.sha256) {
      return {
        ok: false,
        stamp: options.stamp,
        restored,
        movedAside,
        refusedReason: 'integrity-error',
        error: `Snapshot file ${item.rel} changed during rollback verification`,
      };
    }

    let currentMovedAsideTo: string | null = null;
    try {
      const destDir = path.dirname(item.destPath);
      await fs.mkdir(destDir, { recursive: true });
      const stageTmpPath = path.join(
        destDir,
        `.${path.basename(item.destPath)}.stage-${process.pid}-${crypto.randomUUID()}`,
      );
      try {
        await fs.writeFile(stageTmpPath, buf);
        await fs.rm(stageTmpPath, { force: true });
      } catch (err) {
        await fs.rm(stageTmpPath, { force: true }).catch(() => {});
        throw err;
      }

      if (item.wouldMoveAside) {
        try {
          await fs.lstat(item.destPath);
          const asidePath = `${item.destPath}.pre-rollback-${rollbackStamp}`;
          await fs.rename(item.destPath, asidePath);
          currentMovedAsideTo = asidePath;
          movedAside.push(asidePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw err;
          }
        }
      }

      await writeFileAtomically(item.destPath, buf);
      restored.push(item.destPath);
    } catch (err) {
      if (currentMovedAsideTo) {
        await fs.rename(currentMovedAsideTo, item.destPath).catch(() => {});
        movedAside.pop();
      }
      throw err;
    }
  }

  if (options.skipRecheck) {
    return {
      ok: true,
      stamp: options.stamp,
      restored,
      movedAside,
    };
  }

  const packs = options.packs ?? [(await import('./packs/index.js')).configPack];
  const configReport = await runChecks(createRegistry(packs), { ...ctx, includeApi: false }, {
    only: ['config'],
  });

  return {
    ok: true,
    stamp: options.stamp,
    restored,
    movedAside,
    configReport,
  };
}
