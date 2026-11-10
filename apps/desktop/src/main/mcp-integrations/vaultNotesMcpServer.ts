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

import * as os from 'node:os';
import * as path from 'node:path';

import type { McpProvider } from '@cindy/maker-core';
import {
  appendNote,
  listNotes,
  readNote,
  searchNotes,
} from '@cindy/maker-core/vault-notes';
import { hybridSearchVault, type VaultSemanticIndex } from '@cindy/maker-core/vault-semantic';
import { runVaultSynthesis } from '@cindy/maker-core/vault-synthesis';
import { scanVaultGraph } from '@cindy/maker-core/vault-graph';
import {
  quickCaptureNote,
  pinNoteToSession,
  unpinNoteFromSession,
  getPinnedNotesForSession,
} from '@cindy/maker-core/vault-capture';
import { listArtifacts, saveArtifact } from '@cindy/maker-core/artifact-store';
import { ingestDocument } from '@cindy/maker-core/document-ingestion';
import { saveLiteratureNote } from '@cindy/maker-core/deep-research-synthesis';
import { resolveLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

export const CINDY_VAULT_NOTES_MCP_SERVER_NAME = 'cindy_vault_notes';
export const READ_NOTE_TOOL = 'read_note';
export const SEARCH_NOTES_TOOL = 'search_notes';
export const APPEND_NOTE_TOOL = 'append_note';
export const LIST_NOTES_TOOL = 'list_notes';
export const SYNTHESIZE_VAULT_MEMORY_TOOL = 'synthesize_vault_memory';
export const EXPLORE_VAULT_GRAPH_TOOL = 'explore_vault_graph';
export const QUICK_CAPTURE_TOOL = 'quick_capture';
export const PIN_VAULT_NOTE_TOOL = 'pin_vault_note';
export const UNPIN_VAULT_NOTE_TOOL = 'unpin_vault_note';
export const LIST_PINNED_NOTES_TOOL = 'list_pinned_notes';
export const SYNC_WORKSPACE_GIT_TOOL = 'sync_workspace_git_to_project_note';
export const SAVE_ARTIFACT_TOOL = 'save_artifact';
export const LIST_ARTIFACTS_TOOL = 'list_artifacts';
export const PARSE_LOCAL_DOCUMENT_TOOL = 'parse_local_document';
export const SAVE_RESEARCH_SYNTHESIS_TOOL = 'save_research_synthesis';

export const VAULT_NOTES_TOOLS = [
  READ_NOTE_TOOL,
  SEARCH_NOTES_TOOL,
  APPEND_NOTE_TOOL,
  LIST_NOTES_TOOL,
  SYNTHESIZE_VAULT_MEMORY_TOOL,
  EXPLORE_VAULT_GRAPH_TOOL,
  QUICK_CAPTURE_TOOL,
  PIN_VAULT_NOTE_TOOL,
  UNPIN_VAULT_NOTE_TOOL,
  LIST_PINNED_NOTES_TOOL,
  SYNC_WORKSPACE_GIT_TOOL,
  SAVE_ARTIFACT_TOOL,
  LIST_ARTIFACTS_TOOL,
  PARSE_LOCAL_DOCUMENT_TOOL,
  SAVE_RESEARCH_SYNTHESIS_TOOL,
] as const;

export function defaultPinnedNotesConfigFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'pinned-vault-notes.json');
}

export interface VaultNotesMcpDeps {
  getSessionContext(): Pick<LiziMcpSessionContext, 'agentKind' | 'sessionId'> | undefined;
  /** Returns the configured vault directory, or empty/null if unconfigured. */
  getVaultDir(): string | null | undefined;
  /** True when the session's expert is allowed to use this tool (ROADMAP 5.1). */
  sessionMayUse(sessionId: string, tool: string): boolean;
  /** File path to pinned notes config. */
  pinnedNotesConfigFile?: string;
  /** Semantic embedding index provider for hybrid search (ROADMAP 7.3). */
  getSemanticIndex?: () => VaultSemanticIndex | null;
  /** Sync workspace git progress to project note (ROADMAP 7.4). */
  syncWorkspaceGit?: (opts: {
    workspaceDir?: string;
    targetNotePath?: string;
    summaryNote?: string;
  }) => Promise<{ ok: boolean; path?: string; created?: boolean; block?: string; error?: string }>;
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
      const semanticIndex = deps.getSemanticIndex ? deps.getSemanticIndex() : null;
      const res = await hybridSearchVault(vaultDir, query, semanticIndex, { limit });
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

