/**
 * Config doctor pack (`config.*`, ROADMAP 14.3, blueprint §3 & §11).
 *
 * Validates YAML, JSON, schemas, and cross-references across `~/.cindy-harness/`
 * and `~/.hermes-cindy/` using the existing readers. All checks are strictly read-only.
 */

import * as crypto from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';

import {
  parseHermesCustomProviders,
  parseHermesDefaultRoute,
  parseHermesFallbackModel,
  parseHermesMcpServers,
} from '../../agents/hermes/hermes-config-parsers.js';
import { parseHermesDotEnv } from '../../agents/hermes/hermes-provider-env.js';
import { parseWebBudgetYaml } from '../../agents/hermes/web-budget-yaml.js';
import { parseExpertMarkdown } from '../../experts/expert-loader.js';
import { parseExpertToolsYaml } from '../../experts/expert-tools.js';
import { buildMcpCatalog, type McpCatalogEntry, type McpCatalogSource, type McpServerConfig } from '../../mcp/mcp-catalog.js';
import { parseProvidersYaml } from '../../providers/providers-file.js';
import { parseRoutingYaml } from '../../providers/routing-file.js';
import {
  parseGuardrailsYaml,
  type GuardrailCategory,
} from '../../security/guardrails-yaml.js';
import { isDailyHermesPath } from '../context.js';
import { redactText } from '../redact.js';
import { createRegistry } from '../registry.js';
import { runChecks } from '../runner.js';
import {
  diffAgainstLatestLkg,
  FIXED_SMALL_JSON_FILES,
  listLkgSnapshots,
  resolveRestoreDestination,
  rollbackLkgSnapshot,
} from '../snapshots.js';
import type {
  CheckRunOutput,
  DoctorCheck,
  DoctorContext,
  DoctorFix,
  DoctorFs,
  DoctorPack,
  FixOutcome,
  FixPlan,
} from '../types.js';

const LOCAL_PROVIDER_KINDS = new Set(['lmstudio', 'ollama']);

const GUARDRAIL_CATEGORIES = new Set<GuardrailCategory>([
  'filesystem',
  'git',
  'database',
  'credentials',
  'remote-exec',
  'system',
  'process',
]);

/** Built-in + plugin toolsets shipped by Hermes (`hermes-cindy tools list`, pinned 0.22.7/0.23.0). */
const KNOWN_HERMES_TOOLSETS = new Set<string>([
  'web',
  'browser',
  'terminal',
  'file',
  'code_execution',
  'vision',
  'video',
  'image_gen',
  'video_gen',
  'x_search',
  'tts',
  'stt',
  'skills',
  'todo',
  'kanban',
  'memory',
  'context_engine',
  'session_search',
  'connections',
  'clarify',
  'delegation',
  'cronjob',
  'yuanbao',
  'computer_use',
  'a2a',
]);

/** Known Cindy built-in MCP server IDs (matches desktop builtin plugins & bridge servers). */
export const KNOWN_BUILTIN_MCP_IDS: readonly string[] = [
  'cindy_android',
  'cindy_browser',
  'cindy_computer',
  'cindy_slack',
  'cindy_scheduler',
  'cindy_ssh',
  'cindy_memory',
  'cindy_contacts',
  'cindy_docs',
  'cindy_helper',
  'cindy_orca',
  'cindy_lsp',
  'cindy_project_reader',
  'cindy_vault_notes',
  'cindy_skills',
  'cindy_experts',
  'orca_worker_bridge',
];

type YamlParseResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; line: number; message: string };

/** Strictly parse a standalone YAML mapping using `gray-matter`'s js-yaml engine. */
function parseYamlStrict(text: string): YamlParseResult {
  try {
    const wrapped = `---\n${text}\n---\n`;
    const parsed = matter(wrapped, {});
    const data = parsed.data;
    if (data === null || data === undefined) {
      return { ok: true, data: {} };
    }
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, line: 1, message: 'expected a YAML mapping at top level' };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch (error) {
    const err = error as { mark?: { line?: number }; reason?: string; message?: string };
    // Because `---\n` occupies 0-based line 0 of `wrapped`, `err.mark.line` equals the
    // 1-based line number inside `text`.
    const rawLine = typeof err.mark?.line === 'number' ? err.mark.line : 1;
    const line = Math.max(1, rawLine);
    const message = err.reason ?? err.message ?? 'invalid YAML syntax';
    return { ok: false, line, message };
  }
}

/** Find the 1-based line number containing `needle`, falling back to `fallback`. */
function findLineNumber(text: string, needle: string, fallback = 1): number {
  if (!needle) return fallback;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(needle)) return i + 1;
  }
  return fallback;
}

