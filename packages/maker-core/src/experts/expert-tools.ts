/**
 * Expert tools policy and parser (ROADMAP 3.2b).
 *
 * Defines the schema and evaluation semantics for `tools.yaml` within an expert directory.
 * Unblocks ROADMAP 4.3 ("add MCP server to expert") and 5.1b ("local notes vault bridge").
 *
 * File structure:
 * ```yaml
 * tools:
 *   allow: [read_project_file, search_project]
 *   deny: [bash]
 * mcp_servers: # or mcpServers
 *   allow: [cindy_project_reader, cindy_docs]
 *   deny: [cindy_ssh]
 * ```
 *
 * Evaluation rules:
 * - Fail closed on safety (AGENTS.md §6):
 *   1. Explicit `deny` always wins. If a tool or server is listed in `deny`, it is blocked.
 *   2. If `allow` is specified (even if empty), it acts as a strict whitelist: only tools/servers
 *      in `allow` (and not in `deny`) are permitted.
 *   3. If `allow` is omitted or undefined, any tool or server not in `deny` is permitted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

export interface ToolFilterList {
  allow?: string[];
  deny?: string[];
}

export interface ExpertToolsPolicy {
  tools?: ToolFilterList;
  mcpServers?: ToolFilterList;
}

export interface ExpertToolsIssue {
  where: string;
  message: string;
}

export interface ExpertToolsParseResult {
  policy: ExpertToolsPolicy;
  issues: ExpertToolsIssue[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

function parseFilterSection(
  raw: unknown,
  sectionName: string,
  issues: ExpertToolsIssue[],
): ToolFilterList | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    issues.push({
      where: sectionName,
      message: `"${sectionName}" must be a mapping with "allow" and/or "deny"`,
    });
    return undefined;
  }

  const allowedKeys = new Set(['allow', 'deny']);
  for (const k of Object.keys(raw)) {
    if (!allowedKeys.has(k)) {
      issues.push({
        where: `${sectionName}.${k}`,
        message: `unknown key "${k}" in ${sectionName} (expected "allow" or "deny")`,
      });
    }
  }

  const filter: ToolFilterList = {};

  if (raw.allow !== undefined) {
    if (!isStringList(raw.allow)) {
      issues.push({
        where: `${sectionName}.allow`,
        message: '"allow" must be a list of non-empty strings',
      });
    } else {
      filter.allow = Array.from(new Set(raw.allow.map((s) => s.trim())));
    }
  }

  if (raw.deny !== undefined) {
    if (!isStringList(raw.deny)) {
      issues.push({
        where: `${sectionName}.deny`,
        message: '"deny" must be a list of non-empty strings',
      });
    } else {
      filter.deny = Array.from(new Set(raw.deny.map((s) => s.trim())));
    }
  }

  return filter;
}

/** Validate an unmarshalled JavaScript object representation of tools.yaml. Never throws. */
export function parseExpertToolsDoc(doc: unknown): ExpertToolsParseResult {
  const result: ExpertToolsParseResult = {
    policy: {},
    issues: [],
  };

  if (doc === undefined || doc === null || (typeof doc === 'string' && doc.trim() === '')) {
    return result;
  }

  if (!isRecord(doc)) {
    result.issues.push({
      where: '(file)',
      message: 'top level must be a YAML mapping with "tools" and/or "mcp_servers"',
    });
    return result;
  }

  const allowedTopKeys = new Set(['tools', 'mcp_servers', 'mcpServers']);
  for (const k of Object.keys(doc)) {
    if (!allowedTopKeys.has(k)) {
      result.issues.push({
        where: k,
        message: `unknown property "${k}" in tools.yaml (expected "tools" or "mcp_servers")`,
      });
    }
  }

  if (doc.mcp_servers !== undefined && doc.mcpServers !== undefined) {
    result.issues.push({
      where: 'mcp_servers',
      message: 'specify either "mcp_servers" or "mcpServers", not both',
    });
  }

  const tools = parseFilterSection(doc.tools, 'tools', result.issues);
  if (tools) {
    result.policy.tools = tools;
  }

  const rawMcp = doc.mcp_servers !== undefined ? doc.mcp_servers : doc.mcpServers;
  const mcpServers = parseFilterSection(rawMcp, 'mcp_servers', result.issues);
  if (mcpServers) {
    result.policy.mcpServers = mcpServers;
  }

  return result;
}

