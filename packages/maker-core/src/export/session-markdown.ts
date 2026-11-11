/**
 * Session export to Markdown (ROADMAP 5.2a).
 *
 * Pure rendering plus one careful file writer. Input is a minimal transcript shape (an adapter
 * from the real stored messages is 5.2b). Tool calls are collapsed into `<details>` blocks,
 * obvious credentials are redacted, and the writer never overwrites: it creates
 * `<dir>/YYYY-MM-DD-<slug>.md` (or `-2`, `-3`, ...) via temp file + hard link, and refuses to
 * leave `<dir>`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExportToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
}

export interface ExportMessage {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  toolCalls?: ExportToolCall[];
}

export interface ExportSession {
  title: string;
  agent: string;
  model?: string;
  messages: ExportMessage[];
}

export interface StoredMessageInput {
  role: string;
  content: unknown;
  createdAt?: number | string;
  toolUseId?: string | null;
}

export interface SessionMetadataInput {
  title: string;
  agent?: string;
  model?: string;
}

export interface RenderOptions {
  exportedAt: Date;
  /** Max characters kept per tool input/output before it is cut with a marker. Default 2000. */
  maxToolChars?: number;
}

const REDACTIONS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*(?:\\?["'])?[^\s"',}]{8,}/gi,
];

/** Replace obvious credentials with `[redacted]`. A heuristic, not a guarantee. */
export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((acc, re) => acc.replace(re, (_m, key: unknown) => (typeof key === 'string' ? `${key}: [redacted]` : '[redacted]')), text);
}

/** A backtick fence longer than any run of backticks inside `content`. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more characters cut]`;
}

function block(label: string, value: unknown, max: number): string {
  const body = clip(redactSecrets(stringify(value)), max);
  const fence = fenceFor(body);
  return `${label}\n\n${fence}\n${body}\n${fence}\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

const HEADINGS: Record<ExportMessage['role'], string> = { user: 'User', assistant: 'Assistant', system: 'System' };

export function renderSessionMarkdown(session: ExportSession, opts: RenderOptions): string {
  const max = opts.maxToolChars ?? 2000;
  const out: string[] = [
    '---',
    `title: ${yamlString(session.title)}`,
    `agent: ${yamlString(session.agent)}`,
    ...(session.model ? [`model: ${yamlString(session.model)}`] : []),
    `exported: ${opts.exportedAt.toISOString()}`,
    '---',
    '',
    `# ${session.title.replace(/\s+/g, ' ').trim() || 'Untitled session'}`,
    '',
  ];
  for (const m of session.messages) {
    out.push(`## ${HEADINGS[m.role]}`, '');
    if (m.text?.trim()) out.push(redactSecrets(m.text.trim()).replace(/^(#{1,2})(\s)/gm, '\\$1$2'), '');
    for (const call of m.toolCalls ?? []) {
      const parts: string[] = [];
      if (call.input !== undefined) parts.push(block('Input', call.input, max));
      if (call.output !== undefined) parts.push(block('Output', call.output, max));
      out.push(`<details>\n<summary>Tool: ${call.name.replace(/[<>&\n]/g, ' ')}</summary>\n`, ...parts, '</details>', '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** `2026-10-30-fix-the-login-bug`: date prefix + ascii slug, never empty, never path-like. */
export function exportFileName(title: string, at: Date): string {
  const slug =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'session';
  return `${at.toISOString().slice(0, 10)}-${slug}`;
}

export interface WriteExportResult {
  path: string;
}