/** Locate the most specific line for an issue with optional `where` and `message`. */
function findIssueLine(text: string, where: string, message: string): number {
  const quoted = /"([^"]+)"/.exec(message)?.[1];
  if (quoted) {
    const hit = findLineNumber(text, quoted, -1);
    if (hit !== -1) return hit;
  }
  const parts = where.split('.').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const hit = findLineNumber(text, parts[i]!, -1);
    if (hit !== -1) return hit;
  }
  return 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readOptionalFile(
  ctx: DoctorContext,
  filePath: string,
): Promise<{ exists: true; text: string } | { exists: false } | { exists: true; readError: string }> {
  try {
    const text = await ctx.fs.readFile(filePath, 'utf8');
    return { exists: true, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false };
    }
    return {
      exists: true,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Strict RFC 8259 JSON character scanner to locate the exact failing char index. */
function findJsonErrorCharIndex(raw: string): { index: number; reason: string } {
  const len = raw.length;
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;

  const skipWs = (): void => {
    while (i < len) {
      const c = raw.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        i += 1;
      } else {
        break;
      }
    }
  };

  const fail = (reason: string, at = i): { index: number; reason: string } => ({
    index: Math.max(0, Math.min(at, len)),
    reason,
  });

  const scanString = (): { index: number; reason: string } | null => {
    const start = i;
    i += 1;
    while (i < len) {
      const c = raw.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        return null;
      }
      if (c === 0x5c) {
        i += 1;
        if (i >= len) return fail('unterminated escape sequence in string', i);
        const esc = raw[i]!;
        if ('"\\/bfnrt'.includes(esc)) {
          i += 1;
        } else if (esc === 'u') {
          i += 1;
          for (let h = 0; h < 4; h++) {
            if (i >= len || !/[0-9a-fA-F]/.test(raw[i]!)) {
              return fail('invalid \\uXXXX escape in string', i);
            }
            i += 1;
          }
        } else {
          return fail(`invalid escape sequence "\\${esc}" in string`, i);
        }
        continue;
      }
      if (c < 0x20) {
        return fail('unescaped control character in string', i);
      }
      i += 1;
    }
    return fail('unterminated string literal', start);
  };

  const scanNumber = (): { index: number; reason: string } | null => {
    if (raw[i] === '-') {
      i += 1;
      if (i >= len) return fail('expected digit after "-"', i);
    }
    if (raw[i] === '0') {
      i += 1;
    } else if (i < len && raw[i]! >= '1' && raw[i]! <= '9') {
      while (i < len && raw[i]! >= '0' && raw[i]! <= '9') i += 1;
    } else {
      return fail('invalid number literal', i);
    }
    if (i < len && raw[i] === '.') {
      i += 1;
      if (i >= len || raw[i]! < '0' || raw[i]! > '9') return fail('expected digit after decimal point', i);
      while (i < len && raw[i]! >= '0' && raw[i]! <= '9') i += 1;
    }
    if (i < len && (raw[i] === 'e' || raw[i] === 'E')) {
      i += 1;
      if (i < len && (raw[i] === '+' || raw[i] === '-')) i += 1;
      if (i >= len || raw[i]! < '0' || raw[i]! > '9') return fail('expected digit in exponent', i);
      while (i < len && raw[i]! >= '0' && raw[i]! <= '9') i += 1;
    }
    return null;
  };

  const scanValue = (): { index: number; reason: string } | null => {
    skipWs();
    if (i >= len) return fail('unexpected end of JSON input', i);
    const ch = raw[i]!;
    if (ch === '{') {
      i += 1;
      skipWs();
      if (i < len && raw[i] === '}') {
        i += 1;
        return null;
      }
      while (true) {
        skipWs();
        if (i >= len) return fail('expected property name or "}" in object', i);
        if (raw[i] !== '"') return fail(`unexpected token "${raw[i]}" (expected property name string)`, i);
        const keyErr = scanString();
        if (keyErr) return keyErr;
        skipWs();
        if (i >= len || raw[i] !== ':') return fail('expected ":" after object key', i);
        i += 1;
        const valErr = scanValue();
        if (valErr) return valErr;
        skipWs();
        if (i >= len) return fail('expected "," or "}" in object', i);
        if (raw[i] === '}') {
          i += 1;
          return null;
        }
        if (raw[i] !== ',') return fail(`unexpected token "${raw[i]}" (expected "," or "}")`, i);
        i += 1;
      }
    }
    if (ch === '[') {
      i += 1;
      skipWs();
      if (i < len && raw[i] === ']') {
        i += 1;
        return null;
      }
      while (true) {
        const elemErr = scanValue();
        if (elemErr) return elemErr;
        skipWs();
        if (i >= len) return fail('expected "," or "]" in array', i);
        if (raw[i] === ']') {
          i += 1;
          return null;
        }
        if (raw[i] !== ',') return fail(`unexpected token "${raw[i]}" (expected "," or "]")`, i);
        i += 1;
      }
    }
    if (ch === '"') return scanString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return scanNumber();
    if (raw.startsWith('true', i)) {
      i += 4;
      return null;
    }
    if (raw.startsWith('false', i)) {
      i += 5;
      return null;
    }
    if (raw.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return fail(`unexpected token "${ch}"`, i);
  };

  const err = scanValue();
  if (err) return err;
  skipWs();
  if (i < len) {
    return fail(`unexpected trailing token "${raw[i]}" after JSON value`, i);
  }
  return fail('invalid JSON syntax', i);
}

function parseJsonWithByteOffset(
  raw: string,
): { ok: true; value: unknown } | { ok: false; byteOffset: number; message: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const posMatch = /\bat position (\d+)\b/.exec(errMsg);
    if (posMatch) {
      const charIdx = Number(posMatch[1]);
      if (Number.isFinite(charIdx) && charIdx >= 0) {
        return {
          ok: false,
          byteOffset: Buffer.byteLength(raw.slice(0, charIdx), 'utf8'),
          message: errMsg,
        };
      }
    }
    const scanned = findJsonErrorCharIndex(raw);
    return {
      ok: false,
      byteOffset: Buffer.byteLength(raw.slice(0, scanned.index), 'utf8'),
      message: scanned.reason,
    };
  }
}

