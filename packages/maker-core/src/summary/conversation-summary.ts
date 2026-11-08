/**
 * Auto-summary note per conversation (ROADMAP 5.6).
 *
 * Pure config handling, conversation prompt building, transcript formatting,
 * and vault-safe atomic summary note writer.
 *
 * Keeps **one stable summary file per conversation**:
 * `<vault>/Cindy/Memory/YYYY-MM-DD-<slug>-<short id>-summary.md`
 * Links to the 5.5 chat note, records `turns_summarized` in frontmatter to prevent
 * duplicate regeneration when no new turns have completed, and enforces containment
 * within the vault (never leaving it, symlinks included).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  autosaveFileName,
  autosaveShortId,
  checkAutosaveFolder,
  findAutosaveFile,
} from '../export/chat-autosave.js';
import { exportFileName, redactSecrets, type ExportSession } from '../export/session-markdown.js';

export const DEFAULT_SUMMARY_FOLDER = 'Cindy/Memory';
export const DEFAULT_SUMMARY_IDLE_MINUTES = 10;
export const MIN_SUMMARY_IDLE_MINUTES = 1;
export const MAX_SUMMARY_IDLE_MINUTES = 1440; // 24 hours

export interface ConversationSummaryConfig {
  enabled: boolean;
  folder: string;
  idleMinutes: number;
}

export interface ConversationSummaryConfigRead {
  config: ConversationSummaryConfig;
  issue?: string;
}

const DEFAULTS: ConversationSummaryConfig = {
  enabled: false,
  folder: DEFAULT_SUMMARY_FOLDER,
  idleMinutes: DEFAULT_SUMMARY_IDLE_MINUTES,
};

export const CONVERSATION_SUMMARY_SYSTEM_PROMPT = `You are Cindy's memory synthesizer.
Your task is to summarize a user-agent conversation for long-term memory retrieval in a markdown notes vault.

Produce a concise, structured markdown note with exactly these sections:
## Overview
A brief 1-3 sentence summary of what was attempted and accomplished.

## Decisions & Rationale
Bullet points of key decisions made during the conversation and why they were made.

## Facts Learned
Bullet points of concrete facts, discoveries, file paths, tool behaviors, or environment details learned.

## Open Questions
Unresolved questions, blockers, or items requiring clarification.

## Next Steps
Concrete actionable follow-ups or next tasks.

Rules:
- Be concise, technical, and direct. Avoid conversational filler or introductory pleasantries.
- Do NOT output any YAML frontmatter or top-level title heading; start directly with "## Overview".`;

export function checkSummaryIdleMinutes(val: unknown): { ok: true; idleMinutes: number } | { ok: false; message: string } {
  if (typeof val !== 'number' || !Number.isInteger(val)) {
    return { ok: false, message: 'idleMinutes must be an integer' };
  }
  if (val < MIN_SUMMARY_IDLE_MINUTES || val > MAX_SUMMARY_IDLE_MINUTES) {
    return {
      ok: false,
      message: `idleMinutes must be between ${MIN_SUMMARY_IDLE_MINUTES} and ${MAX_SUMMARY_IDLE_MINUTES}`,
    };
  }
  return { ok: true, idleMinutes: val };
}

/** Missing file -> defaults (off). Bad content -> defaults plus an issue. */
export function readSummaryConfig(configFile: string): ConversationSummaryConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: { ...DEFAULTS } };
    return { config: { ...DEFAULTS }, issue: `could not read ${configFile}: ${(err as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: { ...DEFAULTS }, issue: `${configFile} is not valid JSON` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: { ...DEFAULTS },
      issue: 'summary config must be an object like { "enabled": true, "folder": "Cindy/Memory", "idleMinutes": 10 }',
    };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled === true;

  let folder = DEFAULT_SUMMARY_FOLDER;
  let issue: string | undefined;
  if (obj.folder !== undefined) {
    if (typeof obj.folder !== 'string') {
      issue = '"folder" must be a string';
    } else {
      const checked = checkAutosaveFolder(obj.folder);
      if (!checked.ok) {
        issue = `"folder" ${checked.message}`;
      } else {
        folder = checked.folder;
      }
    }
  }

  let idleMinutes = DEFAULT_SUMMARY_IDLE_MINUTES;
  if (obj.idleMinutes !== undefined) {
    const checkedIdle = checkSummaryIdleMinutes(obj.idleMinutes);
    if (!checkedIdle.ok) {
      issue = issue ? `${issue}; ${checkedIdle.message}` : checkedIdle.message;
    } else {
      idleMinutes = checkedIdle.idleMinutes;
    }
  }

  if (issue) {
    return {
      config: { enabled: false, folder, idleMinutes },
      issue,
    };
  }

  return { config: { enabled, folder, idleMinutes } };
}

/** Atomic write (temp file in same directory + rename). */
export function writeSummaryConfig(
  configFile: string,
  config: Partial<ConversationSummaryConfig>,
): ConversationSummaryConfig {
  const current = readSummaryConfig(configFile).config;
  const folderVal = config.folder !== undefined ? config.folder : current.folder;
  const checkedFolder = checkAutosaveFolder(typeof folderVal === 'string' ? folderVal : '');
  if (!checkedFolder.ok) throw new Error(`invalid summary folder: ${checkedFolder.message}`);

  const idleVal = config.idleMinutes !== undefined ? config.idleMinutes : current.idleMinutes;
  const checkedIdle = checkSummaryIdleMinutes(idleVal);
  if (!checkedIdle.ok) throw new Error(`invalid summary idleMinutes: ${checkedIdle.message}`);

  const clean: ConversationSummaryConfig = {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : current.enabled,
    folder: checkedFolder.folder,
    idleMinutes: checkedIdle.idleMinutes,
  };

  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(configFile)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, configFile);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return clean;
}

/** `YYYY-MM-DD-<slug>-<8-char id>-summary.md` */
export function summaryFileName(title: string, firstSavedAt: Date, sessionId: string): string {
  return `${exportFileName(title, firstSavedAt)}-${autosaveShortId(sessionId)}-summary.md`;
}

/** Find existing summary note for this session in `dir`, matching `session_id` frontmatter. */
export function findSummaryFile(dir: string, sessionId: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const suffix = `-${autosaveShortId(sessionId)}-summary.md`;
  const marker = `session_id: ${JSON.stringify(sessionId)}`;
  for (const name of names.filter((n) => n.endsWith(suffix)).sort()) {
    const full = path.join(dir, name);
    let head = '';
    let fd: number | undefined;
    try {
      fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } catch {
      continue;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (!head.startsWith('---\n')) continue;
    const end = head.indexOf('\n---', 4);
    const frontmatter = end === -1 ? head.slice(4) : head.slice(4, end);
    if (frontmatter.split('\n').includes(marker)) return full;
  }
  return undefined;
}

/** Read `turns_summarized` count from the frontmatter of an existing summary file. */
export function readSummaryTurnsCount(filePath: string): number | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    if (!head.startsWith('---\n')) return undefined;
    const end = head.indexOf('\n---', 4);
    const frontmatter = end === -1 ? head.slice(4) : head.slice(4, end);
    for (const line of frontmatter.split('\n')) {
      const match = /^turns_summarized:\s*(\d+)$/.exec(line.trim());
      if (match) return parseInt(match[1]!, 10);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Formats transcript for summary prompt, redacting secrets and limiting size. */
export function formatConversationForSummary(session: ExportSession, maxChars: number = 24_000): string {
  const parts: string[] = [];
  parts.push(`Conversation Title: ${session.title}`);
  parts.push(`Agent: ${session.agent}`);
  if (session.model) parts.push(`Model: ${session.model}`);
  parts.push('\nMessages:');

  for (const m of session.messages) {
    if (m.role === 'user') {
      parts.push(`\n[User]:\n${m.text ?? ''}`);
    } else if (m.role === 'assistant') {
      const toolInfo = m.toolCalls && m.toolCalls.length > 0
        ? ` (tools used: ${m.toolCalls.map((t) => t.name).join(', ')})`
        : '';
      parts.push(`\n[Assistant${toolInfo}]:\n${m.text ?? ''}`);
    } else if (m.role === 'system') {
      parts.push(`\n[System]:\n${m.text ?? ''}`);
    }
  }

  let text = redactSecrets(parts.join('\n').trim());
  if (text.length > maxChars) {
    text = `[Earlier turns truncated for length...]\n\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}

