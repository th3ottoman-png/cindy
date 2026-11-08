import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SUMMARY_FOLDER,
  DEFAULT_SUMMARY_IDLE_MINUTES,
  buildSummaryUserPrompt,
  checkSummaryIdleMinutes,
  findSummaryFile,
  formatConversationForSummary,
  readSummaryConfig,
  readSummaryTurnsCount,
  renderSummaryMarkdown,
  summaryFileName,
  writeConversationSummary,
  writeSummaryConfig,
} from '../conversation-summary.js';
import type { ExportSession } from '../../export/session-markdown.js';

const SID = '1A2B3C4D-5e6f-7a8b-9c0d-ef0123456789';
const T1 = new Date('2026-11-07T10:00:00Z');
const T2 = new Date('2026-11-08T11:00:00Z');

function createSampleSession(title: string, extraTurns: string[] = []): ExportSession {
  return {
    title,
    agent: 'hermes',
    model: 'deepseek-flash',
    messages: [
      { role: 'user', text: 'Please investigate issue 42.' },
      {
        role: 'assistant',
        text: 'I found the problem in login.ts.',
        toolCalls: [{ name: 'read_file', input: { path: 'src/login.ts' } }],
      },
      ...extraTurns.map((text) => ({ role: 'user' as const, text })),
    ],
  };
}

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-summary-'));
  vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('checkSummaryIdleMinutes (ROADMAP 5.6)', () => {
  it('accepts valid integers between 1 and 1440', () => {
    expect(checkSummaryIdleMinutes(1)).toEqual({ ok: true, idleMinutes: 1 });
    expect(checkSummaryIdleMinutes(10)).toEqual({ ok: true, idleMinutes: 10 });
    expect(checkSummaryIdleMinutes(1440)).toEqual({ ok: true, idleMinutes: 1440 });
  });

  it('rejects invalid inputs', () => {
    expect(checkSummaryIdleMinutes(0).ok).toBe(false);
    expect(checkSummaryIdleMinutes(-5).ok).toBe(false);
    expect(checkSummaryIdleMinutes(1441).ok).toBe(false);
    expect(checkSummaryIdleMinutes('10').ok).toBe(false);
    expect(checkSummaryIdleMinutes(2.5).ok).toBe(false);
    expect(checkSummaryIdleMinutes(null).ok).toBe(false);
  });
});

describe('readSummaryConfig & writeSummaryConfig (ROADMAP 5.6)', () => {
  it('returns default off config when config file is missing', () => {
    const file = path.join(tmp, 'harness', 'chat-summary.json');
    const res = readSummaryConfig(file);
    expect(res.config).toEqual({
      enabled: false,
      folder: DEFAULT_SUMMARY_FOLDER,
      idleMinutes: DEFAULT_SUMMARY_IDLE_MINUTES,
    });
    expect(res.issue).toBeUndefined();
  });

  it('handles invalid JSON gracefully with issue reporting and default config', () => {
    const file = path.join(tmp, 'chat-summary.json');
    fs.writeFileSync(file, 'not json at all');
    const res = readSummaryConfig(file);
    expect(res.config.enabled).toBe(false);
    expect(res.issue).toContain('is not valid JSON');
  });

  it('writes config atomically and round-trips updates', () => {
    const file = path.join(tmp, 'harness', 'chat-summary.json');
    const written = writeSummaryConfig(file, {
      enabled: true,
      folder: 'Memory/Notes',
      idleMinutes: 15,
    });
    expect(written).toEqual({
      enabled: true,
      folder: 'Memory/Notes',
      idleMinutes: 15,
    });

    const read = readSummaryConfig(file);
    expect(read.config).toEqual(written);
    expect(read.issue).toBeUndefined();
  });

  it('fails closed on invalid folder during write', () => {
    const file = path.join(tmp, 'chat-summary.json');
    expect(() => writeSummaryConfig(file, { folder: '/absolute/path' })).toThrow(/invalid summary folder/);
    expect(() => writeSummaryConfig(file, { folder: '../escape' })).toThrow(/invalid summary folder/);
  });

  it('fails closed on invalid idleMinutes during write', () => {
    const file = path.join(tmp, 'chat-summary.json');
    expect(() => writeSummaryConfig(file, { idleMinutes: 0 })).toThrow(/invalid summary idleMinutes/);
  });
});

