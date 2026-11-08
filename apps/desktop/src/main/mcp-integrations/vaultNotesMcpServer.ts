/**
 * cindy_vault_notes — local notes vault bridge (ROADMAP 5.1).
 *
 * Exposes tools to read, search, append, and list notes inside a configured local notes vault
 * (Obsidian-style Markdown vault). Every path is relative, .md only, and kept strictly inside
 * the vault by @cindy/maker-core/vault-notes.
 *
 * Tool access requires an expert opt-in via tools.yaml (mcp_servers.allow / tools.allow) or
 * frontmatter tools:. Every tool call re-checks that permission and fails closed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpProvider } from '@cindy/maker-core';
import {
  appendNote,
  listNotes,
  readNote,
  searchNotes,
} from '@cindy/maker-core/vault-notes';
import { runVaultSynthesis } from '@cindy/maker-core/vault-synthesis';
import { scanVaultGraph } from '@cindy/maker-core/vault-graph';
import { resolveLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

export const CINDY_VAULT_NOTES_MCP_SERVER_NAME = 'cindy_vault_notes';
export const READ_NOTE_TOOL = 'read_note';
export const SEARCH_NOTES_TOOL = 'search_notes';
export const APPEND_NOTE_TOOL = 'append_note';
export const LIST_NOTES_TOOL = 'list_notes';
export const SYNTHESIZE_VAULT_MEMORY_TOOL = 'synthesize_vault_memory';
export const EXPLORE_VAULT_GRAPH_TOOL = 'explore_vault_graph';

export const VAULT_NOTES_TOOLS = [
  READ_NOTE_TOOL,
  SEARCH_NOTES_TOOL,
  APPEND_NOTE_TOOL,
  LIST_NOTES_TOOL,
  SYNTHESIZE_VAULT_MEMORY_TOOL,
  EXPLORE_VAULT_GRAPH_TOOL,
] as const;

export interface VaultNotesMcpDeps {
  getSessionContext(): Pick<LiziMcpSessionContext, 'agentKind' | 'sessionId'> | undefined;
  /** Returns the configured vault directory, or empty/null if unconfigured. */
  getVaultDir(): string | null | undefined;
  /** True when the session's expert is allowed to use this tool (ROADMAP 5.1). */
  sessionMayUse(sessionId: string, tool: string): boolean;
}

type Refusal = { code: string; message: string };