  server.tool(
    QUICK_CAPTURE_TOOL,
    'Quick-capture a thought, snippet, or finding into a markdown note in the notes vault (default "Inbox.md").',
    {
      content: z.string().describe('The content or note text to capture'),
      targetFile: z.string().optional().describe('Target markdown note path relative to vault (defaults to "Inbox.md")'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization (e.g. ["todo", "perf"])'),
      title: z.string().optional().describe('Optional title for the captured entry'),
    },
    async ({ content, targetFile, tags, title }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, QUICK_CAPTURE_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${QUICK_CAPTURE_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      const res = quickCaptureNote(vaultDir, {
        content,
        targetFile,
        tags,
        title,
        sourceSessionId: ctx.sessionId,
      });
      if (!res.ok) {
        return refused({ code: res.reason.toUpperCase(), message: res.message });
      }
      return reply(res);
    },
  );

  server.tool(
    PIN_VAULT_NOTE_TOOL,
    'Pin a vault note as persistent reference context for the current session.',
    {
      path: z.string().describe('Relative path to .md note inside the vault to pin (e.g. "docs/spec.md")'),
    },
    async ({ path: notePath }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, PIN_VAULT_NOTE_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${PIN_VAULT_NOTE_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured' });
      }
      const configFile = deps.pinnedNotesConfigFile ?? defaultPinnedNotesConfigFile();
      const res = pinNoteToSession(configFile, ctx.sessionId, notePath);
      if (!res.ok) {
        return refused({ code: 'PIN_FAILED', message: res.error ?? 'failed to pin note' });
      }
      return reply({ pinned: true, notePath, pinnedNotes: res.pinnedNotes });
    },
  );

  server.tool(
    UNPIN_VAULT_NOTE_TOOL,
    'Unpin a vault note from the current session.',
    {
      path: z.string().describe('Relative path to .md note inside the vault to unpin'),
    },
    async ({ path: notePath }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, UNPIN_VAULT_NOTE_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${UNPIN_VAULT_NOTE_TOOL}"` });
      }
      const configFile = deps.pinnedNotesConfigFile ?? defaultPinnedNotesConfigFile();
      const res = unpinNoteFromSession(configFile, ctx.sessionId, notePath);
      return reply({ unpinned: true, notePath, pinnedNotes: res.pinnedNotes });
    },
  );

  server.tool(
    LIST_PINNED_NOTES_TOOL,
    'List all vault notes currently pinned to this session.',
    {},
    async () => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, LIST_PINNED_NOTES_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${LIST_PINNED_NOTES_TOOL}"` });
      }
      const configFile = deps.pinnedNotesConfigFile ?? defaultPinnedNotesConfigFile();
      const pinned = getPinnedNotesForSession(configFile, ctx.sessionId);
      return reply({ count: pinned.length, pinnedNotes: pinned });
    },
  );

  server.tool(
    SYNC_WORKSPACE_GIT_TOOL,
    'Inspect the active workspace git status (commits, modified/untracked files) and append a formatted progress section into the matching vault project note (e.g. memory/Project — <Name>.md).',
    {
      workspaceDir: z.string().optional().describe('Workspace directory to inspect (defaults to current working directory)'),
      targetNote: z.string().optional().describe('Optional relative path of target project note in vault'),
      summary: z.string().optional().describe('Optional summary or milestone progress note to append'),
    },
    async ({ workspaceDir, targetNote, summary }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, SYNC_WORKSPACE_GIT_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${SYNC_WORKSPACE_GIT_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      if (!deps.syncWorkspaceGit) {
        return refused({ code: 'NOT_SUPPORTED', message: 'workspace git sync is not available in this environment' });
      }
      const res = await deps.syncWorkspaceGit({
        workspaceDir,
        targetNotePath: targetNote,
        summaryNote: summary,
      });
      if (!res.ok) {
        return refused({ code: 'SYNC_FAILED', message: res.error ?? 'failed to sync workspace git to project note' });
      }
      return reply({
        synced: true,
        path: res.path,
        created: res.created,
        block: res.block,
      });
    },
  );

  server.tool(
    SAVE_ARTIFACT_TOOL,
    'Save an artifact (e.g. code snippet, architecture diagram, schema, specification) into the vault artifact store at Cindy/Artifacts/<id>.md.',
    {
      title: z.string().describe('Title of the artifact'),
      content: z.string().describe('Markdown or plain text content of the artifact'),
      type: z.string().optional().describe('Artifact type, e.g. diagram, code, schema, document'),
      tags: z.array(z.string()).optional().describe('Optional tags for indexing and discovery'),
      id: z.string().optional().describe('Optional slug or identifier'),
    },
    async ({ title, content, type, tags, id }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, SAVE_ARTIFACT_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${SAVE_ARTIFACT_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      try {
        const artifact = saveArtifact(vaultDir, {
          title,
          content,
          type,
          tags,
          id,
          sessionId: ctx.sessionId,
        });
        return reply({
          saved: true,
          artifact,
        });
      } catch (err) {
        return refused({
          code: 'SAVE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  server.tool(
    LIST_ARTIFACTS_TOOL,
    'List all stored artifacts in the vault artifact store (Cindy/Artifacts/).',
    {
      limit: z.number().optional().describe('Maximum number of artifacts to return'),
    },
    async ({ limit }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, LIST_ARTIFACTS_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${LIST_ARTIFACTS_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured' });
      }
      try {
        let artifacts = listArtifacts(vaultDir);
        if (typeof limit === 'number' && limit > 0) {
          artifacts = artifacts.slice(0, limit);
        }
        return reply({
          artifacts,
          count: artifacts.length,
        });
      } catch (err) {
        return refused({
          code: 'LIST_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  server.tool(
    PARSE_LOCAL_DOCUMENT_TOOL,
    'Extract, parse, and analyze local documents (PDF, CSV, TSV, Markdown, plain text) for research synthesis.',
    {
      path: z.string().describe('Absolute or relative file path to the document to parse'),
      maxPages: z.number().optional().describe('Maximum number of PDF pages to extract (default: 50)'),
      maxChars: z.number().optional().describe('Maximum characters of text to return (default: 30000)'),
      includeChunks: z.boolean().optional().describe('Whether to return extracted semantic text chunks (default: false)'),
    },
    async ({ path: docPath, maxPages, maxChars, includeChunks }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, PARSE_LOCAL_DOCUMENT_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${PARSE_LOCAL_DOCUMENT_TOOL}"` });
      }
      try {
        const doc = await ingestDocument(docPath, { maxPages, maxChars, includeChunks });
        return reply({
          success: true,
          document: doc,
        });
      } catch (err) {
        return refused({
          code: 'PARSE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  server.tool(
    SAVE_RESEARCH_SYNTHESIS_TOOL,
    'Assemble and save a multi-source deep research synthesis as a structured literature note with citations in the vault.',
    {
      title: z.string().describe('Title of the research topic or literature note'),
      topic: z.string().optional().describe('Broader subject area or domain'),
      summary: z.string().describe('Executive summary synthesizing key takeaways'),
      findings: z
        .array(
          z.object({
            statement: z.string().describe('Key finding statement'),
            detail: z.string().optional().describe('Additional context or quantitative findings'),
            sourceIds: z.array(z.string()).optional().describe('IDs or URLs of supporting sources'),
            confidence: z.enum(['high', 'medium', 'unverified']).optional().describe('Finding confidence'),
          }),
        )
        .describe('Key findings with source attribution'),
      sources: z
        .array(
          z.object({
            id: z.string().optional().describe('Optional source identifier (e.g. s1, arxiv-1)'),
            title: z.string().describe('Source title or headline'),
            url: z.string().optional().describe('Source URL (if web source)'),
            filePath: z.string().optional().describe('Source file path (if local document)'),
            sourceType: z.enum(['academic', 'documentation', 'news', 'reference', 'local_document']).optional(),
            author: z.string().optional().describe('Author or publishing entity'),
            publishedDate: z.string().optional().describe('Publication date or year'),
            keyTakeaway: z.string().optional().describe('Core conclusion drawn from source'),
          }),
        )
        .describe('Sources referenced in the research synthesis'),
      localDocumentAnalysis: z
        .object({
          documentTitle: z.string(),
          documentPath: z.string(),
          highlights: z.array(z.string()),
        })
        .optional()
        .describe('Optional extracted insights from a local document'),
      tags: z.array(z.string()).optional().describe('Tags for literature note indexing'),
      targetFolder: z.string().optional().describe('Target folder in vault (default: Cindy/Research)'),
      fileName: z.string().optional().describe('Custom file name (.md)'),
    },
    async ({ title, topic, summary, findings, sources, localDocumentAnalysis, tags, targetFolder, fileName }) => {
      const ctx = deps.getSessionContext();
      if (!ctx?.sessionId) {
        return refused({ code: 'NO_SESSION', message: 'no session context available' });
      }
      if (!deps.sessionMayUse(ctx.sessionId, SAVE_RESEARCH_SYNTHESIS_TOOL)) {
        return refused({ code: 'FORBIDDEN', message: `expert does not permit tool "${SAVE_RESEARCH_SYNTHESIS_TOOL}"` });
      }
      const vaultDir = deps.getVaultDir()?.trim();
      if (!vaultDir) {
        return refused({ code: 'NO_VAULT', message: 'no notes vault configured; configure a vault folder in Settings -> Notes Vault' });
      }
      try {
        const result = saveLiteratureNote(
          vaultDir,
          {
            title,
            topic,
            summary,
            findings,
            sources,
            localDocumentAnalysis,
            tags,
            sessionId: ctx.sessionId,
          },
          {
            targetFolder,
            fileName,
          },
        );
        if (!result.ok) {
          return refused({
            code: result.reason.toUpperCase(),
            message: result.message,
          });
        }
        return reply({
          saved: true,
          relPath: result.relPath,
          fullPath: result.fullPath,
          citationCount: result.citationCount,
          sourceCount: result.sourceCount,
          bytesWritten: result.bytesWritten,
        });
      } catch (err) {
        return refused({
          code: 'SAVE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
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