describe('summaryFileName & findSummaryFile (ROADMAP 5.6)', () => {
  it('builds a stable slug filename with short id and -summary suffix', () => {
    const name = summaryFileName('Fix login bug!', T1, SID);
    expect(name).toBe('2026-11-07-fix-login-bug-1a2b3c4d-summary.md');
  });

  it('finds existing summary note by session_id in frontmatter', () => {
    const memDir = path.join(vault, 'Cindy', 'Memory');
    fs.mkdirSync(memDir, { recursive: true });

    const notePath = path.join(memDir, '2026-11-07-initial-title-1a2b3c4d-summary.md');
    fs.writeFileSync(
      notePath,
      `---\nsession_id: "${SID}"\ntitle: "Initial Title"\nturns_summarized: 2\n---\n# Summary\n`,
      'utf8',
    );

    const found = findSummaryFile(memDir, SID);
    expect(found).toBe(notePath);
  });

  it('does not match a decoy with the same short id but different session_id', () => {
    const memDir = path.join(vault, 'Cindy', 'Memory');
    fs.mkdirSync(memDir, { recursive: true });

    const decoy = path.join(memDir, '2026-11-07-decoy-1a2b3c4d-summary.md');
    fs.writeFileSync(
      decoy,
      `---\nsession_id: "DIFFERENT-SESSION-1a2b3c4d"\n---\n# Summary\n`,
      'utf8',
    );

    const found = findSummaryFile(memDir, SID);
    expect(found).toBeUndefined();
  });
});

describe('readSummaryTurnsCount (ROADMAP 5.6)', () => {
  it('parses turns_summarized from frontmatter', () => {
    const note = path.join(vault, 'summary.md');
    fs.writeFileSync(note, '---\nsession_id: "s1"\nturns_summarized: 8\nautosave: true\n---\n# Summary\n');
    expect(readSummaryTurnsCount(note)).toBe(8);
  });

  it('returns undefined if turns_summarized is absent or unparseable', () => {
    const note = path.join(vault, 'no-turns.md');
    fs.writeFileSync(note, '---\nsession_id: "s1"\n---\n# Summary\n');
    expect(readSummaryTurnsCount(note)).toBeUndefined();
  });
});

describe('formatConversationForSummary & buildSummaryUserPrompt', () => {
  it('formats conversation messages and tool calls and redacts secrets', () => {
    const session: ExportSession = {
      title: 'Secret Debugging',
      agent: 'hermes',
      model: 'deepseek-flash',
      messages: [
        { role: 'user', text: 'Use api_key: "sk-abcdef1234567890123456" to check status' },
        {
          role: 'assistant',
          text: 'Bearer secret_token_value_123456789 verified',
          toolCalls: [{ name: 'check_status' }],
        },
      ],
    };

    const formatted = formatConversationForSummary(session);
    expect(formatted).toContain('Conversation Title: Secret Debugging');
    expect(formatted).toContain('(tools used: check_status)');
    expect(formatted).not.toContain('sk-abcdef1234567890123456');
    expect(formatted).toContain('[redacted]');

    const prompt = buildSummaryUserPrompt(session);
    expect(prompt).toContain('Please analyze and summarize');
    expect(prompt).toContain('Conversation Title: Secret Debugging');
  });
});

