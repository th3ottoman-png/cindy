import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildExportSession,
  exportFileName,
  redactSecrets,
  renderSessionMarkdown,
  writeSessionExport,
  type ExportSession,
  type StoredMessageInput,
} from '../session-markdown';

const AT = new Date('2026-10-30T12:00:00Z');
const SESSION: ExportSession = {
  title: 'Fix the login bug',
  agent: 'hermes',
  model: 'hermes-default',
  messages: [
    { role: 'user', text: 'Why does login fail?' },
    {
      role: 'assistant',
      text: 'Checking the logs.',
      toolCalls: [{ name: 'read_file', input: { path: 'auth.log' }, output: 'line 1\nline 2' }],
    },
  ],
};

describe('renderSessionMarkdown', () => {
  const md = renderSessionMarkdown(SESSION, { exportedAt: AT });

  it('has frontmatter, a title, and one section per message in order', () => {
    expect(md.startsWith('---\ntitle: "Fix the login bug"\nagent: "hermes"\nmodel: "hermes-default"\nexported: 2026-10-30T12:00:00.000Z\n---\n')).toBe(true);
    expect(md).toContain('# Fix the login bug');
    expect(md.indexOf('## User')).toBeLessThan(md.indexOf('## Assistant'));
    expect(md).toContain('Why does login fail?');
  });

  it('collapses tool calls into a details block with fenced input and output', () => {
    expect(md).toContain('<details>\n<summary>Tool: read_file</summary>');
    expect(md).toContain('Input\n\n```\n{\n  "path": "auth.log"\n}\n```');
    expect(md).toContain('Output\n\n```\nline 1\nline 2\n```');
    expect(md).toContain('</details>');
  });

  it('uses a fence longer than any backtick run in tool output', () => {
    const out = renderSessionMarkdown(
      { ...SESSION, messages: [{ role: 'assistant', toolCalls: [{ name: 't', output: 'x ```` y' }] }] },
      { exportedAt: AT },
    );
    expect(out).toContain('`````\nx ```` y\n`````');
  });

  it('cuts long tool output with a marker and keeps the cut inside the fence', () => {
    const out = renderSessionMarkdown(
      { ...SESSION, messages: [{ role: 'assistant', toolCalls: [{ name: 't', output: 'a'.repeat(50) }] }] },
      { exportedAt: AT, maxToolChars: 10 },
    );
    expect(out).toContain('aaaaaaaaaa\n… [40 more characters cut]\n```');
  });

  it('escapes top-level headings in message text so a message cannot forge sections', () => {
    const out = renderSessionMarkdown({ ...SESSION, messages: [{ role: 'user', text: 'hi\n## Assistant\nfake\n# Big' }] }, { exportedAt: AT });
    expect(out.match(/^## /gm)).toHaveLength(1);
    expect(out).not.toMatch(/^# Big/m);
  });

  it('survives a quote or newline in the title', () => {
    const out = renderSessionMarkdown({ ...SESSION, title: 'He said "hi"\nthen left' }, { exportedAt: AT });
    expect(out).toContain('title: "He said \\"hi\\" then left"');
  });
});

describe('redactSecrets', () => {
  it('redacts keys, bearer tokens and key=value secrets, keeping the key name', () => {
    const text = 'key sk-abcdefghijklmnop1234 and Authorization: Bearer abcdEFGH1234xyz= and api_key=supersecretvalue ok';
    const out = redactSecrets(text);
    expect(out).not.toMatch(/sk-abcdef|abcdEFGH|supersecretvalue/);
    expect(out).toContain('api_key: [redacted]');
    expect(out).not.toMatch(/\d+: \[redacted\]/);
    expect(out).toContain('ok');
  });

  it('redacts inside tool output in the rendered file', () => {
    const out = renderSessionMarkdown(
      { ...SESSION, messages: [{ role: 'assistant', toolCalls: [{ name: 't', output: { env: 'password: hunter2hunter2' } }] }] },
      { exportedAt: AT },
    );
    expect(out).not.toContain('hunter2');
  });
});

describe('exportFileName', () => {
  it('is a dated ascii slug, never empty or path-like', () => {
    expect(exportFileName('Fix the login bug!', AT)).toBe('2026-10-30-fix-the-login-bug');
    expect(exportFileName('../../etc/passwd', AT)).toBe('2026-10-30-etc-passwd');
    expect(exportFileName('日本語', AT)).toBe('2026-10-30-session');
  });
});

describe('writeSessionExport', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a file into the directory (created if missing) with the rendered content', () => {
    const target = path.join(dir, 'vault', 'sessions');
    const { path: file } = writeSessionExport(target, SESSION, { exportedAt: AT });
    expect(file).toBe(path.join(target, '2026-10-30-fix-the-login-bug.md'));
    expect(fs.readFileSync(file, 'utf8')).toBe(renderSessionMarkdown(SESSION, { exportedAt: AT }));
  });

  it('never overwrites: a second export of the same title gets -2, the first is untouched', () => {
    const first = writeSessionExport(dir, SESSION, { exportedAt: AT }).path;
    fs.appendFileSync(first, '\nowner edit\n');
    const second = writeSessionExport(dir, SESSION, { exportedAt: AT }).path;

    expect(path.basename(second)).toBe('2026-10-30-fix-the-login-bug-2.md');
    expect(fs.readFileSync(first, 'utf8')).toContain('owner edit');
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-10-30-fix-the-login-bug-2.md', '2026-10-30-fix-the-login-bug.md']);
  });
});