function envValue(ctx: DoctorContext, name: string): string | undefined {
  const raw = ctx.env?.[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

async function readHermesDotEnvKeys(ctx: DoctorContext): Promise<Set<string>> {
  if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    return new Set();
  }
  const envFile = path.join(ctx.paths.hermesHome, '.env');
  const read = await readOptionalFile(ctx, envFile);
  if (!read.exists || 'readError' in read) return new Set();
  return new Set(Object.keys(parseHermesDotEnv(read.text)));
}

async function readKnownProviders(
  ctx: DoctorContext,
): Promise<{ ids: Set<string>; localIds: Set<string>; available: boolean }> {
  const ids = new Set<string>();
  const localIds = new Set<string>();
  const read = await readOptionalFile(ctx, path.join(ctx.paths.harnessDir, 'providers.yaml'));
  if (!read.exists || 'readError' in read || !parseYamlStrict(read.text).ok) {
    return { ids, localIds, available: false };
  }
  const parsed = parseProvidersYaml(read.text);
  for (const prov of parsed.providers) {
    ids.add(prov.id);
    if (LOCAL_PROVIDER_KINDS.has(prov.kind)) localIds.add(prov.id);
  }
  return { ids, localIds, available: true };
}

async function runConfigProviders(ctx: DoctorContext): Promise<CheckRunOutput> {
  const filePath = path.join(ctx.paths.harnessDir, 'providers.yaml');
  const read = await readOptionalFile(ctx, filePath);
  if (!read.exists) {
    return { severity: 'ok', summary: 'providers.yaml is not configured (optional)' };
  }
  if ('readError' in read) {
    return {
      severity: 'fail',
      summary: `Could not read providers.yaml: ${read.readError}`,
      action: 'Check permissions on ~/.cindy-harness/providers.yaml.',
    };
  }

  const yaml = parseYamlStrict(read.text);
  if (!yaml.ok) {
    return {
      severity: 'fail',
      summary: `providers.yaml (line ${yaml.line}): ${yaml.message}`,
      detail: `File: ${filePath}\nLine ${yaml.line}: ${yaml.message}`,
      action: `Fix the YAML syntax error in ${filePath} at line ${yaml.line}.`,
    };
  }

  const parsed = parseProvidersYaml(read.text);
  if (parsed.issues.length > 0) {
    const lines = parsed.issues.map((issue) => {
      const entryName = issue.entry ?? '';
      const line = findIssueLine(read.text, entryName, issue.message);
      const label = entryName ? `provider "${entryName}"` : 'entry';
      return `providers.yaml (line ${line}): ${label}: ${issue.message}`;
    });
    return {
      severity: 'fail',
      summary: lines[0]!,
      detail: lines.join('\n'),
      action: 'Fix the invalid fields in ~/.cindy-harness/providers.yaml.',
    };
  }

  const dotEnvKeys = await readHermesDotEnvKeys(ctx);
  const missingKeyEnvs: Array<{ providerId: string; keyEnv: string; line: number }> = [];
  for (const p of parsed.providers) {
    if (!p.keyEnv) continue;
    if (!envValue(ctx, p.keyEnv) && !dotEnvKeys.has(p.keyEnv)) {
      missingKeyEnvs.push({
        providerId: p.id,
        keyEnv: p.keyEnv,
        line: findLineNumber(read.text, p.keyEnv),
      });
    }
  }

  if (missingKeyEnvs.length > 0) {
    const names = [...new Set(missingKeyEnvs.map((m) => m.keyEnv))];
    const detail = missingKeyEnvs
      .map(
        (m) =>
          `providers.yaml (line ${m.line}): provider "${m.providerId}" expects env var ${m.keyEnv}, which is not set in env or ~/.hermes-cindy/.env`,
      )
      .join('\n');
    return {
      severity: 'warn',
      summary: `Missing keyEnv variable(s) for provider(s): ${names.join(', ')}`,
      detail,
      action: `Export ${names.join(', ')} in your environment or add the key name(s) in Cindy provider settings.`,
      evidence: { missingKeyEnvNames: names.join(', ') },
    };
  }

  return {
    severity: 'ok',
    summary: `providers.yaml valid (${parsed.providers.length} provider(s))`,
    evidence: { providerCount: parsed.providers.length },
  };
}

async function runConfigRouting(ctx: DoctorContext): Promise<CheckRunOutput> {
  const routingPath = path.join(ctx.paths.harnessDir, 'routing.yaml');
  const routingRead = await readOptionalFile(ctx, routingPath);
  if (!routingRead.exists) {
    return { severity: 'ok', summary: 'routing.yaml is not configured (optional)' };
  }
  if ('readError' in routingRead) {
    return {
      severity: 'fail',
      summary: `Could not read routing.yaml: ${routingRead.readError}`,
      action: 'Check permissions on ~/.cindy-harness/routing.yaml.',
    };
  }

  const yaml = parseYamlStrict(routingRead.text);
  if (!yaml.ok) {
    return {
      severity: 'fail',
      summary: `routing.yaml (line ${yaml.line}): ${yaml.message}`,
      detail: `File: ${routingPath}\nLine ${yaml.line}: ${yaml.message}`,
      action: `Fix the YAML syntax error in ${routingPath} at line ${yaml.line}.`,
    };
  }

  const { ids: knownProviders, available: providersAvailable } = await readKnownProviders(ctx);
  const parsedRouting = parseRoutingYaml(routingRead.text, knownProviders);
  const errors: string[] = [];

  for (const issue of parsedRouting.issues) {
    const line = findIssueLine(routingRead.text, issue.where, issue.message);
    errors.push(`routing.yaml (line ${line}): ${issue.where}: ${issue.message}`);
  }

  const routeNames = new Set(Object.keys(parsedRouting.routes));

  // Validate optional `council:` block references when present.
  const rawCouncil = yaml.data.council;
  if (rawCouncil !== undefined) {
    if (!isPlainObject(rawCouncil)) {
      const line = findLineNumber(routingRead.text, 'council');
      errors.push(`routing.yaml (line ${line}): council block must be a YAML mapping`);
    } else if (Array.isArray(rawCouncil.reviewers)) {
      for (let idx = 0; idx < rawCouncil.reviewers.length; idx++) {
        const rev = rawCouncil.reviewers[idx];
        if (!isPlainObject(rev)) continue;
        if (
          typeof rev.provider === 'string' &&
          rev.provider.trim() &&
          providersAvailable &&
          !knownProviders.has(rev.provider.trim())
        ) {
          const prov = rev.provider.trim();
          const line = findLineNumber(routingRead.text, prov);
          errors.push(`routing.yaml (line ${line}): council reviewer #${idx + 1} references unknown provider "${prov}"`);
        }
        if (typeof rev.route === 'string' && rev.route.trim() && !routeNames.has(rev.route.trim())) {
          const rt = rev.route.trim();
          const line = findLineNumber(routingRead.text, rt);
          errors.push(`routing.yaml (line ${line}): council reviewer #${idx + 1} references unknown route "${rt}"`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return {
      severity: 'fail',
      summary: errors[0]!,
      detail: errors.join('\n'),
      action: 'Update ~/.cindy-harness/routing.yaml so every provider and route name exists.',
    };
  }

  return {
    severity: 'ok',
    summary: `routing.yaml valid (${routeNames.size} route(s), ${Object.keys(parsedRouting.rules).length} rule(s))`,
    evidence: {
      routeCount: routeNames.size,
      ruleCount: Object.keys(parsedRouting.rules).length,
      workerAllowedRoutes: parsedRouting.workers?.allowedRoutes.length ?? 0,
    },
  };
}

async function runConfigExperts(ctx: DoctorContext): Promise<CheckRunOutput> {
  const expertsDir = path.join(ctx.paths.harnessDir, 'experts');
  let entries: string[];
  try {
    entries = await ctx.fs.readdir(expertsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { severity: 'ok', summary: 'experts directory is not configured (optional)' };
    }
    return {
      severity: 'fail',
      summary: `Could not read experts directory: ${error instanceof Error ? error.message : String(error)}`,
      action: 'Check permissions on ~/.cindy-harness/experts.',
    };
  }

  const slugs: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.') || name.includes('.bak')) continue;
    try {
      const st = await ctx.fs.stat(path.join(expertsDir, name));
      if (st.isDirectory()) slugs.push(name);
    } catch {
      /* ignore unreadable entries during enumeration */
    }
  }

  if (slugs.length === 0) {
    return { severity: 'ok', summary: 'experts directory has no experts (not configured)' };
  }

  // Load routing table for expert `model:` route cross-checks.
  const { ids: knownProviders } = await readKnownProviders(ctx);
  const knownRoutes = new Set<string>();
  let hasRouting = false;
  const routingRead = await readOptionalFile(ctx, path.join(ctx.paths.harnessDir, 'routing.yaml'));
  if (routingRead.exists && !('readError' in routingRead)) {
    const routingYaml = parseYamlStrict(routingRead.text);
    if (routingYaml.ok) {
      const parsedRouting = parseRoutingYaml(routingRead.text, knownProviders);
      for (const r of Object.keys(parsedRouting.routes)) knownRoutes.add(r);
      if (isPlainObject(routingYaml.data.routes)) {
        for (const r of Object.keys(routingYaml.data.routes)) knownRoutes.add(r);
      }
      hasRouting = true;
    }
  }

  // Build MCP catalog from known Cindy built-ins + Hermes config.yaml bridges/servers.
  const { entries: mcpEntries } = await loadDoctorMcpCatalog(ctx);
  const knownMcpIds = new Set(mcpEntries.map((entry) => entry.name));

  const errors: string[] = [];
  for (const slug of slugs) {
    const dir = path.join(expertsDir, slug);
    const expertFile = path.join(dir, 'expert.md');
    const expertRead = await readOptionalFile(ctx, expertFile);
    if (!expertRead.exists) {
      errors.push(`experts/${slug}/expert.md (line 1): expert.md is missing`);
      continue;
    }
    if ('readError' in expertRead) {
      errors.push(`experts/${slug}/expert.md (line 1): could not read (${expertRead.readError})`);
      continue;
    }

    let frontmatterData: Record<string, unknown> = {};
    try {
      const fm = matter(expertRead.text, {});
      frontmatterData = isPlainObject(fm.data) ? fm.data : {};
    } catch (error) {
      const err = error as { mark?: { line?: number }; reason?: string; message?: string };
      const line = Math.max(1, (typeof err.mark?.line === 'number' ? err.mark.line : 0) + 1);
      errors.push(
        `experts/${slug}/expert.md (line ${line}): ${err.reason ?? err.message ?? 'invalid frontmatter YAML'}`,
      );
      continue;
    }

    try {
      const def = parseExpertMarkdown(expertRead.text, { slug, dir });
      if (def.model && (!hasRouting || !knownRoutes.has(def.model))) {
        const line = findLineNumber(expertRead.text, def.model, findLineNumber(expertRead.text, 'model:'));
        errors.push(
          `experts/${slug}/expert.md (line ${line}): model route "${def.model}" does not exist in routing.yaml`,
        );
      }
      if (def.toolsets) {
        for (const toolset of def.toolsets) {
          if (!KNOWN_HERMES_TOOLSETS.has(toolset)) {
            const line = findLineNumber(expertRead.text, toolset, findLineNumber(expertRead.text, 'toolsets:'));
            errors.push(`experts/${slug}/expert.md (line ${line}): unknown toolset "${toolset}"`);
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const token = /"([a-z_]+)"/.exec(msg)?.[1] ?? Object.keys(frontmatterData)[0] ?? '';
      const line = findLineNumber(expertRead.text, token);
      errors.push(`experts/${slug}/expert.md (line ${line}): ${msg}`);
    }

    const toolsFile = path.join(dir, 'tools.yaml');
    const toolsRead = await readOptionalFile(ctx, toolsFile);
    if (toolsRead.exists) {
      if ('readError' in toolsRead) {
        errors.push(`experts/${slug}/tools.yaml (line 1): could not read (${toolsRead.readError})`);
      } else {
        const toolsYaml = parseYamlStrict(toolsRead.text);
        if (!toolsYaml.ok) {
          errors.push(`experts/${slug}/tools.yaml (line ${toolsYaml.line}): ${toolsYaml.message}`);
        } else {
          const parsedTools = parseExpertToolsYaml(toolsRead.text);
          for (const issue of parsedTools.issues) {
            const line = findIssueLine(toolsRead.text, issue.where, issue.message);
            errors.push(`experts/${slug}/tools.yaml (line ${line}): ${issue.where}: ${issue.message}`);
          }
          for (const mcpName of parsedTools.policy.mcpServers?.allow ?? []) {
            if (!knownMcpIds.has(mcpName)) {
              const line = findLineNumber(toolsRead.text, mcpName, findLineNumber(toolsRead.text, 'allow:'));
              errors.push(
                `experts/${slug}/tools.yaml (line ${line}): unknown MCP server "${mcpName}" in mcp_servers.allow`,
              );
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return {
      severity: 'fail',
      summary: errors[0]!,
      detail: errors.join('\n'),
      action: 'Fix the invalid frontmatter, toolsets, routes, or MCP server names in ~/.cindy-harness/experts/.',
    };
  }

  return {
    severity: 'ok',
    summary: `Validated ${slugs.length} expert(s) in ~/.cindy-harness/experts`,
    evidence: { expertCount: slugs.length },
  };
}

async function runConfigGuardrails(ctx: DoctorContext): Promise<CheckRunOutput> {
  const filePath = path.join(ctx.paths.harnessDir, 'guardrails.yaml');
  const read = await readOptionalFile(ctx, filePath);
  if (!read.exists) {
    return { severity: 'ok', summary: 'guardrails.yaml is not configured (optional)' };
  }
  if ('readError' in read) {
    return {
      severity: 'fail',
      summary: `Could not read guardrails.yaml: ${read.readError}`,
      action: 'Check permissions on ~/.cindy-harness/guardrails.yaml.',
    };
  }

  const yaml = parseYamlStrict(read.text);
  if (!yaml.ok) {
    return {
      severity: 'fail',
      summary: `guardrails.yaml (line ${yaml.line}): ${yaml.message}`,
      detail: `File: ${filePath}\nLine ${yaml.line}: ${yaml.message}`,
      action: `Fix the YAML syntax error in ${filePath} at line ${yaml.line}.`,
    };
  }

  const errors: string[] = [];
  const doc = yaml.data;
  const allowedTop = new Set(['policy', 'disabled', 'rules']);
  for (const key of Object.keys(doc)) {
    if (!allowedTop.has(key)) {
      const line = findLineNumber(read.text, `${key}:`);
      errors.push(`guardrails.yaml (line ${line}): unknown top-level key "${key}"`);
    }
  }

  if (doc.policy !== undefined && doc.policy !== 'enforce' && doc.policy !== 'off') {
    const line = findLineNumber(read.text, 'policy:');
    errors.push(
      `guardrails.yaml (line ${line}): invalid policy ${JSON.stringify(doc.policy)} (expected "enforce" or "off")`,
    );
  }

  if (doc.disabled !== undefined) {
    if (!Array.isArray(doc.disabled) || doc.disabled.some((item) => typeof item !== 'string')) {
      const line = findLineNumber(read.text, 'disabled:');
      errors.push(`guardrails.yaml (line ${line}): "disabled" must be a list of rule IDs`);
    }
  }

  if (doc.rules !== undefined) {
    if (!Array.isArray(doc.rules)) {
      const line = findLineNumber(read.text, 'rules:');
      errors.push(`guardrails.yaml (line ${line}): "rules" must be a list of rule objects`);
    } else {
      for (let idx = 0; idx < doc.rules.length; idx++) {
        const rule = doc.rules[idx];
        const fallbackLine = findLineNumber(read.text, 'rules:');
        if (!isPlainObject(rule)) {
          errors.push(`guardrails.yaml (line ${fallbackLine}): rule #${idx + 1} must be a mapping`);
          continue;
        }
        if (typeof rule.id !== 'string' || !rule.id.trim()) {
          errors.push(`guardrails.yaml (line ${fallbackLine}): rule #${idx + 1} is missing a non-empty "id"`);
        }
        if (rule.category !== undefined && !GUARDRAIL_CATEGORIES.has(rule.category as GuardrailCategory)) {
          const line = findLineNumber(read.text, String(rule.category), fallbackLine);
          errors.push(
            `guardrails.yaml (line ${line}): rule "${String(rule.id ?? idx + 1)}" has invalid category "${String(rule.category)}"`,
          );
        }
        if (rule.scope !== undefined && rule.scope !== 'segment' && rule.scope !== 'whole') {
          const line = findLineNumber(read.text, String(rule.scope), fallbackLine);
          errors.push(
            `guardrails.yaml (line ${line}): rule "${String(rule.id ?? idx + 1)}" has invalid scope "${String(rule.scope)}" (expected "segment" or "whole")`,
          );
        }
        if (typeof rule.pattern !== 'string' || !rule.pattern) {
          const line = findLineNumber(read.text, typeof rule.id === 'string' ? rule.id : 'pattern', fallbackLine);
          errors.push(`guardrails.yaml (line ${line}): rule "${String(rule.id ?? idx + 1)}" is missing a "pattern"`);
        } else {
          try {
            new RegExp(rule.pattern, 'i');
          } catch (error) {
            const line = findLineNumber(read.text, rule.pattern, fallbackLine);
            errors.push(
              `guardrails.yaml (line ${line}): invalid regex pattern in rule "${String(rule.id ?? idx + 1)}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (typeof rule.reason !== 'string' || !rule.reason.trim()) {
          const line = findLineNumber(read.text, typeof rule.id === 'string' ? rule.id : 'reason', fallbackLine);
          errors.push(`guardrails.yaml (line ${line}): rule "${String(rule.id ?? idx + 1)}" is missing a "reason"`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return {
      severity: 'fail',
      summary: errors[0]!,
      detail: errors.join('\n'),
      action: 'Fix the invalid policy, schema fields, or regex patterns in ~/.cindy-harness/guardrails.yaml.',
    };
  }

  const parsed = parseGuardrailsYaml(read.text);
  return {
    severity: 'ok',
    summary: `guardrails.yaml valid (policy=${parsed.policy}, ${parsed.extraRules.length} extra rule(s))`,
    evidence: { policy: parsed.policy, extraRules: parsed.extraRules.length, disabled: parsed.disabled.length },
  };
}

async function runConfigWebBudget(ctx: DoctorContext): Promise<CheckRunOutput> {
  const filePath = path.join(ctx.paths.harnessDir, 'web-budget.yaml');
  const read = await readOptionalFile(ctx, filePath);
  if (!read.exists) {
    return { severity: 'ok', summary: 'web-budget.yaml is not configured (optional)' };
  }
  if ('readError' in read) {
    return {
      severity: 'fail',
      summary: `Could not read web-budget.yaml: ${read.readError}`,
      action: 'Check permissions on ~/.cindy-harness/web-budget.yaml.',
    };
  }

  const yaml = parseYamlStrict(read.text);
  if (!yaml.ok) {
    return {
      severity: 'fail',
      summary: `web-budget.yaml (line ${yaml.line}): ${yaml.message}`,
      detail: `File: ${filePath}\nLine ${yaml.line}: ${yaml.message}`,
      action: `Fix the YAML syntax error in ${filePath} at line ${yaml.line}.`,
    };
  }

  const parsed = parseWebBudgetYaml(read.text);
  if (parsed.errors.length > 0) {
    const detail = parsed.errors
      .map((err) => {
        const key = err.split(':')[0]!.trim();
        const line = findLineNumber(read.text, key);
        return `web-budget.yaml (line ${line}): ${err}`;
      })
      .join('\n');
    return {
      severity: 'fail',
      summary: detail.split('\n')[0]!,
      detail,
      action: 'Fix the invalid fields in ~/.cindy-harness/web-budget.yaml.',
    };
  }

  return {
    severity: 'ok',
    summary: `web-budget.yaml valid (max_searches_per_session=${parsed.config.maxSearchesPerSession})`,
    evidence: {
      maxSearchesPerSession: parsed.config.maxSearchesPerSession,
      toolNamesCount: parsed.config.toolNames.length,
    },
  };
}

async function runConfigSmallJson(ctx: DoctorContext): Promise<CheckRunOutput> {
  const candidates = new Set<string>(FIXED_SMALL_JSON_FILES);
  try {
    const entries = await ctx.fs.readdir(ctx.paths.harnessDir);
    for (const entry of entries) {
      if (entry.endsWith('-sessions.json')) {
        candidates.add(entry);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        severity: 'fail',
        summary: `Could not read ~/.cindy-harness directory: ${error instanceof Error ? error.message : String(error)}`,
        action: 'Check permissions on ~/.cindy-harness.',
      };
    }
  }

  const sortedNames = [...candidates].sort();
  let checkedCount = 0;
  const errors: string[] = [];

  for (const name of sortedNames) {
    const fullPath = path.join(ctx.paths.harnessDir, name);
    const read = await readOptionalFile(ctx, fullPath);
    if (!read.exists) continue;
    checkedCount += 1;
    if ('readError' in read) {
      errors.push(`${name}: could not read (${read.readError})`);
      continue;
    }
    const parsed = parseJsonWithByteOffset(read.text);
    if (!parsed.ok) {
      errors.push(`${name} (byte offset ${parsed.byteOffset}): ${parsed.message}`);
    } else if (!isPlainObject(parsed.value)) {
      errors.push(`${name} (byte offset 0): expected a top-level JSON object`);
    }
  }

  if (checkedCount === 0) {
    return { severity: 'ok', summary: 'Small JSON stores are not configured (optional)' };
  }

  if (errors.length > 0) {
    return {
      severity: 'fail',
      summary: errors[0]!,
      detail: errors.join('\n'),
      action: 'Fix or restore the malformed JSON file(s) under ~/.cindy-harness/.',
    };
  }

  return {
    severity: 'ok',
    summary: `Validated ${checkedCount} JSON store(s) in ~/.cindy-harness`,
    evidence: { checkedCount },
  };
}

async function runConfigHermes(ctx: DoctorContext): Promise<CheckRunOutput> {
  if (isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    return {
      severity: 'fail',
      summary: 'Refusing to inspect non-isolated daily Hermes home; ~/.hermes-cindy is required',
      detail: `Resolved hermesHome (${ctx.paths.hermesHome}) points to the daily Hermes directory.`,
      action: 'Point CINDY_HERMES_HOME to ~/.hermes-cindy (the isolated Cindy Hermes home).',
    };
  }

  const configPath = path.join(ctx.paths.hermesHome, 'config.yaml');
  const read = await readOptionalFile(ctx, configPath);
  if (!read.exists) {
    return { severity: 'ok', summary: 'Hermes config.yaml is not configured (optional)' };
  }
  if ('readError' in read) {
    return {
      severity: 'fail',
      summary: `Could not read Hermes config.yaml: ${read.readError}`,
      action: 'Check permissions on ~/.hermes-cindy/config.yaml.',
    };
  }

  const yaml = parseYamlStrict(read.text);
  if (!yaml.ok) {
    return {
      severity: 'fail',
      summary: `config.yaml (line ${yaml.line}): ${yaml.message}`,
      detail: `File: ${configPath}\nLine ${yaml.line}: ${yaml.message}`,
      action: `Fix the YAML syntax error in ${configPath} at line ${yaml.line}.`,
    };
  }

  const errors: string[] = [];
  const doc = yaml.data;
  const customProviderNames = new Set<string>();

  if (doc.custom_providers !== undefined && doc.custom_providers !== null) {
    if (!Array.isArray(doc.custom_providers)) {
      const line = findLineNumber(read.text, 'custom_providers:');
      errors.push(`config.yaml (line ${line}): custom_providers must be a YAML list`);
    } else {
      for (let idx = 0; idx < doc.custom_providers.length; idx++) {
        const entry = doc.custom_providers[idx];
        const blockLine = findLineNumber(read.text, 'custom_providers:');
        if (!isPlainObject(entry)) {
          errors.push(`config.yaml (line ${blockLine}): custom_providers[${idx}] must be a mapping`);
          continue;
        }
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        const baseUrl =
          typeof entry.base_url === 'string'
            ? entry.base_url.trim()
            : typeof entry.baseUrl === 'string'
              ? entry.baseUrl.trim()
              : '';
        if (!name) {
          errors.push(`config.yaml (line ${blockLine}): custom_providers[${idx}] is missing a non-empty "name"`);
        } else {
          customProviderNames.add(name);
        }
        if (!baseUrl) {
          const line = findLineNumber(read.text, name || 'custom_providers:', blockLine);
          errors.push(`config.yaml (line ${line}): custom_providers entry "${name || idx}" is missing "base_url"`);
        }
        if (entry.context_length !== undefined) {
          if (
            typeof entry.context_length !== 'number' ||
            !Number.isInteger(entry.context_length) ||
            entry.context_length <= 0
          ) {
            const line = findLineNumber(read.text, 'context_length', blockLine);
            errors.push(
              `config.yaml (line ${line}): custom_providers entry "${name || idx}" has invalid context_length (expected positive integer)`,
            );
          }
        }
      }
    }
  }

  // Also collect line-parsed custom providers & cross-check local routes from Cindy's routing/providers files.
  const lineParsedCustom = parseHermesCustomProviders(read.text);
  for (const entry of lineParsedCustom) {
    if (entry.name) customProviderNames.add(entry.name);
  }

  const { ids: knownProviderIds, localIds: localProviderIds, available: providersOk } =
    await readKnownProviders(ctx);
  const routingRead = await readOptionalFile(ctx, path.join(ctx.paths.harnessDir, 'routing.yaml'));
  if (providersOk && routingRead.exists && !('readError' in routingRead)) {
    const parsedRouting = parseRoutingYaml(routingRead.text, knownProviderIds);
    const checkedProviders = new Set<string>();
    for (const [routeName, route] of Object.entries(parsedRouting.routes)) {
      if (
        localProviderIds.has(route.provider) &&
        !customProviderNames.has(route.provider) &&
        !checkedProviders.has(route.provider)
      ) {
        checkedProviders.add(route.provider);
        errors.push(
          `config.yaml: local routed provider "${route.provider}" (used by route "${routeName}") is missing from custom_providers`,
        );
      }
    }

    const defaultRoute = parseHermesDefaultRoute(read.text);
    if (
      defaultRoute.provider &&
      localProviderIds.has(defaultRoute.provider) &&
      !customProviderNames.has(defaultRoute.provider)
    ) {
      const line = findLineNumber(read.text, defaultRoute.provider);
      errors.push(
        `config.yaml (line ${line}): model.provider "${defaultRoute.provider}" is missing from custom_providers`,
      );
    }
    const fallbackRoute = parseHermesFallbackModel(read.text);
    if (
      fallbackRoute?.provider &&
      localProviderIds.has(fallbackRoute.provider) &&
      !customProviderNames.has(fallbackRoute.provider)
    ) {
      const line = findLineNumber(read.text, fallbackRoute.provider);
      errors.push(
        `config.yaml (line ${line}): fallback_model.provider "${fallbackRoute.provider}" is missing from custom_providers`,
      );
    }
  }

  if (errors.length > 0) {
    return {
      severity: 'fail',
      summary: errors[0]!,
      detail: errors.join('\n'),
      action: 'Update ~/.hermes-cindy/config.yaml custom_providers (via Hermes Settings or daemon RPC) to register every routed local provider.',
    };
  }

  return {
    severity: 'ok',
    summary: `Hermes config.yaml valid (${customProviderNames.size} custom_provider(s))`,
    evidence: { customProvidersCount: customProviderNames.size },
  };
}

async function runConfigLkgDiff(ctx: DoctorContext): Promise<CheckRunOutput> {
  const diff = await diffAgainstLatestLkg(ctx);
  if (!diff.hasSnapshot) {
    return {
      severity: 'ok',
      summary: 'LKG snapshot not configured yet (optional — run pnpm run doctor snapshot)',
      evidence: { hasSnapshot: false },
    };
  }
  if (!diff.snapshotValid) {
    return {
      severity: 'warn',
      summary: `Latest LKG snapshot ${diff.stamp} is invalid: ${diff.snapshotError ?? 'verification failed'}`,
      action: 'Run `pnpm run doctor snapshot --reason "refresh"` to capture a clean LKG snapshot.',
      evidence: { hasSnapshot: true, stamp: diff.stamp ?? null, snapshotValid: false },
    };
  }

  const allDiffs = [
    ...diff.changed.map((f) => `${f} (modified)`),
    ...diff.added.map((f) => `${f} (added)`),
    ...diff.removed.map((f) => `${f} (removed)`),
  ];

  if (allDiffs.length === 0) {
    return {
      severity: 'ok',
      summary: `Config matches LKG snapshot ${diff.stamp} (${diff.totalSnapshotFiles} file(s))`,
      evidence: {
        hasSnapshot: true,
        stamp: diff.stamp ?? null,
        totalFiles: diff.totalSnapshotFiles,
      },
    };
  }

  const preview = allDiffs.slice(0, 4).join(', ');
  const suffix = allDiffs.length > 4 ? ` (+${allDiffs.length - 4} more)` : '';
  return {
    severity: 'warn',
    summary: `Config differs from LKG ${diff.stamp}: ${preview}${suffix}`,
    detail: allDiffs.join('\n'),
    action: `Review changes or run \`pnpm run doctor rollback ${diff.stamp} [--file <rel>]\`.`,
    evidence: {
      hasSnapshot: true,
      stamp: diff.stamp ?? null,
      changedCount: diff.changed.length,
      addedCount: diff.added.length,
      removedCount: diff.removed.length,
    },
  };
}

function withLkgFixSuggestion(
  runner: (ctx: DoctorContext) => Promise<CheckRunOutput>,
  attachOnWarn = false,
): (ctx: DoctorContext) => Promise<CheckRunOutput> {
  return async (ctx) => {
    const out = await runner(ctx);
    const shouldAttach =
      out.severity === 'fail' || (attachOnWarn && out.severity === 'warn');
    if (!shouldAttach || (out.fixIds && out.fixIds.includes('fix.config.restore-lkg'))) {
      return out;
    }
    return {
      ...out,
      fixIds: [...(out.fixIds ?? []), 'fix.config.restore-lkg'],
    };
  };
}

const validationChecks: readonly DoctorCheck[] = [
  {
    id: 'config.providers',
    layer: 'config',
    title: 'Providers config (~/.cindy-harness/providers.yaml)',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigProviders),
  },
  {
    id: 'config.routing',
    layer: 'config',
    title: 'Routing config (~/.cindy-harness/routing.yaml)',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigRouting),
  },
  {
    id: 'config.experts',
    layer: 'config',
    title: 'Experts configs (~/.cindy-harness/experts/*)',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigExperts),
  },
  {
    id: 'config.guardrails',
    layer: 'config',
    title: 'Guardrails config (~/.cindy-harness/guardrails.yaml)',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigGuardrails),
  },
  {
    id: 'config.web-budget',
    layer: 'config',
    title: 'Web budget config (~/.cindy-harness/web-budget.yaml)',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigWebBudget),
  },
  {
    id: 'config.small-json',
    layer: 'config',
    title: 'Small JSON stores (~/.cindy-harness/*.json)',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigSmallJson),
  },
  {
    id: 'config.hermes',
    layer: 'config',
    title: 'Hermes config (~/.hermes-cindy/config.yaml)',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigHermes),
  },
];

const checks: readonly DoctorCheck[] = [
  ...validationChecks,
  {
    id: 'config.lkg-diff',
    layer: 'config',
    title: 'Config vs latest LKG snapshot',
    cost: 'fast',
    run: withLkgFixSuggestion(runConfigLkgDiff, true),
  },
];

interface SnapshotFileOverlay {
  rel: string;
  destPath: string;
  snapFilePath: string;
  bytes: Buffer;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function checkIdsForConfigRel(rel: string): string[] {
  if (rel === 'harness/providers.yaml') return ['config.providers'];
  if (rel === 'harness/routing.yaml') return ['config.routing'];
  if (rel.startsWith('harness/experts/')) return ['config.experts'];
  if (rel === 'harness/guardrails.yaml') return ['config.guardrails'];
  if (rel === 'harness/web-budget.yaml') return ['config.web-budget'];
  if (rel === 'hermes/config.yaml') return ['config.hermes'];
  if (rel.startsWith('harness/') && rel.endsWith('.json')) return ['config.small-json'];
  return validationChecks.map((c) => c.id);
}

function buildReadOnlyOverlayFs(
  baseFs: DoctorFs,
  ctx: DoctorContext,
  overlays: readonly SnapshotFileOverlay[],
): DoctorFs {
  const byDest = new Map<string, SnapshotFileOverlay>();
  const expertSlugs = new Set<string>();
  const expertFiles = new Map<string, Set<string>>();

  for (const item of overlays) {
    byDest.set(path.resolve(item.destPath), item);
    if (item.rel.startsWith('harness/experts/')) {
      const parts = item.rel.split('/');
      if (parts.length === 4 && parts[2] && parts[3]) {
        expertSlugs.add(parts[2]);
        let set = expertFiles.get(parts[2]);
        if (!set) {
          set = new Set<string>();
          expertFiles.set(parts[2], set);
        }
        set.add(parts[3]);
      }
    }
  }

  const expertsRoot = path.resolve(path.join(ctx.paths.harnessDir, 'experts'));
  const makeSyntheticDirent = (name: string, isDir: boolean): Dirent<string> =>
    ({
      name,
      parentPath: '',
      path: '',
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }) as Dirent<string>;

  return {
    readFile: ((targetPath: Parameters<DoctorFs['readFile']>[0], options?: Parameters<DoctorFs['readFile']>[1]) => {
      if (typeof targetPath === 'string' || targetPath instanceof URL) {
        const key = path.resolve(targetPath instanceof URL ? targetPath.pathname : targetPath);
        const hit = byDest.get(key);
        if (hit) {
          if (typeof options === 'string') {
            return Promise.resolve(hit.bytes.toString(options)) as ReturnType<DoctorFs['readFile']>;
          }
          if (options && typeof options === 'object' && options.encoding) {
            return Promise.resolve(hit.bytes.toString(options.encoding)) as ReturnType<DoctorFs['readFile']>;
          }
          return Promise.resolve(Buffer.from(hit.bytes)) as ReturnType<DoctorFs['readFile']>;
        }
      }
      return baseFs.readFile(targetPath, options as never) as ReturnType<DoctorFs['readFile']>;
    }) as DoctorFs['readFile'],

    stat: (async (targetPath: Parameters<DoctorFs['stat']>[0]) => {
      if (typeof targetPath === 'string' || targetPath instanceof URL) {
        const key = path.resolve(targetPath instanceof URL ? targetPath.pathname : targetPath);
        const hit = byDest.get(key);
        if (hit) {
          return baseFs.stat(hit.snapFilePath);
        }
        if (key === expertsRoot && expertSlugs.size > 0) {
          try {
            return await baseFs.stat(key);
          } catch {
            return { isDirectory: () => true, isFile: () => false, size: 0 } as Stats;
          }
        }
        if (key.startsWith(`${expertsRoot}${path.sep}`)) {
          const sub = key.slice(expertsRoot.length + 1);
          if (!sub.includes(path.sep) && expertSlugs.has(sub)) {
            try {
              return await baseFs.stat(key);
            } catch {
              return { isDirectory: () => true, isFile: () => false, size: 0 } as Stats;
            }
          }
        }
      }
      return baseFs.stat(targetPath);
    }) as DoctorFs['stat'],

    access: (async (targetPath: Parameters<DoctorFs['access']>[0], mode?: number) => {
      if (typeof targetPath === 'string' || targetPath instanceof URL) {
        const key = path.resolve(targetPath instanceof URL ? targetPath.pathname : targetPath);
        const hit = byDest.get(key);
        if (hit) {
          return baseFs.access(hit.snapFilePath, mode);
        }
      }
      return baseFs.access(targetPath, mode);
    }) as DoctorFs['access'],

    readdir: (async (targetPath: Parameters<DoctorFs['readdir']>[0], options?: Parameters<DoctorFs['readdir']>[1]) => {
      const key =
        typeof targetPath === 'string' || targetPath instanceof URL
          ? path.resolve(targetPath instanceof URL ? targetPath.pathname : targetPath)
          : null;

      if (key === expertsRoot && expertSlugs.size > 0 && options && typeof options === 'object' && 'withFileTypes' in options && options.withFileTypes) {
        let existing: Dirent<string>[] = [];
        try {
          existing = (await baseFs.readdir(targetPath, options as { withFileTypes: true })) as Dirent<string>[];
        } catch {
          existing = [];
        }
        const seen = new Set(existing.map((d) => d.name));
        const merged = [...existing];
        for (const slug of expertSlugs) {
          if (!seen.has(slug)) {
            merged.push(makeSyntheticDirent(slug, true));
          }
        }
        return merged;
      }

      if (key && key.startsWith(`${expertsRoot}${path.sep}`)) {
        const slug = key.slice(expertsRoot.length + 1);
        const extraFiles = expertFiles.get(slug);
        if (extraFiles && extraFiles.size > 0 && options && typeof options === 'object' && 'withFileTypes' in options && options.withFileTypes) {
          let existing: Dirent<string>[] = [];
          try {
            existing = (await baseFs.readdir(targetPath, options as { withFileTypes: true })) as Dirent<string>[];
          } catch {
            existing = [];
          }
          const seen = new Set(existing.map((d) => d.name));
          const merged = [...existing];
          for (const fname of extraFiles) {
            if (!seen.has(fname)) {
              merged.push(makeSyntheticDirent(fname, false));
            }
          }
          return merged;
        }
      }

      return baseFs.readdir(targetPath, options as never);
    }) as DoctorFs['readdir'],
  };
}

const configValidationRegistry = createRegistry([
  { name: 'config-validation', checks: validationChecks },
]);

const fixConfigRestoreLkg: DoctorFix = {
  id: 'fix.config.restore-lkg',
  title: 'Restore config file(s) from newest valid LKG snapshot',
  risk: 'moves-files',
  needsAppClosed: false,
  recheck: ['config'],

  async preview(ctx: DoctorContext, target?: string): Promise<FixPlan> {
    const normalizedTarget = target?.replace(/\\/g, '/').trim();
    if (normalizedTarget !== undefined && normalizedTarget.length === 0) {
      return {
        fixId: 'fix.config.restore-lkg',
        steps: ['Invalid empty --target value.'],
        touches: [],
        meta: { refusalReason: 'Invalid empty --target value.' },
      };
    }

    if (normalizedTarget !== undefined && !resolveRestoreDestination(ctx, normalizedTarget)) {
      const msg = `Unsupported or excluded config restore target: ${normalizedTarget}`;
      return {
        fixId: 'fix.config.restore-lkg',
        target: normalizedTarget,
        steps: [msg],
        touches: [],
        meta: { refusalReason: msg },
      };
    }

    const snapshots = await listLkgSnapshots(ctx);
    const homeRedact = { homeDir: ctx.paths.home };

    for (const snap of snapshots) {
      if (!snap.valid || !snap.manifest) continue;
      if (snap.manifest.reason.startsWith('pre-fix:')) continue;

      const entries =
        normalizedTarget !== undefined
          ? snap.manifest.files.filter((f) => f.rel === normalizedTarget)
          : snap.manifest.files;

      if (entries.length === 0) continue;

      const overlays: SnapshotFileOverlay[] = [];
      let integrityOk = true;
      for (const entry of entries) {
        const destPath = resolveRestoreDestination(ctx, entry.rel);
        if (!destPath) {
          integrityOk = false;
          break;
        }
        const snapFilePath = path.join(snap.dir, 'files', entry.rel);
        try {
          const bytes = Buffer.from(await ctx.fs.readFile(snapFilePath));
          if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
            integrityOk = false;
            break;
          }
          overlays.push({ rel: entry.rel, destPath, snapFilePath, bytes });
        } catch {
          integrityOk = false;
          break;
        }
      }

      if (!integrityOk || overlays.length === 0) continue;

      const overlayFs = buildReadOnlyOverlayFs(ctx.fs, ctx, overlays);
      const checkOnly =
        normalizedTarget !== undefined
          ? checkIdsForConfigRel(normalizedTarget)
          : validationChecks.map((c) => c.id);

      const validationReport = await runChecks(
        configValidationRegistry,
        { ...ctx, fs: overlayFs, includeApi: false },
        { only: checkOnly },
      );
      if (validationReport.counts.fail > 0) {
        continue;
      }

      // Select only missing/differing files when no explicit single target was requested
      const selected: SnapshotFileOverlay[] = [];
      if (normalizedTarget !== undefined) {
        selected.push(...overlays);
      } else {
        for (const item of overlays) {
          try {
            const liveBytes = Buffer.from(await ctx.fs.readFile(item.destPath));
            if (!liveBytes.equals(item.bytes)) {
              selected.push(item);
            }
          } catch {
            selected.push(item);
          }
        }
      }

      const requiresAppClosed = selected.some((item) => item.rel === 'hermes/config.yaml');
      return {
        fixId: 'fix.config.restore-lkg',
        ...(normalizedTarget ? { target: normalizedTarget } : {}),
        steps:
          selected.length > 0
            ? selected.map(
                (item) =>
                  `Restore ${item.rel} from valid LKG snapshot ${snap.stamp} to ${redactText(item.destPath, homeRedact)} (moving current copy to .pre-rollback-<stamp>)`,
              )
            : [`All config files already match valid LKG snapshot ${snap.stamp}.`],
        touches: selected.map((item) => item.destPath),
        requiresAppClosed,
        meta: {
          stamp: snap.stamp,
          rels: selected.map((item) => item.rel),
        },
      };
    }

    const refusalReason = normalizedTarget
      ? `No valid LKG snapshot contains a passing copy of ${normalizedTarget}.`
      : 'No valid LKG snapshot passing config validation was found.';
    return {
      fixId: 'fix.config.restore-lkg',
      ...(normalizedTarget ? { target: normalizedTarget } : {}),
      steps: [refusalReason],
      touches: [],
      meta: { refusalReason },
    };
  },

  async apply(ctx: DoctorContext, plan: FixPlan): Promise<FixOutcome> {
    const meta = (plan.meta ?? {}) as { stamp?: unknown; rels?: unknown; refusalReason?: unknown };
    if (typeof meta.refusalReason === 'string' && meta.refusalReason.length > 0) {
      return {
        ok: false,
        rolledBack: false,
        message: meta.refusalReason,
        recheck: [],
      };
    }
    const stamp = typeof meta.stamp === 'string' ? meta.stamp : '';
    const rels = Array.isArray(meta.rels)
      ? meta.rels.filter((r): r is string => typeof r === 'string')
      : [];

    if (!stamp) {
      return {
        ok: false,
        rolledBack: false,
        message: 'Invalid fix plan: missing LKG snapshot stamp.',
        recheck: [],
      };
    }

    if (rels.length === 0) {
      return {
        ok: true,
        rolledBack: false,
        message: `Config already matches LKG snapshot ${stamp}.`,
        recheck: [],
      };
    }

    const result = await rollbackLkgSnapshot(ctx, {
      stamp,
      fileRels: rels,
      skipRecheck: true,
    });

    if (!result.ok) {
      return {
        ok: false,
        rolledBack: false,
        message: result.error ?? `Failed to restore from LKG snapshot ${stamp}`,
        recheck: [],
      };
    }

    return {
      ok: true,
      rolledBack: false,
      message: `Restored ${result.restored.length} file(s) from LKG snapshot ${stamp}`,
      recheck: [],
    };
  },
};

export async function loadDoctorMcpCatalog(ctx: DoctorContext): Promise<{
  entries: McpCatalogEntry[];
  configs: Record<string, McpServerConfig>;
  hermesConfigError?: string;
}> {
  const builtinServers: Record<string, McpServerConfig> = {};
  for (const id of KNOWN_BUILTIN_MCP_IDS) {
    builtinServers[id] = { inProcess: true };
  }
  const catalogSources: McpCatalogSource[] = [{ source: 'lizi', servers: builtinServers }];
  let hermesConfigError: string | undefined;

  if (!isDailyHermesPath(ctx.paths.hermesHome, ctx.paths.home, ctx.platform)) {
    const hermesCfg = await readOptionalFile(ctx, path.join(ctx.paths.hermesHome, 'config.yaml'));
    if (hermesCfg.exists) {
      if ('readError' in hermesCfg) {
        hermesConfigError = hermesCfg.readError;
      } else {
        const mcpServers = parseHermesMcpServers(hermesCfg.text);
        catalogSources.push({ source: 'hermes', servers: mcpServers });
      }
    }
  }

  const entries = buildMcpCatalog(catalogSources);
  const configs: Record<string, McpServerConfig> = {};
  for (const source of catalogSources) {
    for (const [name, cfg] of Object.entries(source.servers)) {
      configs[`${source.source}/${name}`] = cfg;
    }
  }
  return { entries, configs, ...(hermesConfigError ? { hermesConfigError } : {}) };
}

export const configPack: DoctorPack = {
  name: 'config',
  checks,
  fixes: [fixConfigRestoreLkg],
};