describe('renderSummaryMarkdown & writeConversationSummary (ROADMAP 5.6)', () => {
  it('renders markdown with frontmatter, chat log link, and model info', () => {
    const md = renderSummaryMarkdown({
      sessionId: SID,
      title: 'Fix Database Lock',
      summaryText: '## Overview\nResolved lock contention.\n\n## Decisions & Rationale\n- Switched to WAL mode.',
      model: 'deepseek-flash',
      provider: 'deepseek',
      routeName: 'summary',
      summarizedAt: T1,
      turnsCount: 2,
      chatNoteRelPath: '../Chats/2026-11-07-fix-database-lock-1a2b3c4d.md',
    });

    expect(md).toContain(`session_id: "${SID}"`);
    expect(md).toContain('summary_model: "deepseek-flash"');
    expect(md).toContain('summary_route: "summary"');
    expect(md).toContain('turns_summarized: 2');
    expect(md).toContain('[2026-11-07-fix-database-lock-1a2b3c4d.md](../Chats/2026-11-07-fix-database-lock-1a2b3c4d.md)');
    expect(md).toContain('Resolved lock contention.');
  });

  it('fails gracefully when vault directory is missing or empty', () => {
    const session = createSampleSession('No Vault');
    const res = writeConversationSummary({
      vaultDir: '',
      folder: DEFAULT_SUMMARY_FOLDER,
      sessionId: SID,
      session,
      summaryText: 'Summary text',
      model: 'deepseek-flash',
      provider: 'deepseek',
      routeName: 'summary',
      summarizedAt: T1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-vault');
  });

  it('writes summary note atomically into vault with chat note link', () => {
    // Setup chat note in Chats
    const chatDir = path.join(vault, 'Cindy', 'Chats');
    fs.mkdirSync(chatDir, { recursive: true });
    const chatFile = path.join(chatDir, `2026-11-07-investigate-42-1a2b3c4d.md`);
    fs.writeFileSync(chatFile, `---\nsession_id: "${SID}"\nautosave: true\n---\n# Chat\n`);

    const session = createSampleSession('Investigate 42');
    const res = writeConversationSummary({
      vaultDir: vault,
      folder: DEFAULT_SUMMARY_FOLDER,
      sessionId: SID,
      session,
      summaryText: '## Overview\nInvestigated 42.\n\n## Next Steps\n- Ship patch',
      model: 'deepseek-flash',
      provider: 'deepseek',
      routeName: 'summary',
      summarizedAt: T1,
      autosaveFolder: 'Cindy/Chats',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(true);
      expect(res.turnsSummarized).toBe(2);
      expect(fs.existsSync(res.path)).toBe(true);
      const content = fs.readFileSync(res.path, 'utf8');
      expect(content).toContain(`session_id: "${SID}"`);
      expect(content).toContain('turns_summarized: 2');
      expect(content).toContain('Investigated 42.');
      expect(content).toContain('../Chats/2026-11-07-investigate-42-1a2b3c4d.md');
    }
  });

  it('rewrites the same summary file when title changes (stable identity)', () => {
    const session1 = createSampleSession('Draft title');
    const res1 = writeConversationSummary({
      vaultDir: vault,
      folder: DEFAULT_SUMMARY_FOLDER,
      sessionId: SID,
      session: session1,
      summaryText: 'Summary 1',
      model: 'deepseek-flash',
      provider: 'deepseek',
      routeName: 'summary',
      summarizedAt: T1,
    });
    expect(res1.ok).toBe(true);
    const path1 = (res1 as { path: string }).path;

    const session2 = createSampleSession('Final Title', ['more turns']);
    const res2 = writeConversationSummary({
      vaultDir: vault,
      folder: DEFAULT_SUMMARY_FOLDER,
      sessionId: SID,
      session: session2,
      summaryText: 'Summary 2 updated',
      model: 'deepseek-flash',
      provider: 'deepseek',
      routeName: 'summary',
      summarizedAt: T2,
    });
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.created).toBe(false);
      expect(res2.path).toBe(path1); // Preserves file path across renames
      expect(res2.turnsSummarized).toBe(3);
      const content = fs.readFileSync(res2.path, 'utf8');
      expect(content).toContain('Summary 2 updated');
      expect(content).toContain('turns_summarized: 3');
    }
  });

  it('refuses to write outside the vault if folder escapes', () => {
    const session = createSampleSession('Escape');
    const res = writeConversationSummary({
      vaultDir: vault,
      folder: '../outside',
      sessionId: SID,
      session,
      summaryText: 'Escape attempt',
      model: 'm',
      provider: 'p',
      routeName: 'r',
      summarizedAt: T1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad-folder');
  });
});
