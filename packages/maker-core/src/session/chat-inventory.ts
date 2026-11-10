/**
 * Chat Inventory & Session Audit Panel (ROADMAP 8.8).
 *
 * Aggregates all live session resources:
 * - Active skills attached or referenced in this session
 * - Tools invoked across turns with execution counts and categories
 * - Files read, modified, or created
 * - Connectors and MCP servers accessed
 * - Token usage breakdown and context window utilization
 *
 * Pure model. Zero Electron dependencies, zero network, zero clock.
 * Satisfies AGENTS.md §6 ("no hidden state").
 */

export interface ChatInventoryToolItem {
  name: string;
  count: number;
  category: 'file' | 'command' | 'mcp' | 'agent' | 'other';
  serverName?: string;
}

export interface ChatInventoryFileItem {
  path: string;
  name: string;
  action: 'read' | 'modified' | 'created';
  count: number;
}

export interface ChatInventoryTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  utilizationPercent: number;
}

export interface ChatInventory {
  sessionId: string;
  tools: ChatInventoryToolItem[];
  files: ChatInventoryFileItem[];
  skills: string[];
  connectors: string[];
  tokens: ChatInventoryTokenUsage;
  summary: {
    totalToolCalls: number;
    totalFilesTouched: number;
    totalMessages: number;
    turnCount: number;
  };
}

