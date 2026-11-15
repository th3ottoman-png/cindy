/**
 * Redacted local incident bundle generator (ROADMAP 14.9, blueprint §9, ADR 0015).
 *
 * Writes `~/.cindy-harness/doctor/bundles/<stamp>.md` strictly on the local disk
 * (never uploaded). Combines:
 *   1. Header for an AI agent pointing at `AGENTS.md` and `HANDOVER.md`
 *   2. Full `--all` diagnostic report
 *   3. `versions.json` snapshot
 *   4. §3 config files (through `redactConfig`) + `.env` key names only
 *   5. Last 200 lines of newest `apps/desktop/logs/main-*.log` and `agent.log` (redacted)
 *   6. Last 20 lines of `fix-log.jsonl` (redacted)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseHermesDotEnv } from '../agents/hermes/hermes-provider-env.js';
import { assertNotDailyHermes } from './context.js';
import { resolveFixLogPath } from './fix-runner.js';
import {
  redactConfig,
  redactText,
  SECRET_CONFIG_KEY_PATTERN,
  type RedactOptions,
} from './redact.js';
import { createRegistry } from './registry.js';
import { formatReportMarkdown } from './report-text.js';
import { runChecks } from './runner.js';
import {
  buildVersionsFromResults,
  collectConfigSnapshotCandidates,
  formatSnapshotStamp,
  type LkgSnapshotVersions,
} from './snapshots.js';
import type { DoctorContext, DoctorPack, DoctorReport, Severity } from './types.js';

const BUNDLE_LOG_TAIL_LINES = 200;
const BUNDLE_LOG_MAX_READ_BYTES = 512 * 1024;
const FIX_LOG_TAIL_LINES = 20;
const MAX_CONFIG_FILE_BYTES = 512 * 1024;
const TRIVIAL_LITERAL_VALUES = new Set(['true', 'false', 'null', 'none', 'undefined']);

export interface EnvKeyInventory {
  displayPath: string;
  keys: string[];
}

export interface CreateIncidentBundleOptions {
  /** Pre-computed report (skips running `--all` checks when supplied by tests). */
  report?: DoctorReport;
  /** Optional pack override (defaults to `ALL_PACKS`). */
  packs?: readonly DoctorPack[];
  /** Include remote/API checks (defaults to `ctx.includeApi ?? false`). */
  includeApi?: boolean;
}

export interface IncidentBundleResult {
  stamp: string;
  path: string;
  displayPath: string;
  createdAt: string;
  markdown: string;
  bytes: number;
  reportCounts: Record<Severity, number>;
  configCount: number;
  envKeyCount: number;
}

export function resolveBundlesRootDir(ctx: DoctorContext): string {
  return path.join(ctx.paths.harnessDir, 'doctor', 'bundles');
}