/** Parse raw tools.yaml string. Never throws: syntax errors return issues. */
export function parseExpertToolsYaml(text: string): ExpertToolsParseResult {
  if (!text.trim()) {
    return { policy: {}, issues: [] };
  }
  let doc: unknown;
  try {
    doc = matter(`---\n${text}\n---\n`, {}).data;
  } catch (error) {
    return {
      policy: {},
      issues: [
        {
          where: '(file)',
          message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return parseExpertToolsDoc(doc);
}

/** Load tools.yaml from disk. Missing file returns empty policy with no issues. */
export function loadExpertToolsFile(file: string): ExpertToolsParseResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { policy: {}, issues: [] };
    }
    return {
      policy: {},
      issues: [
        {
          where: '(file)',
          message: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return parseExpertToolsYaml(text);
}

/** Format an ExpertToolsPolicy back to clean YAML. */
export function serializeExpertToolsPolicy(policy: ExpertToolsPolicy): string {
  const lines: string[] = [];

  if (policy.tools) {
    lines.push('tools:');
    if (policy.tools.allow !== undefined) {
      lines.push('  allow:');
      for (const item of policy.tools.allow) {
        lines.push(`    - ${item}`);
      }
    }
    if (policy.tools.deny !== undefined) {
      lines.push('  deny:');
      for (const item of policy.tools.deny) {
        lines.push(`    - ${item}`);
      }
    }
  }

  if (policy.mcpServers) {
    lines.push('mcp_servers:');
    if (policy.mcpServers.allow !== undefined) {
      lines.push('  allow:');
      for (const item of policy.mcpServers.allow) {
        lines.push(`    - ${item}`);
      }
    }
    if (policy.mcpServers.deny !== undefined) {
      lines.push('  deny:');
      for (const item of policy.mcpServers.deny) {
        lines.push(`    - ${item}`);
      }
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Atomic write of tools.yaml (tmp file in same directory + rename). */
export function writeExpertToolsFile(filePath: string, policy: ExpertToolsPolicy): void {
  const content = serializeExpertToolsPolicy(policy);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tools.yaml.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Determine whether a tool is permitted under the given policy and optional fallback tools.
 * - Explicit deny always wins (returns false).
 * - If policy.tools.allow is defined, acts as strict whitelist.
 * - If policy.tools is omitted and fallbackAllowedTools is provided, checks fallback.
 * - Otherwise returns true.
 */
export function isToolAllowed(
  toolName: string,
  policy?: ExpertToolsPolicy | null,
  fallbackAllowedTools?: readonly string[],
): boolean {
  if (!policy || !policy.tools) {
    if (fallbackAllowedTools !== undefined) {
      return fallbackAllowedTools.includes(toolName);
    }
    return true;
  }

  const { allow, deny } = policy.tools;

  if (deny && deny.includes(toolName)) {
    return false;
  }

  if (allow !== undefined) {
    return allow.includes(toolName);
  }

  if (fallbackAllowedTools !== undefined) {
    return fallbackAllowedTools.includes(toolName);
  }

  return true;
}

/**
 * Determine whether an MCP server is permitted under the given policy.
 * - Explicit deny always wins (returns false).
 * - If policy.mcpServers.allow is defined, acts as strict whitelist.
 * - Otherwise returns true.
 */
export function isMcpServerAllowed(
  serverName: string,
  policy?: ExpertToolsPolicy | null,
): boolean {
  if (!policy || !policy.mcpServers) {
    return true;
  }

  const { allow, deny } = policy.mcpServers;

  if (deny && deny.includes(serverName)) {
    return false;
  }

  if (allow !== undefined) {
    return allow.includes(serverName);
  }

  return true;
}
