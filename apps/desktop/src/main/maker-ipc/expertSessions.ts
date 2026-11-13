/**
 * Expert ↔ session binding (ROADMAP 3.2a).
 *
 * The owner picks an expert on the new-task page; that choice is "pending" (in memory, visible
 * in the picker) until the next fresh Hermes session sends its first turn. At that moment the
 * pending expert is bound to that Cindy session in `~/.cindy-harness/expert-sessions.json`
 * (atomic temp+rename) and its prompt is prepended to the first turn, exactly like the daemon's
 * own first-turn preamble. A bound session keeps its expert for good, so the header can show it
 * after a restart; the expert's prompt itself always comes from its files.
 *
 * Fail closed (AGENTS.md §6.3): a bound expert that no longer loads, is not a Hermes expert, or
 * names a model route the session is not on refuses the send with a message saying what to fix.
 * Nothing here switches the model.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readExpertMemory, type MemoryTarget } from '@cindy/maker-core/expert-memory';
import { isToolAllowed, isMcpServerAllowed } from '@cindy/maker-core/expert-tools';
import { loadExpert, type Expert, type ExpertAgent } from '@cindy/maker-core/experts';
import { isImportedAgentId, type ImportedAgent, type ImportedAgentSource } from '@cindy/maker-core/imported-agents';

import { readImportedAgentById } from './importedAgents.js';

/** Expert slugs are directory names under the experts root; nothing else is accepted. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidExpertSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG.test(slug) && !slug.includes('..');
}

/** Roster ids: an expert slug or an imported-agent id (ROADMAP 12.1, one id space). */
function isRosterId(id: unknown): id is string {
  return isValidExpertSlug(id) || isImportedAgentId(id);
}

/** A pending pick older than this is ignored, so a forgotten pick never captures a later session. */
export const PENDING_EXPERT_TTL_MS = 30 * 60_000;

/** At most this much of memory.md (the newest part) rides the first turn (ROADMAP 3.4b). */
export const EXPERT_MEMORY_PREAMBLE_CHARS = 8000;

/** The one memory tool on cindy_experts (expertsMcpServer.ts); named here for the preamble. */
export const SAVE_EXPERT_MEMORY_TOOL_NAME = 'save_expert_memory';

export interface ExpertSessionBindingView {
  sessionId: string;
  slug: string;
  dir: string;
  /** Present when the expert loads. */
  name?: string;
  model?: string;
  /** Present when the bound expert no longer loads. */
  error?: string;
  /** The expert's built-in toolsets lock (ROADMAP 3.10); present only for a locked Hermes expert. */
  toolsets?: string[];
  /** ROADMAP 12.1: present when the session was started as an imported (foreign) agent. */
  imported?: { source: ImportedAgentSource; absolutePath: string };
}

interface BindingsFile {
  version: 1;
  sessions: Record<string, { slug: string; boundAt: string; projectDir?: string }>;
}

export interface ExpertSessionStoreOptions {
  /** Directory holding one sub-directory per expert. */
  rootDir: string;
  /** Binding file (production: ~/.cindy-harness/expert-sessions.json). */
  bindingsFile: string;
  now?: () => number;
  /** ROADMAP 12.1: resolve an imported-agent id against the foreign directories. */
  resolveImported?: (id: string, projectDir?: string | null) => ImportedAgent | null;
}

/** Model route check, injected so tests need no providers.yaml. */
export type RouteMatcher = (expertRoute: string, sessionModel: string) =>
  | { ok: true }
  | { ok: false; message: string };

export class ExpertSessionStore {
  private pending: { slug: string; at: number; projectDir?: string | null } | null = null;
  private readonly listeners = new Set<(event: ExpertSessionEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly opts: ExpertSessionStoreOptions) {
    this.now = opts.now ?? Date.now;
  }