/** Write the export into `dir` (created if missing), never overwriting an existing file. */
export function writeSessionExport(dir: string, session: ExportSession, opts: RenderOptions): WriteExportResult {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const base = exportFileName(session.title, opts.exportedAt);
  const markdown = renderSessionMarkdown(session, opts);

  for (let n = 1; n < 1000; n++) {
    const target = path.join(root, `${base}${n === 1 ? '' : `-${n}`}.md`);
    if (path.dirname(target) !== root) throw new Error('export path escaped the target directory');
    const tmp = path.join(root, `.${path.basename(target)}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, markdown);
      // linkSync fails with EEXIST instead of replacing, so an existing file is never overwritten.
      fs.linkSync(tmp, target);
      return { path: target };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error(`could not find a free file name for ${base}`);
}

const SYNTHETIC_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

function extractPlainText(content: unknown): string {
  if (typeof content === 'string') {
    if (content.length === 0) return '';
    const first = content[0];
    if (first === '{' || first === '[') {
      try {
        return extractPlainText(JSON.parse(content));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
    if (typeof c.message === 'string') return c.message;
    if (typeof c.content === 'string') return c.content;
  }
  return '';
}

function parseToolUse(row: StoredMessageInput): { name: string; input?: unknown; toolUseId?: string } {
  let content = row.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      // keep original
    }
  }
  const obj = content && typeof content === 'object' ? (content as Record<string, unknown>) : undefined;
  const toolUseId =
    (typeof row.toolUseId === 'string' && row.toolUseId) ||
    (typeof obj?.toolUseId === 'string' && obj.toolUseId) ||
    undefined;
  let name = (typeof obj?.toolName === 'string' && obj.toolName) || (typeof obj?.name === 'string' && obj.name) || '';
  let input = obj?.input;

  if (name === 'cindy_mcp_call_tool' && input && typeof input === 'object') {
    const gateway = input as Record<string, unknown>;
    const server = typeof gateway.server === 'string' ? gateway.server : '';
    const tool = typeof gateway.tool === 'string' ? gateway.tool : '';
    if (server && tool) {
      name = `mcp:${server}:${tool}`;
      input = gateway.args ?? {};
    }
  }

  return { name, input, toolUseId };
}

function parseToolResult(row: StoredMessageInput): { toolUseId?: string; output: unknown } {
  let content = row.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      // keep original
    }
  }
  const obj = content && typeof content === 'object' ? (content as Record<string, unknown>) : undefined;
  const toolUseId =
    (typeof row.toolUseId === 'string' && row.toolUseId) ||
    (typeof obj?.toolUseId === 'string' && obj.toolUseId) ||
    undefined;
  const output = obj?.fullText ?? obj?.output ?? obj?.content ?? content;
  return { toolUseId, output };
}

/**
 * Adapt stored messages and session metadata into the minimal `ExportSession` transcript model.
 */
export function buildExportSession(
  meta: SessionMetadataInput,
  rows: readonly StoredMessageInput[],
): ExportSession {
  const sorted = [...rows].sort((a, b) => {
    const timeA = typeof a.createdAt === 'number' ? a.createdAt : a.createdAt ? Date.parse(a.createdAt) : 0;
    const timeB = typeof b.createdAt === 'number' ? b.createdAt : b.createdAt ? Date.parse(b.createdAt) : 0;
    return timeA - timeB;
  });

  const resultsByUseId = new Map<string, unknown>();
  for (const row of sorted) {
    if (row.role === 'tool_result') {
      const { toolUseId, output } = parseToolResult(row);
      if (toolUseId) resultsByUseId.set(toolUseId, output);
    }
  }

  const messages: ExportMessage[] = [];
  let pendingTools: ExportToolCall[] = [];

  const flushPendingTools = () => {
    if (pendingTools.length === 0) return;
    messages.push({ role: 'assistant', text: '', toolCalls: pendingTools });
    pendingTools = [];
  };

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (row.role === 'tool_use') {
      const parsed = parseToolUse(row);
      let output = parsed.toolUseId ? resultsByUseId.get(parsed.toolUseId) : undefined;
      if (output === undefined && i + 1 < sorted.length && sorted[i + 1].role === 'tool_result') {
        output = parseToolResult(sorted[i + 1]).output;
      }
      const call: ExportToolCall = {
        name: parsed.name || 'unknown_tool',
        ...(parsed.input !== undefined ? { input: parsed.input } : {}),
        ...(output !== undefined ? { output } : {}),
      };

      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && pendingTools.length === 0) {
        lastMsg.toolCalls = lastMsg.toolCalls ?? [];
        lastMsg.toolCalls.push(call);
      } else {
        pendingTools.push(call);
      }
    } else if (row.role === 'tool_result') {
      continue;
    } else if (row.role === 'assistant') {
      const text = extractPlainText(row.content).trim();
      if (!text && pendingTools.length === 0) continue;
      messages.push({
        role: 'assistant',
        text,
        ...(pendingTools.length > 0 ? { toolCalls: pendingTools } : {}),
      });
      pendingTools = [];
    } else if (row.role === 'user') {
      const text = extractPlainText(row.content).trim();
      if (!text || text.startsWith(SYNTHETIC_TRIGGER_PREFIX)) continue;
      flushPendingTools();
      messages.push({ role: 'user', text });
    } else if (row.role === 'system') {
      const text = extractPlainText(row.content).trim();
      if (!text) continue;
      flushPendingTools();
      messages.push({ role: 'system', text });
    } else if (row.role === 'error') {
      const text = extractPlainText(row.content).trim();
      if (!text) continue;
      flushPendingTools();
      messages.push({ role: 'assistant', text: `[Error: ${text}]` });
    }
  }

  flushPendingTools();

  return {
    title: meta.title?.trim() || 'Untitled session',
    agent: meta.agent?.trim() || 'unknown',
    ...(meta.model?.trim() ? { model: meta.model.trim() } : {}),
    messages,
  };
}