function chooseFence(content: string): string {
  let maxRun = 2;
  const matches = content.match(/`{3,}/g);
  if (matches) {
    for (const m of matches) {
      if (m.length > maxRun) maxRun = m.length;
    }
  }
  return '`'.repeat(maxRun + 1);
}

function inferFenceLang(relPath: string): string {
  if (relPath.endsWith('.json')) return 'json';
  if (relPath.endsWith('.yaml') || relPath.endsWith('.yml')) return 'yaml';
  if (relPath.endsWith('.md')) return 'markdown';
  return 'text';
}

const YAML_BLOCK_SCALAR_HEADER = /^[|>](?:[+-]|[1-9][+-]?|[+-][1-9])?(?:\s+#.*)?$/;

function stripSurroundingQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function addSecretIfSensitive(bucket: Set<string>, rawValue: string, forceInclude: boolean): void {
  const trimmed = stripSurroundingQuotes(rawValue);
  if (trimmed.length < 4) return;
  if (TRIVIAL_LITERAL_VALUES.has(trimmed.toLowerCase())) return;
  if (!forceInclude && trimmed.length < 6) return;
  bucket.add(trimmed);
}

function harvestJsonObjectSecrets(value: unknown, bucket: Set<string>, underSecretKey = false): void {
  if (typeof value === 'string') {
    if (underSecretKey) addSecretIfSensitive(bucket, value, true);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      harvestJsonObjectSecrets(item, bucket, underSecretKey);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      harvestJsonObjectSecrets(v, bucket, underSecretKey || SECRET_CONFIG_KEY_PATTERN.test(k));
    }
  }
}

function harvestConfigSecretValues(rawText: string, bucket: Set<string>): void {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    harvestJsonObjectSecrets(parsed, bucket, false);
  } catch {
    // Not pure JSON; continue with line-based YAML/JSON harvesting below.
  }

  let secretBlockIndent: number | null = null;
  for (const line of rawText.split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const indentMatch = line.match(/^(\s*)/);
    const indentWidth = indentMatch ? indentMatch[1]!.length : 0;
    const trimmed = line.trim();

    if (secretBlockIndent !== null) {
      const stillInBlock =
        indentWidth > secretBlockIndent ||
        (indentWidth === secretBlockIndent && trimmed.startsWith('-'));
      if (!stillInBlock) {
        secretBlockIndent = null;
      } else {
        const kv = trimmed.match(/^(?:-\s+)?['"]?[A-Za-z0-9_.-]+['"]?\s*:\s*(.+)$/);
        if (kv) {
          const val = kv[1]!.replace(/,\s*$/, '').trim();
          if (val && !YAML_BLOCK_SCALAR_HEADER.test(val) && val !== '{' && val !== '[') {
            addSecretIfSensitive(bucket, val, true);
          }
        } else if (trimmed.startsWith('-')) {
          addSecretIfSensitive(bucket, trimmed.replace(/^-\s*/, ''), true);
        } else {
          addSecretIfSensitive(bucket, trimmed, true);
        }
        continue;
      }
    }

    const kvMatch = line.match(/^(\s*(?:-\s+)?)(['"]?)([A-Za-z0-9_.-]+)\2\s*:\s*(.*)$/);
    if (kvMatch) {
      const [, indent, , key, rawRest] = kvMatch;
      const cleanRest = rawRest.replace(/,\s*$/, '').trim();
      const isBlockHeader =
        cleanRest.length === 0 ||
        cleanRest.startsWith('#') ||
        YAML_BLOCK_SCALAR_HEADER.test(cleanRest) ||
        cleanRest === '{' ||
        cleanRest === '[';
      if (SECRET_CONFIG_KEY_PATTERN.test(key!)) {
        if (isBlockHeader) {
          secretBlockIndent = indent!.length;
        } else if (cleanRest !== '{}' && cleanRest !== '[]') {
          addSecretIfSensitive(bucket, cleanRest, true);
        }
      }
    }
  }
}

async function collectRedactionSecretsAndEnvKeys(ctx: DoctorContext): Promise<{
  redactOpts: RedactOptions;
  envInventories: EnvKeyInventory[];
}> {
  const knownSecrets = new Set<string>();
  const envInventories: EnvKeyInventory[] = [];

  // Harvest secret-shaped variables from process/context env so values never leak in logs.
  for (const [key, val] of Object.entries(ctx.env ?? {})) {
    if (typeof val === 'string' && SECRET_CONFIG_KEY_PATTERN.test(key)) {
      addSecretIfSensitive(knownSecrets, val, true);
    }
  }

  const candidateDotEnvPaths = [
    path.join(ctx.paths.hermesHome, '.env'),
    path.join(ctx.paths.harnessDir, '.env'),
  ];

  for (const envPath of candidateDotEnvPaths) {
    let raw: string;
    try {
      const st = await fs.lstat(envPath);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      raw = await ctx.fs.readFile(envPath, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseHermesDotEnv(raw);
    const keySet = new Set<string>();
    for (const [rawKey, val] of Object.entries(parsed)) {
      const key = rawKey.replace(/^export\s+/, '').trim();
      if (!key) continue;
      keySet.add(key);
      addSecretIfSensitive(knownSecrets, val, true);
    }

    // Also include raw RHS tokens in case quotes or formatting variations appear verbatim in logs.
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const rawRhs = trimmed.slice(eq + 1).trim();
      addSecretIfSensitive(knownSecrets, rawRhs, true);
    }

    const displayPath = redactText(envPath, { homeDir: ctx.paths.home });
    envInventories.push({
      displayPath,
      keys: [...keySet].sort((a, b) => a.localeCompare(b)),
    });
  }

  // Also harvest secret-keyed scalar values from §3 config files so config-only secrets never leak in logs.
  try {
    const configCandidates = await collectConfigSnapshotCandidates(ctx);
    for (const item of configCandidates) {
      try {
        const st = await fs.lstat(item.absPath);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        const rawConfig = await ctx.fs.readFile(item.absPath, 'utf8');
        harvestConfigSecretValues(rawConfig, knownSecrets);
      } catch {
        // Ignore unreadable config files during secret harvesting
      }
    }
  } catch {
    // Ignore candidate enumeration errors
  }

  return {
    redactOpts: {
      homeDir: ctx.paths.home,
      knownSecrets: [...knownSecrets],
    },
    envInventories,
  };
}

async function readTailLinesSafe(
  ctx: DoctorContext,
  filePath: string,
  maxLines: number,
): Promise<{ exists: boolean; lines: string[]; truncatedByBytes: boolean }> {
  let size: number;
  try {
    const st = await fs.lstat(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { exists: false, lines: [], truncatedByBytes: false };
    }
    size = st.size;
  } catch {
    return { exists: false, lines: [], truncatedByBytes: false };
  }

  let content: string;
  let truncatedByBytes = false;
  if (size <= BUNDLE_LOG_MAX_READ_BYTES) {
    content = await ctx.fs.readFile(filePath, 'utf8');
  } else {
    truncatedByBytes = true;
    const start = Math.max(0, size - BUNDLE_LOG_MAX_READ_BYTES);
    const len = size - start;
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      content = buf.toString('utf8');
      // Drop potentially split first line when seeking mid-file.
      const firstNewline = content.indexOf('\n');
      if (start > 0 && firstNewline >= 0) {
        content = content.slice(firstNewline + 1);
      }
    } finally {
      await handle.close();
    }
  }

  const allLines = content.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  return {
    exists: true,
    lines: allLines.slice(-maxLines),
    truncatedByBytes,
  };
}

async function findNewestMainDesktopLog(repoRoot: string): Promise<string | null> {
  const logsDir = path.join(repoRoot, 'apps', 'desktop', 'logs');
  let names: string[];
  try {
    names = await fs.readdir(logsDir);
  } catch {
    return null;
  }

  let newestPath: string | null = null;
  let newestName = '';
  let newestMtime = -1;

  for (const name of names) {
    if (!/^main-.*\.log$/.test(name)) continue;
    const candidate = path.join(logsDir, name);
    try {
      const st = await fs.lstat(candidate);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (st.mtimeMs > newestMtime || (st.mtimeMs === newestMtime && name > newestName)) {
        newestMtime = st.mtimeMs;
        newestName = name;
        newestPath = candidate;
      }
    } catch {
      // Ignore vanishing files
    }
  }

  return newestPath;
}

async function resolveUniqueBundleStamp(
  bundlesRoot: string,
  baseDate: Date,
): Promise<{ stamp: string; createdAt: string }> {
  const ms = baseDate.getTime();
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const d = new Date(ms + attempt);
    const stamp = formatSnapshotStamp(d);
    const targetPath = path.join(bundlesRoot, `${stamp}.md`);
    try {
      await fs.lstat(targetPath);
    } catch {
      return { stamp, createdAt: d.toISOString() };
    }
  }
  throw new Error('Could not allocate unique incident bundle stamp after 1000 attempts');
}

async function writeFileAtomically(destPath: string, content: string): Promise<void> {
  const dir = path.dirname(destPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${path.basename(destPath)}-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

function renderRedactedConfigContent(
  rel: string,
  rawText: string,
  redactOpts: RedactOptions,
): string {
  const truncated =
    rawText.length > MAX_CONFIG_FILE_BYTES
      ? `${rawText.slice(0, MAX_CONFIG_FILE_BYTES)}\n... [truncated after ${MAX_CONFIG_FILE_BYTES} chars]`
      : rawText;

  if (rel.endsWith('.json')) {
    try {
      const parsed = JSON.parse(truncated) as unknown;
      const redactedObj = redactConfig(parsed, redactOpts);
      return JSON.stringify(redactedObj, null, 2);
    } catch {
      // Malformed JSON: fall back to text-line redaction so diagnostics remain visible safely.
    }
  }

  return redactConfig(truncated, redactOpts);
}

/**
 * Assemble and write a redacted local incident bundle (`~/.cindy-harness/doctor/bundles/<stamp>.md`).
 */
export async function createIncidentBundle(
  ctx: DoctorContext,
  options: CreateIncidentBundleOptions = {},
): Promise<IncidentBundleResult> {
  assertNotDailyHermes(ctx.paths.hermesHome, ctx.paths.home);

  const effectiveCtx: DoctorContext =
    options.includeApi !== undefined ? { ...ctx, includeApi: options.includeApi } : ctx;

  const { redactOpts, envInventories } = await collectRedactionSecretsAndEnvKeys(effectiveCtx);

  const packs = options.packs ?? (await import('./packs/index.js')).ALL_PACKS;
  const report =
    options.report ??
    (await runChecks(createRegistry(packs), effectiveCtx));

  const bundlesRoot = resolveBundlesRootDir(effectiveCtx);
  await fs.mkdir(bundlesRoot, { recursive: true });

  const { stamp, createdAt } = await resolveUniqueBundleStamp(bundlesRoot, effectiveCtx.now());
  const finalPath = path.join(bundlesRoot, `${stamp}.md`);
  const displayPath = redactText(finalPath, redactOpts);
  const displayRepoRoot = redactText(effectiveCtx.paths.repoRoot, redactOpts);

  // 3. versions.json
  const versionsRaw: LkgSnapshotVersions = buildVersionsFromResults(
    effectiveCtx,
    createdAt,
    report.results,
  );
  const versionsRedacted = redactConfig(versionsRaw, redactOpts);
  const versionsJson = JSON.stringify(versionsRedacted, null, 2);

  // 4. §3 config files (redacted)
  const candidates = await collectConfigSnapshotCandidates(effectiveCtx);
  const configSections: string[] = [];
  for (const item of candidates) {
    try {
      const st = await fs.lstat(item.absPath);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const rawText = await effectiveCtx.fs.readFile(item.absPath, 'utf8');
      const redactedBody = renderRedactedConfigContent(item.rel, rawText, redactOpts);
      const lang = inferFenceLang(item.rel);
      const fence = chooseFence(redactedBody);
      const displayFile = redactText(item.absPath, redactOpts);
      configSections.push(
        `### \`${item.rel}\` (${displayFile})\n\n${fence}${lang}\n${redactedBody.trimEnd()}\n${fence}`,
      );
    } catch (err) {
      const msg = redactText(err instanceof Error ? err.message : String(err), redactOpts);
      configSections.push(`### \`${item.rel}\`\n\n- Unable to read file: ${msg}`);
    }
  }

  // 5. Log tails (last 200 lines)
  const newestMainLog = await findNewestMainDesktopLog(effectiveCtx.paths.repoRoot);
  const mainLogDisplay = newestMainLog
    ? redactText(newestMainLog, redactOpts)
    : '~/.../apps/desktop/logs/main-*.log';
  const mainTail = newestMainLog
    ? await readTailLinesSafe(effectiveCtx, newestMainLog, BUNDLE_LOG_TAIL_LINES)
    : { exists: false, lines: [] as string[], truncatedByBytes: false };

  const agentLogPath = path.join(effectiveCtx.paths.hermesHome, 'logs', 'agent.log');
  const agentLogDisplay = redactText(agentLogPath, redactOpts);
  const agentTail = await readTailLinesSafe(effectiveCtx, agentLogPath, BUNDLE_LOG_TAIL_LINES);

  // 6. fix-log.jsonl (last 20 lines)
  const fixLogPath = resolveFixLogPath(effectiveCtx);
  const fixLogDisplay = redactText(fixLogPath, redactOpts);
  const fixTail = await readTailLinesSafe(effectiveCtx, fixLogPath, FIX_LOG_TAIL_LINES);

  const rawReportMd = formatReportMarkdown(report, { title: 'Diagnostic Report (--all)' });
  // Demote `#` inside embedded report markdown so H1 stays strictly on the bundle title.
  const nestedReportMd = redactText(rawReportMd, redactOpts).replace(/^(#{1,4}) /gm, '#$1 ');

  const lines: string[] = [
    '# Cindy Doctor Incident Bundle',
    '',
    '> **Agent Instructions:** Cindy is a local-first desktop AI workspace (Electron + TypeScript monorepo) wrapping **Hermes Agent** (isolated `HERMES_HOME` at `~/.hermes-cindy`), local/API LLM providers (`~/.cindy-harness/`), and runtime CLIs (`claude`, `codex`, `pi`). **Read `AGENTS.md` and `HANDOVER.md` in the repository root first** before proposing fixes or running commands. Always keep Hermes operations strictly isolated inside `~/.hermes-cindy` via `hermes-cindy`. This bundle is stored strictly locally on disk and is never uploaded.',
    '',
    `- **Generated:** ${createdAt}`,
    `- **Bundle file:** \`${displayPath}\``,
    `- **Repository root:** \`${displayRepoRoot}\``,
    `- **API probes included:** ${Boolean(effectiveCtx.includeApi)}`,
    '',
    nestedReportMd.trimEnd(),
    '',
    '## Versions (`versions.json`)',
    '',
    '```json',
    versionsJson,
    '```',
    '',
    '## Configs (§3, redacted)',
    '',
  ];

  if (envInventories.length > 0) {
    lines.push('### Environment files (key names only, values omitted)', '');
    for (const inv of envInventories) {
      const keyList = inv.keys.length > 0 ? inv.keys.map((k) => `\`${k}\``).join(', ') : '(empty)';
      lines.push(`- \`${inv.displayPath}\`: ${keyList}`);
    }
    lines.push('');
  } else {
    lines.push('### Environment files (key names only, values omitted)', '', '- `(none found)`', '');
  }

  if (configSections.length > 0) {
    lines.push(...configSections, '');
  } else {
    lines.push('_(no §3 config files found)_', '');
  }

  lines.push('## Logs (last 200 lines each, redacted)', '');

  const mainText = redactText(mainTail.lines.join('\n'), redactOpts);
  const mainFence = chooseFence(mainText);
  lines.push(`### Desktop main log (\`${mainLogDisplay}\`)`, '');
  if (!mainTail.exists) {
    lines.push('_(not found)_', '');
  } else if (mainTail.lines.length === 0) {
    lines.push('_(empty)_', '');
  } else {
    lines.push(`${mainFence}log`, mainText, mainFence, '');
  }

  const agentText = redactText(agentTail.lines.join('\n'), redactOpts);
  const agentFence = chooseFence(agentText);
  lines.push(`### Hermes agent log (\`${agentLogDisplay}\`)`, '');
  if (!agentTail.exists) {
    lines.push('_(not found)_', '');
  } else if (agentTail.lines.length === 0) {
    lines.push('_(empty)_', '');
  } else {
    lines.push(`${agentFence}log`, agentText, agentFence, '');
  }

  const nonEmptyFixLines = fixTail.lines.filter((l) => l.trim().length > 0).slice(-FIX_LOG_TAIL_LINES);
  const fixText = redactText(nonEmptyFixLines.join('\n'), redactOpts);
  const fixFence = chooseFence(fixText);
  lines.push(`## Fix log (last ${FIX_LOG_TAIL_LINES} lines, \`${fixLogDisplay}\`)`, '');
  if (!fixTail.exists || nonEmptyFixLines.length === 0) {
    lines.push('_(no fix log entries)_', '');
  } else {
    lines.push(`${fixFence}jsonl`, fixText, fixFence, '');
  }

  // Final defense-in-depth pass across the complete document.
  const finalMarkdown = `${redactText(lines.join('\n').trimEnd(), redactOpts)}\n`;
  await writeFileAtomically(finalPath, finalMarkdown);

  return {
    stamp,
    path: finalPath,
    displayPath,
    createdAt,
    markdown: finalMarkdown,
    bytes: Buffer.byteLength(finalMarkdown, 'utf8'),
    reportCounts: { ...report.counts },
    configCount: configSections.length,
    envKeyCount: envInventories.reduce((sum, item) => sum + item.keys.length, 0),
  };
}