  onChange(listener: (event: ExpertSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ExpertSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not break binding.
      }
    }
  }

  private pendingRecord(): { slug: string; at: number; projectDir?: string | null } | null {
    if (!this.pending) return null;
    if (this.now() - this.pending.at > PENDING_EXPERT_TTL_MS) {
      this.pending = null;
      return null;
    }
    return this.pending;
  }

  getPending(): string | null {
    return this.pendingRecord()?.slug ?? null;
  }

  setPending(slug: string | null, opts: { projectDir?: string | null } = {}): string | null {
    if (slug !== null && !isRosterId(slug)) throw new Error(`invalid expert "${String(slug)}"`);
    this.pending = slug === null ? null : { slug, at: this.now(), projectDir: opts.projectDir ?? null };
    this.emit({ type: 'pending', slug });
    return slug;
  }

  private readFile(): BindingsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.opts.bindingsFile, 'utf8')) as Partial<BindingsFile>;
      if (parsed && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
        return { version: 1, sessions: parsed.sessions };
      }
    } catch {
      // Missing or unreadable file: no bindings.
    }
    return { version: 1, sessions: {} };
  }

  private writeFile(data: BindingsFile): void {
    const dir = path.dirname(this.opts.bindingsFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.opts.bindingsFile)}.${process.pid}.${this.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.opts.bindingsFile);
  }

  getBoundSlug(sessionId: string): string | null {
    const slug = this.readFile().sessions[sessionId]?.slug;
    return isRosterId(slug) ? slug : null;
  }

  private bind(sessionId: string, slug: string, projectDir?: string | null): void {
    const data = this.readFile();
    data.sessions[sessionId] = {
      slug,
      boundAt: new Date(this.now()).toISOString(),
      ...(projectDir ? { projectDir } : {}),
    };
    this.writeFile(data);
    this.emit({ type: 'bound', sessionId, slug });
  }

  /**
   * Bind a session to an expert directly (ROADMAP 3.9a, ADR 0008): an Orca worker started as an
   * expert is bound right after it is created, before its first turn. The pending pick is untouched.
   */
  bindSession(sessionId: string, slug: string, opts: { projectDir?: string | null } = {}): void {
    if (!isRosterId(slug)) throw new Error(`invalid expert "${String(slug)}"`);
    this.bind(sessionId, slug, opts.projectDir ?? null);
  }

  /**
   * Whether an Orca worker can start as this expert (ROADMAP 3.9a): it must load and be a Hermes
   * expert. Returns its model route so the worker session is created on it.
   */
  checkWorkerExpert(slug: string): { ok: true; model?: string } | { ok: false; message: string } {
    if (isImportedAgentId(slug)) {
      return { ok: false, message: 'Imported agents cannot start as Orca workers yet; copy the agent to your experts first (ROADMAP 12.1).' };
    }
    if (!isValidExpertSlug(slug)) return { ok: false, message: `invalid expert "${String(slug)}"` };
    const dir = path.join(this.opts.rootDir, slug);
    const entry = loadExpert(dir);
    if (!entry.expert) {
      return { ok: false, message: `Expert "${slug}" cannot be loaded: ${entry.error ?? 'unknown error'} (${path.join(dir, 'expert.md')}).` };
    }
    if (entry.expert.agent !== 'hermes') {
      return { ok: false, message: `Expert "${entry.expert.name}" is set to agent "${entry.expert.agent}"; only hermes experts can be started as workers.` };
    }
    return entry.expert.model ? { ok: true, model: entry.expert.model } : { ok: true };
  }

  describeBinding(sessionId: string): ExpertSessionBindingView | null {
    const slug = this.getBoundSlug(sessionId);
    if (!slug) return null;
    if (isImportedAgentId(slug)) {
      const record = this.readFile().sessions[sessionId];
      const agent = this.opts.resolveImported?.(slug, record?.projectDir ?? null) ?? null;
      if (!agent) {
        return { sessionId, slug, dir: '', error: `imported agent "${slug}" is no longer available` };
      }
      return {
        sessionId,
        slug,
        dir: agent.absolutePath,
        name: agent.name,
        imported: { source: agent.source, absolutePath: agent.absolutePath },
        ...(agent.error ? { error: agent.error } : {}),
      };
    }
    const dir = path.join(this.opts.rootDir, slug);
    const entry = loadExpert(dir);
    return {
      sessionId,
      slug,
      dir,
      ...(entry.expert ? { name: entry.expert.name } : {}),
      ...(entry.expert?.model ? { model: entry.expert.model } : {}),
      ...(entry.expert?.agent === 'hermes' && entry.expert.toolsets ? { toolsets: [...entry.expert.toolsets] } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  /**
   * True when the session's expert is a loadable Hermes expert that permits `tool`
   * (ROADMAP 3.8, 3.2b). Checks `tools.yaml` if present, falling back to frontmatter `tools:`.
   * `includePending` also accepts the pending pick, for the tool list built when
   * a fresh session starts (before its first send binds it); tool calls check the binding only.
   */
  expertAllowsTool(sessionId: string, tool: string, opts: { includePending?: boolean } = {}): boolean {
    const slug = this.getBoundSlug(sessionId) ?? (opts.includePending ? this.getPending() : null);
    if (!slug) return false;
    // Imported agents grant no Cindy tools (ROADMAP 12.1): fail closed, like their drafts.
    if (isImportedAgentId(slug)) return false;
    const expert = loadExpert(path.join(this.opts.rootDir, slug)).expert;
    if (!expert || expert.agent !== 'hermes') return false;
    return isToolAllowed(tool, expert.toolsPolicy, expert.tools);
  }

  /**
   * True when the session's expert permits the given MCP server name (ROADMAP 3.2b, 4.3).
   * If the session is not an expert session, returns true (unrestricted).
   */
  expertAllowsMcpServer(sessionId: string, server: string, opts: { includePending?: boolean } = {}): boolean {
    const slug = this.getBoundSlug(sessionId) ?? (opts.includePending ? this.getPending() : null);
    if (!slug) return true;
    // An imported agent has no tools policy: unrestricted, like a plain session (12.1).
    if (isImportedAgentId(slug)) return true;
    const expert = loadExpert(path.join(this.opts.rootDir, slug)).expert;
    if (!expert || expert.agent !== 'hermes') return false;
    return isMcpServerAllowed(server, expert.toolsPolicy);
  }

  /**
   * True when the session's expert opts into vault notes tools (ROADMAP 5.1).
   * Supports `mcp_servers.allow: [cindy_vault_notes]`, scoped `tools.allow: [read_note, ...]`,
   * or frontmatter `tools: [read_note, ...]`. Explicit deny always wins.
   */
  expertAllowsVaultTool(sessionId: string, tool: string, opts: { includePending?: boolean } = {}): boolean {
    const slug = this.getBoundSlug(sessionId) ?? (opts.includePending ? this.getPending() : null);
    if (!slug) return false;
    if (isImportedAgentId(slug)) return false;
    const expert = loadExpert(path.join(this.opts.rootDir, slug)).expert;
    if (!expert || expert.agent !== 'hermes') return false;

    // Explicit deny always wins
    if (!isMcpServerAllowed('cindy_vault_notes', expert.toolsPolicy)) return false;
    if (expert.toolsPolicy?.tools?.deny?.includes(tool)) return false;

    // Strict tools.allow whitelist
    if (expert.toolsPolicy?.tools?.allow !== undefined) {
      return expert.toolsPolicy.tools.allow.includes(tool);
    }

    // Explicit mcp_servers.allow includes cindy_vault_notes
    if (expert.toolsPolicy?.mcpServers?.allow?.includes('cindy_vault_notes')) {
      return true;
    }

    // Fallback to frontmatter tools:
    if (expert.tools !== undefined) {
      return expert.tools.includes(tool) || expert.tools.includes('cindy_vault_notes');
    }

    return false;
  }

  /**
   * True when the session's expert has opted into any vault tool (ROADMAP 5.1).
   */
  sessionHasVaultAccess(sessionId: string, opts: { includePending?: boolean } = {}): boolean {
    const slug = this.getBoundSlug(sessionId) ?? (opts.includePending ? this.getPending() : null);
    if (!slug) return false;
    return (
      this.expertAllowsVaultTool(sessionId, 'read_note', opts) ||
      this.expertAllowsVaultTool(sessionId, 'search_notes', opts) ||
      this.expertAllowsVaultTool(sessionId, 'append_note', opts) ||
      this.expertAllowsVaultTool(sessionId, 'list_notes', opts) ||
      this.expertAllowsVaultTool(sessionId, 'synthesize_vault_memory', opts) ||
      this.expertAllowsVaultTool(sessionId, 'explore_vault_graph', opts) ||
      this.expertAllowsVaultTool(sessionId, 'quick_capture', opts) ||
      this.expertAllowsVaultTool(sessionId, 'pin_vault_note', opts) ||
      this.expertAllowsVaultTool(sessionId, 'unpin_vault_note', opts) ||
      this.expertAllowsVaultTool(sessionId, 'list_pinned_notes', opts) ||
      this.expertAllowsVaultTool(sessionId, 'sync_workspace_git_to_project_note', opts) ||
      this.expertAllowsVaultTool(sessionId, 'record_adr', opts) ||
      this.expertAllowsVaultTool(sessionId, 'query_adrs', opts)
    );
  }


  /**
   * Where `save_expert_memory` writes for this session (ROADMAP 3.4b): the folder of a loadable
   * Hermes expert with `memory: true`, else null. `includePending` as in `expertAllowsTool`.
   */
  expertMemoryTarget(sessionId: string, opts: { includePending?: boolean } = {}): MemoryTarget | null {
    const slug = this.getBoundSlug(sessionId) ?? (opts.includePending ? this.getPending() : null);
    if (!slug) return null;
    if (isImportedAgentId(slug)) return null;
    const expert = loadExpert(path.join(this.opts.rootDir, slug)).expert;
    return expert?.agent === 'hermes' && expert.memory ? { dir: expert.dir, memory: true } : null;
  }

  /** Experts root (~/.cindy-harness/experts in production). */
  get rootDir(): string {
    return this.opts.rootDir;
  }

  /**
   * The first-turn preamble for a fresh Hermes session, or null when the session has no expert.
   * Binds a pending pick to this session first. Throws (fails closed) when a bound expert cannot
   * be applied as written.
   */
  /**
   * The built-in toolsets lock (`toolsets:`) of the session's Hermes expert, or null for none
   * (ROADMAP 3.10). `includePending` as in `expertAllowsTool`. Throws when the expert cannot be
   * loaded, so a lock that might apply is never skipped.
   */
  expertToolsets(sessionId: string, opts: { includePending?: boolean } = {}): string[] | null {
    const slug = this.getBoundSlug(sessionId) ?? (opts.includePending ? this.getPending() : null);
    if (!slug) return null;
    // Imported agents carry no toolsets lock (ROADMAP 12.1).
    if (isImportedAgentId(slug)) return null;
    const dir = path.join(this.opts.rootDir, slug);
    const entry = loadExpert(dir);
    if (!entry.expert) {
      throw new Error(`Expert "${slug}" cannot be loaded: ${entry.error ?? 'unknown error'}. Fix ${path.join(dir, 'expert.md')} and start again.`);
    }
    return entry.expert.agent === 'hermes' ? entry.expert.toolsets ?? null : null;
  }

  /**
   * The expert skills directory (`skills/`) for this session, or null if the expert has no skills
   * (ROADMAP 3.2). `includePending` as in `expertAllowsTool`.
   */
  expertSkillsDir(sessionId: string, opts: { includePending?: boolean } = {}): string | null {
    const slug = this.getBoundSlug(sessionId) ?? (opts.includePending ? this.getPending() : null);
    if (!slug) return null;
    if (isImportedAgentId(slug)) return null;
    const dir = path.join(this.opts.rootDir, slug);
    const entry = loadExpert(dir);
    if (entry.expert && entry.expert.skillFiles.length > 0) {
      const skillsDir = path.join(dir, 'skills');
      return fs.existsSync(skillsDir) ? skillsDir : null;
    }
    return null;
  }

  resolveFirstTurnPreamble(
    input: { sessionId: string; model: string; agent?: string; toolsets?: string[] },
    matchRoute: RouteMatcher,
  ): string | null {
    let slug = this.getBoundSlug(input.sessionId);
    let projectDir: string | null = this.readFile().sessions[input.sessionId]?.projectDir ?? null;
    if (!slug) {
      const pending = this.pendingRecord();
      if (!pending) return null;
      this.pending = null;
      this.bind(input.sessionId, pending.slug, pending.projectDir ?? null);
      this.emit({ type: 'pending', slug: null });
      slug = pending.slug;
      projectDir = pending.projectDir ?? null;
    }
    if (isImportedAgentId(slug)) {
      return this.importedPreamble(slug, projectDir, input.agent ?? 'hermes');
    }
    const dir = path.join(this.opts.rootDir, slug);
    const entry = loadExpert(dir);
    if (!entry.expert) {
      throw new Error(`Expert "${slug}" cannot be loaded: ${entry.error ?? 'unknown error'}. Fix ${path.join(dir, 'expert.md')} and send again.`);
    }
    const expert = entry.expert;
    const expectedAgent = input.agent ?? 'hermes';
    if (expert.agent !== expectedAgent) {
      throw new Error(`Expert "${expert.name}" is set to agent "${expert.agent}", but this session is running on "${expectedAgent}".`);
    }
    if (expert.model) {
      const match = matchRoute(expert.model, input.model);
      if (!match.ok) throw new Error(`Expert "${expert.name}": ${match.message}`);
    }
    // The lock is applied when the session starts; an expert picked or edited after that must
    // not run with other tools than it declares (ROADMAP 3.10).
    if (expert.agent === 'hermes') {
      const want = [...(expert.toolsets ?? [])].sort().join(',');
      const have = [...(input.toolsets ?? [])].sort().join(',');
      if (want !== have) {
        throw new Error(`Expert "${expert.name}" locks this chat to toolsets [${want || 'none'}], but the chat started with [${have || 'none'}]. Start a new chat with the expert picked first.`);
      }
    }
    const memory = expert.memory ? readExpertMemory(expert, { maxChars: EXPERT_MEMORY_PREAMBLE_CHARS }) : undefined;
    return buildExpertPreamble(expert, memory);
  }

  /**
   * ROADMAP 12.1: an imported agent's prompt rides the first turn exactly like an expert's.
   * Fail closed: a missing file or an adapter the agent cannot run on refuses the send.
   * No model check (a foreign `model:` is never mapped), no toolsets lock, no memory.
   */
  private importedPreamble(id: string, projectDir: string | null, expectedAgent: string): string {
    const agent = this.opts.resolveImported?.(id, projectDir) ?? null;
    if (!agent) {
      throw new Error(`Imported agent "${id}" is no longer available. Pick another agent and send again.`);
    }
    if (agent.error) {
      throw new Error(`Imported agent "${agent.name}" cannot be applied: ${agent.error}`);
    }
    if (!agent.runsOn.includes(expectedAgent as ExpertAgent)) {
      const blocked = agent.blockedTools?.length ? ` Tools that block it: ${agent.blockedTools.join(', ')}.` : '';
      throw new Error(`Imported agent "${agent.name}" cannot run on "${expectedAgent}".${blocked} Pick an agent that supports this program, or copy it to your experts and adjust it.`);
    }
    return buildExpertPreamble({ name: agent.name, prompt: agent.prompt });
  }
}

export type ExpertSessionEvent =
  | { type: 'pending'; slug: string | null }
  | { type: 'bound'; sessionId: string; slug: string };

/**
 * The text Hermes receives ahead of the first message. New prompt text for a new feature.
 * `memory` (ROADMAP 3.4b) is passed only for an expert with `memory: true`: its saved notes and
 * how to add one.
 */
export function buildExpertPreamble(
  expert: Pick<Expert, 'name' | 'prompt'>,
  memory?: { text: string; truncated: boolean },
): string {
  const memoryBlock = memory
    ? [
        '',
        '[Your memory: notes saved in earlier sessions as this expert, oldest first. The owner can read and edit them.]',
        ...(memory.truncated ? ['(older notes were left out)'] : []),
        memory.text.trim() || '(no notes yet)',
        `[End of memory. When you learn something worth keeping for later sessions (a preference, a decision, a fact about the work), call the ${SAVE_EXPERT_MEMORY_TOOL_NAME} tool with one short note. Never save secrets.]`,
      ]
    : [];
  return [
    `[Cindy expert: ${expert.name}]`,
    'For this whole session, act as the expert described below.',
    '',
    expert.prompt.trim(),
    ...memoryBlock,
    '',
    '[End of expert instructions. The owner\'s first message follows.]',
  ].join('\n');
}

/**
 * Production route check: the expert's `model` (a routing.yaml route name, or a model id) and the
 * session model must resolve to the same model on the same endpoint. No switching: on a mismatch
 * the owner picks the model shown in the message.
 */
export function createRouteMatcher(
  resolve: (model: string) => { model: string; baseUrl: string; providerId?: string } | null,
): RouteMatcher {
  return (expertRoute, sessionModel) => {
    const want = resolve(expertRoute);
    if (!want) {
      return {
        ok: false,
        message: `model route "${expertRoute}" is not in ~/.cindy-harness/routing.yaml or providers.yaml. Add the route, or remove "model:" from expert.md.`,
      };
    }
    const have = resolve(sessionModel);
    if (have && have.model === want.model && have.baseUrl === want.baseUrl) return { ok: true };
    const where = want.providerId ? `${want.providerId}/${want.model}` : want.model;
    return {
      ok: false,
      message: `this expert runs on route "${expertRoute}" (${where}), but the session is on "${sessionModel}". Pick ${want.model} in the model menu and send again.`,
    };
  };
}

let desktopStore: ExpertSessionStore | undefined;

/** The one store the IPC handlers and the Hermes first-turn hook share (~/.cindy-harness). */
export function getDesktopExpertSessionStore(): ExpertSessionStore {
  desktopStore ??= new ExpertSessionStore({
    rootDir: path.join(os.homedir(), '.cindy-harness', 'experts'),
    bindingsFile: path.join(os.homedir(), '.cindy-harness', 'expert-sessions.json'),
    resolveImported: (id, projectDir) => readImportedAgentById(id, { homeDir: os.homedir(), projectDir: projectDir ?? null }),
  });
  return desktopStore;
}