function reply(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function refused(r: Refusal) {
  return reply({ status: 'refused', errorCode: r.code, message: r.message }, true);
}

export function createVaultNotesMcpServer(deps: VaultNotesMcpDeps): McpServer {
  const server = new McpServer({ name: CINDY_VAULT_NOTES_MCP_SERVER_NAME, version: '1.0.0' });

  server.tool(
    READ_NOTE_TOOL,
    'Read a markdown note from the local notes vault. Paths must be relative to the vault and end in .md.',
    {
      path: z.string().describe('Relative path to .md note inside the vault (e.g. "todo.md" or "projects/spec.md")'),
      maxChars: z.number().int().positive().optional().describe('Maximum number of characters to read'),
    },
    async ({ path: notePath, maxChars }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, READ_NOTE_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${READ_NOTE_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      const res = readNote(vaultDir, notePath, { maxChars });
      if (!res.ok) {
        return refused({ code: res.reason.toUpperCase(), message: res.message });
      }
      return reply(res);
    },
  );

  server.tool(
    SEARCH_NOTES_TOOL,
    'Search notes in the local notes vault for keywords. All terms must match. Returns ranked hits with snippets.',
    {
      query: z.string().describe('Search query string (case-insensitive; all whitespace-separated words must match)'),
      limit: z.number().int().positive().optional().describe('Maximum number of matching notes to return'),
    },
    async ({ query, limit }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, SEARCH_NOTES_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${SEARCH_NOTES_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      const res = searchNotes(vaultDir, query, { limit });
      if (!Array.isArray(res)) {
        return refused({ code: res.reason.toUpperCase(), message: res.message });
      }
      return reply({ hits: res, count: res.length });
    },
  );

  server.tool(
    APPEND_NOTE_TOOL,
    'Append a dated entry (## <ISO timestamp> + body) to a note in the local notes vault. Preserves existing content and redacts secrets.',
    {
      path: z.string().describe('Relative path to .md note inside the vault (creates if missing)'),
      text: z.string().describe('Note text to append as a new dated section'),
    },
    async ({ path: notePath, text }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, APPEND_NOTE_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${APPEND_NOTE_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      const res = appendNote(vaultDir, notePath, text);
      if (!res.ok) {
        return refused({ code: res.reason.toUpperCase(), message: res.message });
      }
      return reply(res);
    },
  );

  server.tool(
    LIST_NOTES_TOOL,
    'List notes in the local notes vault, ordered by most recently modified.',
    {
      limit: z.number().int().positive().optional().describe('Maximum number of notes to return'),
    },
    async ({ limit }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, LIST_NOTES_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${LIST_NOTES_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      const res = listNotes(vaultDir, { limit });
      if (!Array.isArray(res)) {
        return refused({ code: res.reason.toUpperCase(), message: res.message });
      }
      return reply({ notes: res, count: res.length });
    },
  );

  server.tool(
    SYNTHESIZE_VAULT_MEMORY_TOOL,
    'Synthesize cross-session memory from all conversation summaries in the vault into Cindy/Memory/Synthesis.md. Consolidates key decisions, facts, open questions, and indexes all past sessions.',
    {
      limit: z.number().int().positive().optional().describe('Maximum number of recent summaries to include (default: 20)'),
      targetFile: z.string().optional().describe('Relative path for output markdown (default: "Cindy/Memory/Synthesis.md")'),
    },
    async ({ limit, targetFile }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, SYNTHESIZE_VAULT_MEMORY_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${SYNTHESIZE_VAULT_MEMORY_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      const res = runVaultSynthesis(vaultDir, { limit, targetFile });
      if (!res.ok) {
        return refused({ code: res.reason.toUpperCase(), message: res.message });
      }
      return reply({ ...res });
    },
  );

  server.tool(
    EXPLORE_VAULT_GRAPH_TOOL,
    'Explores vault tags, note connections, and backlinks across notes in the vault.',
    {
      tag: z.string().optional().describe('Filter notes by tag (e.g. "summary", "orca", "cindy")'),
      notePath: z.string().optional().describe('Inspect connections and backlinks for a specific relative note path (e.g. "Cindy/Memory/Synthesis.md")'),
    },
    async ({ tag, notePath }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, EXPLORE_VAULT_GRAPH_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${EXPLORE_VAULT_GRAPH_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }

      const graph = scanVaultGraph(vaultDir);

      if (notePath) {
        const cleanPath = notePath.trim().replace(/^\/+/, '');
        const node = graph.nodes[cleanPath];
        if (!node) {
          return reply({
            found: false,
            message: `Note not found in graph: ${cleanPath}`,
            totalNotes: graph.totalNotes,
          });
        }
        return reply({
          found: true,
          node,
          backlinks: graph.backlinks[cleanPath] ?? [],
        });
      }

      if (tag) {
        const cleanTag = tag.trim().replace(/^#+/, '').toLowerCase();
        const matchingNotes = graph.tags[cleanTag] ?? [];
        return reply({
          tag: cleanTag,
          count: matchingNotes.length,
          notes: matchingNotes.map((p) => ({
            path: p,
            title: graph.nodes[p]?.title ?? p,
          })),
        });
      }

      // Neither specified: return high-level tag summary
      const topTags = Object.entries(graph.tags)
        .map(([t, arr]) => ({ tag: t, count: arr.length }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30);

      return reply({
        totalNotes: graph.totalNotes,
        totalTags: Object.keys(graph.tags).length,
        topTags,
      });
    },
  );

  return server;
}

export function createVaultNotesMcpProvider(
  deps: Omit<VaultNotesMcpDeps, 'getSessionContext'>,
): McpProvider {
  return {
    name: CINDY_VAULT_NOTES_MCP_SERVER_NAME,
    toClaudeSdkConfig: (ctx) => {
      const instance = createVaultNotesMcpServer({
        ...deps,
        getSessionContext: () => resolveLiziMcpSessionContext(ctx as LiziMcpSessionContext),
      });
      return {
        type: 'sdk',
        name: CINDY_VAULT_NOTES_MCP_SERVER_NAME,
        instance,
      };
    },
  };
}