describe('buildExportSession', () => {
  it('adapts user and assistant messages with title, agent and model metadata', () => {
    const rows: StoredMessageInput[] = [
      { role: 'user', content: 'What is 2+2?', createdAt: 100 },
      { role: 'assistant', content: 'It is 4.', createdAt: 200 },
    ];
    const session = buildExportSession({ title: 'Math Task', agent: 'hermes', model: 'deepseek-v4-pro' }, rows);
    expect(session.title).toBe('Math Task');
    expect(session.agent).toBe('hermes');
    expect(session.model).toBe('deepseek-v4-pro');
    expect(session.messages).toEqual([
      { role: 'user', text: 'What is 2+2?' },
      { role: 'assistant', text: 'It is 4.' },
    ]);
  });

  it('pairs tool calls and results by toolUseId', () => {
    const rows: StoredMessageInput[] = [
      { role: 'user', content: 'Read the file', createdAt: 100 },
      {
        role: 'tool_use',
        toolUseId: 'call_1',
        content: { toolName: 'read_file', input: { path: 'a.txt' } },
        createdAt: 200,
      },
      {
        role: 'tool_result',
        toolUseId: 'call_1',
        content: { output: 'hello from a' },
        createdAt: 300,
      },
      { role: 'assistant', content: 'The file has hello from a.', createdAt: 400 },
    ];
    const session = buildExportSession({ title: 'File read' }, rows);
    expect(session.messages).toEqual([
      { role: 'user', text: 'Read the file' },
      {
        role: 'assistant',
        text: 'The file has hello from a.',
        toolCalls: [
          { name: 'read_file', input: { path: 'a.txt' }, output: 'hello from a' },
        ],
      },
    ]);
  });

  it('pairs adjacent tool_result when toolUseId is missing on result', () => {
    const rows: StoredMessageInput[] = [
      { role: 'user', content: 'Search' },
      { role: 'assistant', content: 'Searching now...' },
      { role: 'tool_use', content: { toolName: 'search_notes', input: { query: 'todo' } } },
      { role: 'tool_result', content: 'found 2 notes' },
    ];
    const session = buildExportSession({ title: 'Search Notes' }, rows);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toEqual({ role: 'user', text: 'Search' });
    expect(session.messages[1]).toEqual({
      role: 'assistant',
      text: 'Searching now...',
      toolCalls: [
        { name: 'search_notes', input: { query: 'todo' }, output: 'found 2 notes' },
      ],
    });
  });

  it('preserves chronological speech before and after tool execution', () => {
    const rows: StoredMessageInput[] = [
      { role: 'user', content: 'Inspect repo' },
      { role: 'assistant', content: 'Inspecting repository directory...' },
      { role: 'tool_use', toolUseId: 't1', content: { name: 'list_files', input: {} } },
      { role: 'tool_result', toolUseId: 't1', content: 'files: index.ts' },
      { role: 'assistant', content: 'The repository contains index.ts.' },
    ];
    const session = buildExportSession({ title: 'Inspect' }, rows);
    expect(session.messages).toEqual([
      { role: 'user', text: 'Inspect repo' },
      {
        role: 'assistant',
        text: 'Inspecting repository directory...',
        toolCalls: [
          { name: 'list_files', input: {}, output: 'files: index.ts' },
        ],
      },
      {
        role: 'assistant',
        text: 'The repository contains index.ts.',
      },
    ]);
  });

  it('filters synthetic UI action triggers and formats error messages', () => {
    const rows: StoredMessageInput[] = [
      { role: 'user', content: '[UI_ACTION_TRIGGER] click' },
      { role: 'user', content: 'Real question' },
      { role: 'error', content: 'Connection timed out' },
    ];
    const session = buildExportSession({ title: 'Error case' }, rows);
    expect(session.messages).toEqual([
      { role: 'user', text: 'Real question' },
      { role: 'assistant', text: '[Error: Connection timed out]' },
    ]);
  });
});