export function buildSummaryUserPrompt(session: ExportSession): string {
  return `Please analyze and summarize the following conversation transcript according to the required sections:\n\n${formatConversationForSummary(session)}`;
}

export interface RenderSummaryMarkdownArgs {
  sessionId: string;
  title: string;
  summaryText: string;
  model: string;
  provider: string;
  routeName: string;
  summarizedAt: Date;
  turnsCount: number;
  chatNoteRelPath?: string;
}

export function renderSummaryMarkdown(args: {
  sessionId: string;
  title: string;
  summaryText: string;
  model: string;
  provider: string;
  routeName: string;
  summarizedAt: Date;
  turnsCount: number;
  chatNoteRelPath?: string;
}): string {
  const frontmatter = [
    '---',
    `session_id: ${JSON.stringify(args.sessionId)}`,
    `title: ${JSON.stringify(args.title)}`,
    `summary_model: ${JSON.stringify(args.model)}`,
    `summary_provider: ${JSON.stringify(args.provider)}`,
    `summary_route: ${JSON.stringify(args.routeName)}`,
    `summarized_at: ${JSON.stringify(args.summarizedAt.toISOString())}`,
    `turns_summarized: ${args.turnsCount}`,
    'autosave: true',
    '---',
  ].join('\n');

  const chatLinkLine = args.chatNoteRelPath
    ? `> **Chat Log**: [${path.basename(args.chatNoteRelPath)}](${args.chatNoteRelPath})\n`
    : '';

  const body = [
    `# Summary: ${args.title || 'Conversation'}`,
    '',
    `> **Session**: \`${args.sessionId}\` | **Model**: \`${args.routeName}\` (\`${args.model}\`) | **Date**: \`${args.summarizedAt.toISOString().slice(0, 10)}\``,
    chatLinkLine ? chatLinkLine.trimEnd() : '',
    '',
    args.summaryText.trim(),
    '',
  ]
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n');

  return `${frontmatter}\n\n${body}`;
}