export interface InventoryMessageInput {
  role: string;
  content?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  toolCalls?: Array<{ name: string; input?: unknown }>;
  tokens?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface InventorySessionInput {
  id: string;
  contextWindow?: number;
  model?: string;
  expertSlug?: string;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

function categorizeTool(name: string): { category: ChatInventoryToolItem['category']; serverName?: string } {
  if (name.startsWith('mcp__') || name.startsWith('mcp:')) {
    const parts = name.replace(/^mcp[:_]+/, '').split(/[:_]+/);
    const serverName = parts.length > 1 ? parts[0] : 'mcp';
    return { category: 'mcp', serverName };
  }
  if (/^(read_file|read|view|list_dir|glob|grep|find|search)/i.test(name)) {
    return { category: 'file' };
  }
  if (/^(write_file|write|create_file|edit_file|replace|patch|append_file)/i.test(name)) {
    return { category: 'file' };
  }
  if (/^(bash|terminal|exec|command|run_command|sh|zsh)/i.test(name)) {
    return { category: 'command' };
  }
  if (/^(subagent|start_worker|fork|switch_expert|handoff)/i.test(name)) {
    return { category: 'agent' };
  }
  return { category: 'other' };
}

function extractFilePathFromToolInput(input: unknown): { path: string; action: 'read' | 'modified' | 'created' } | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  const candidate = (
    obj.filePath ||
    obj.targetFile ||
    obj.path ||
    obj.file ||
    obj.filename ||
    obj.absolutePath
  );

  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const p = candidate.trim().replace(/^file:\/\//, '');

  if (obj.replacementContent || obj.patch || obj.edits) {
    return { path: p, action: 'modified' };
  }
  if (obj.codeContent || obj.content || obj.overwrite) {
    return { path: p, action: 'created' };
  }
  return { path: p, action: 'read' };
}

const FILE_REGEX = /(?:^|\s|["'`])([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9_-]{1,10})(?::\d+)?(?:["'`]|\s|$)/g;

/**
 * Aggregates live session resources into a clean, audited ChatInventory.
 */
export function aggregateChatInventory(
  session: InventorySessionInput,
  messages: readonly InventoryMessageInput[],
): ChatInventory {
  const toolCounts = new Map<string, number>();
  const fileActions = new Map<string, { action: 'read' | 'modified' | 'created'; count: number }>();
  const skillsSet = new Set<string>();
  const connectorsSet = new Set<string>();

  let promptTokens = session.promptTokens || 0;
  let completionTokens = session.completionTokens || 0;
  let totalToolCalls = 0;
  let turnCount = 0;

  for (const msg of messages) {
    if (msg.role === 'user') turnCount += 1;

    // Tokens
    if (msg.tokens) {
      if (typeof msg.tokens.prompt === 'number') promptTokens += msg.tokens.prompt;
      if (typeof msg.tokens.completion === 'number') completionTokens += msg.tokens.completion;
    } else if (msg.usage) {
      if (typeof msg.usage.input_tokens === 'number') promptTokens += msg.usage.input_tokens;
      if (typeof msg.usage.output_tokens === 'number') completionTokens += msg.usage.output_tokens;
    }

    const text = msg.content || msg.text || '';

    // Skills detection from turn-scoped `@skill:` or `@<slug>`
    if (text) {
      const skillMatches = text.matchAll(/@skill:([a-zA-Z0-9_\-./]+)/gi);
      for (const sm of skillMatches) {
        if (sm[1]) skillsSet.add(sm[1]);
      }
    }

    // Tools aggregation
    const calls: Array<{ name: string; input?: unknown }> = [];
    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      calls.push(...msg.toolCalls);
    } else if (msg.toolName) {
      calls.push({ name: msg.toolName, input: msg.toolInput });
    }

    for (const call of calls) {
      if (!call.name) continue;
      totalToolCalls += 1;
      const count = (toolCounts.get(call.name) || 0) + 1;
      toolCounts.set(call.name, count);

      const { category, serverName } = categorizeTool(call.name);
      if (serverName) connectorsSet.add(serverName);

      // Extract file from toolInput
      const fileInfo = extractFilePathFromToolInput(call.input);
      if (fileInfo) {
        const existing = fileActions.get(fileInfo.path);
        const actionPriority: Record<string, number> = { read: 1, modified: 2, created: 3 };
        const action = !existing || actionPriority[fileInfo.action] > actionPriority[existing.action]
          ? fileInfo.action
          : existing.action;

        fileActions.set(fileInfo.path, {
          action,
          count: (existing?.count || 0) + 1,
        });
      }
    }

    // Heuristic file mention fallback if few tool calls
    if (text && calls.length === 0) {
      const matches = text.matchAll(FILE_REGEX);
      for (const m of matches) {
        const f = m[1]?.trim();
        if (
          f &&
          !f.startsWith('http') &&
          !f.includes('node_modules') &&
          !f.startsWith('.') &&
          f.length >= 3 &&
          !fileActions.has(f)
        ) {
          // Detect read vs created from text context
          const isWrite = /\b(?:created|written|saved|modified|updated)\b/i.test(text);
          fileActions.set(f, {
            action: isWrite ? 'created' : 'read',
            count: 1,
          });
        }
      }
    }
  }

  // Format tools list
  const tools: ChatInventoryToolItem[] = Array.from(toolCounts.entries())
    .map(([name, count]) => {
      const { category, serverName } = categorizeTool(name);
      return { name, count, category, serverName };
    })
    .sort((a, b) => b.count - a.count);

  // Format files list
  const files: ChatInventoryFileItem[] = Array.from(fileActions.entries())
    .map(([p, info]) => {
      const name = p.split('/').pop() || p;
      return {
        path: p,
        name,
        action: info.action,
        count: info.count,
      };
    })
    .sort((a, b) => {
      const priority = { created: 3, modified: 2, read: 1 };
      return priority[b.action] - priority[a.action] || b.count - a.count;
    });

  const totalTokens = promptTokens + completionTokens || session.totalTokens || 0;
  const contextWindow = session.contextWindow || 200_000;
  const utilizationPercent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));

  return {
    sessionId: session.id,
    tools,
    files,
    skills: Array.from(skillsSet).sort(),
    connectors: Array.from(connectorsSet).sort(),
    tokens: {
      promptTokens,
      completionTokens,
      totalTokens,
      contextWindow,
      utilizationPercent,
    },
    summary: {
      totalToolCalls,
      totalFilesTouched: files.length,
      totalMessages: messages.length,
      turnCount,
    },
  };
}
