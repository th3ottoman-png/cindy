/**
 * cindy_skills — first-party MCP server for ROADMAP 11.1 (Tier 2A activation).
 *
 * The model sees only the compact `<available_skills>` discovery strip. When a task matches,
 * it calls `activate_skill({ skill_slug })` and receives exactly one full SKILL.md body plus
 * an index of scripts/ and references/ paths. Those paths are NOT read here: Tier 3 material
 * stays out of prompt context until the agent deliberately runs or reads it.
 *
 * Fail closed, matching AGENTS.md §6.3: no session context, chat-only mode, an unknown slug,
 * or a malformed skill all return a structured error. Nothing silently falls back to another
 * skill or to Hermes's own skills tool.
 *
 * Hermes-only: this provider is mounted on the Hermes bridge, never on the Claude Code,
 * Codex or Pi adapters (AGENTS.md §3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpProvider } from '@cindy/maker-core';
import {
  activateSkill,
  buildDiscoveryCatalog,
  formatSkillActivation,
  renderDiscoveryManifest,
  type SkillDiscoveryCatalog,
} from '@cindy/maker-core/progressive-skills';

export const CINDY_SKILLS_MCP_SERVER_NAME = 'cindy_skills';
export const ACTIVATE_SKILL_TOOL = 'activate_skill';
export const LIST_SKILLS_TOOL = 'list_skills';

/** Blueprint §4 tool schema, kept as a constant so tests can assert the contract. */
export const ACTIVATE_SKILL_TOOL_SCHEMA = {
  name: ACTIVATE_SKILL_TOOL,
  description:
    'Load the complete instructions, procedures, and script definitions for an installed skill into your context. Call this when a task matches a skill listed in your Available Skills manifest.',
  parameters: {
    type: 'object',
    properties: {
      skill_slug: {
        type: 'string',
        description:
          "The exact slug of the skill to activate as listed in the Available Skills manifest (e.g. 'git-worktree').",
      },
    },
    required: ['skill_slug'],
  },
} as const;

export interface CindySkillsMcpDeps {
  /** Skill roots in priority order. Production: the Hermes home skills dir plus expert dirs. */
  getSkillRoots(): readonly string[];
  /** Resolved at call time, never trusted from tool arguments. */
  getSessionContext(): { agentKind?: string; sessionId?: string } | undefined;
  /** Chat-only sessions have no tools at all; activation must fail closed. */
  isChatOnly?(sessionId: string | undefined): boolean;
  /** Injected clock for a deterministic catalog in tests. */
  nowMs?(): number;
}

function rootsSignature(roots: readonly string[]): string {
  const parts: string[] = [];
  for (const root of roots) {
    try {
      const stat = fs.statSync(root);
      parts.push(`${root}:${stat.mtimeMs}`);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          parts.push(`${entry.name}:${fs.statSync(path.join(root, entry.name)).mtimeMs}`);
        } catch {
          parts.push(`${entry.name}:missing`);
        }
      }
    } catch {
      parts.push(`${root}:missing`);
    }
  }
  return parts.join('|');
}

/** In-memory catalog cache invalidated by directory mtimes (blueprint §6.1). */
export class SkillCatalogCache {
  private signature = '';
  private catalog: SkillDiscoveryCatalog | null = null;

  constructor(private readonly deps: CindySkillsMcpDeps) {}

  get(): SkillDiscoveryCatalog | null {
    const roots = this.deps.getSkillRoots();
    const next = rootsSignature(roots);
    if (this.catalog && next === this.signature) return this.catalog;
    const built = buildDiscoveryCatalog({ roots, nowMs: this.deps.nowMs?.() });
    this.signature = next;
    this.catalog = built;
    return built;
  }
}

function reply(payload: string, isError = false) {
  return { content: [{ type: 'text' as const, text: payload }], ...(isError ? { isError: true as const } : {}) };
}

export function createCindySkillsMcpServer(deps: CindySkillsMcpDeps): McpServer {
  const server = new McpServer({ name: CINDY_SKILLS_MCP_SERVER_NAME, version: '1.0.0' });
  const cache = new SkillCatalogCache(deps);

  server.tool(
    ACTIVATE_SKILL_TOOL,
    ACTIVATE_SKILL_TOOL_SCHEMA.description,
    {
      skill_slug: z.string().describe(ACTIVATE_SKILL_TOOL_SCHEMA.parameters.properties.skill_slug.description),
    },
    async ({ skill_slug }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return reply(JSON.stringify({ status: 'refused', errorCode: 'NO_SESSION', message: 'no session context available' }), true);
      }
      if (deps.isChatOnly?.(ctx.sessionId) === true) {
        return reply(
          JSON.stringify({ status: 'refused', errorCode: 'PERMISSION_DENIED', message: 'Skill activation is disabled in chat-only mode.' }),
          true,
        );
      }
      const catalog = cache.get();
      if (!catalog) {
        return reply(JSON.stringify({ status: 'refused', errorCode: 'PERMISSION_DENIED', message: 'Skill discovery is disabled.' }), true);
      }
      const outcome = activateSkill({ catalog, slug: skill_slug, source: 'model' });
      if (!outcome.ok) {
        return reply(
          JSON.stringify({ status: 'refused', errorCode: outcome.error.code, message: outcome.error.message, suggestions: outcome.error.suggestions }),
          true,
        );
      }
      return reply(formatSkillActivation(outcome.result));
    },
  );

  server.tool(
    LIST_SKILLS_TOOL,
    'List the compact discovery manifest of installed skills. Prefer the manifest already in your context; call this only when you need a fresh list.',
    {},
    async () => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return reply(JSON.stringify({ status: 'refused', errorCode: 'NO_SESSION', message: 'no session context available' }), true);
      }
      if (deps.isChatOnly?.(ctx.sessionId) === true) {
        return reply(JSON.stringify({ status: 'refused', errorCode: 'PERMISSION_DENIED', message: 'Skill discovery is disabled in chat-only mode.' }), true);
      }
      const catalog = cache.get();
      if (!catalog) return reply(JSON.stringify({ status: 'refused', errorCode: 'PERMISSION_DENIED', message: 'Skill discovery is disabled.' }), true);
      return reply(
        JSON.stringify({
          totalSkills: catalog.totalSkills,
          estimatedDiscoveryTokens: catalog.estimatedDiscoveryTokens,
          manifest: renderDiscoveryManifest(catalog),
        }),
      );
    },
  );

  return server;
}

/** Hermes-only bridge provider; `toClaudeSdkConfig` binds the real per-session context. */
export function createCindySkillsMcpProvider(
  deps: Omit<CindySkillsMcpDeps, 'getSessionContext'>,
): McpProvider {
  return {
    name: CINDY_SKILLS_MCP_SERVER_NAME,
    capability: {
      title: 'Progressive Skills',
      description: 'Discover installed skills and load one skill\'s full instructions on demand.',
      source: 'harness',
      discovery: { tool: LIST_SKILLS_TOOL },
    },
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: CINDY_SKILLS_MCP_SERVER_NAME,
      instance: createCindySkillsMcpServer({
        ...deps,
        getSessionContext: () => ctx.getSessionContext?.() ?? ctx,
      }),
    }),
  };
}