export type WriteSummaryResult =
  | { ok: true; path: string; created: boolean; turnsSummarized: number }
  | { ok: false; reason: 'no-vault' | 'bad-folder' | 'write-failed'; message: string };

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Write (or rewrite) this conversation's summary note under `<vaultDir>/<folder>/`.
 * Fails closed if the folder escapes the vault.
 */
export function writeConversationSummary(args: {
  vaultDir: string;
  folder: string;
  sessionId: string;
  session: ExportSession;
  summaryText: string;
  model: string;
  provider: string;
  routeName: string;
  summarizedAt: Date;
  autosaveFolder?: string;
}): WriteSummaryResult {
  const { vaultDir, folder, sessionId, session, summaryText, model, provider, routeName, summarizedAt } = args;

  if (!vaultDir.trim()) return { ok: false, reason: 'no-vault', message: 'no vault folder is configured' };
  let root: string;
  try {
    root = fs.realpathSync(vaultDir);
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, reason: 'no-vault', message: `vault folder is missing: ${vaultDir}` };
  }

  const checked = checkAutosaveFolder(folder);
  if (!checked.ok) return { ok: false, reason: 'bad-folder', message: checked.message };
  if (!sessionId.trim()) return { ok: false, reason: 'write-failed', message: 'sessionId is required' };

  try {
    let dir = root;
    for (const part of checked.folder.split('/')) {
      const next = path.join(dir, part);
      if (!fs.existsSync(next)) fs.mkdirSync(next);
      dir = fs.realpathSync(next);
      if (!isInside(root, dir) || !fs.statSync(dir).isDirectory()) {
        return { ok: false, reason: 'bad-folder', message: 'folder escapes the vault or is not a folder' };
      }
    }

    // Determine chat log relative link if possible
    let chatNoteRelPath: string | undefined;
    if (args.autosaveFolder) {
      const chatDir = path.join(root, ...args.autosaveFolder.split('/'));
      const chatFile = findAutosaveFile(chatDir, sessionId);
      if (chatFile) {
        chatNoteRelPath = path.relative(dir, chatFile).replace(/\\/g, '/');
      } else {
        // Prospective link
        const targetChatName = autosaveFileName(session.title, summarizedAt, sessionId);
        chatNoteRelPath = path.relative(dir, path.join(chatDir, targetChatName)).replace(/\\/g, '/');
      }
    }

    const turnsCount = session.messages.length;
    const existing = findSummaryFile(dir, sessionId);
    const target = existing ?? path.join(dir, summaryFileName(session.title, summarizedAt, sessionId));
    const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);

    const markdown = renderSummaryMarkdown({
      sessionId,
      title: session.title,
      summaryText,
      model,
      provider,
      routeName,
      summarizedAt,
      turnsCount,
      chatNoteRelPath,
    });

    try {
      fs.writeFileSync(tmp, markdown, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, target);
    } finally {
      fs.rmSync(tmp, { force: true });
    }

    return { ok: true, path: target, created: !existing, turnsSummarized: turnsCount };
  } catch (err) {
    return { ok: false, reason: 'write-failed', message: err instanceof Error ? err.message : String(err) };
  }
}
