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

export interface RenderOptions {
  exportedAt: Date;
  /** Max characters kept per tool input/output before it is cut with a marker. Default 2000. */
  maxToolChars?: number;
}

const REDACTIONS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',}]{8,}/gi,
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
