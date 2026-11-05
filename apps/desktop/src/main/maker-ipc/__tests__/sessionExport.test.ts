import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import { registerSessionExportHandlers, SessionExportHost } from '../sessionExport';
import { IpcHarness } from './helpers/ipcHarness';

let dir: string;
let exportDir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'export-host-')));
  exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionExportHost (ROADMAP 5.2b)', () => {
  it('exports session to Markdown file with tool calls collapsed', async () => {
    const getSessionRow = vi.fn(async (sessionId: string) => ({
      title: 'Analyze Performance',
      agentKind: 'hermes',
      model: 'deepseek-v4-pro',
    }));
    const listMessages = vi.fn(async (sessionId: string) => [
      { role: 'user', content: 'Can you profile the app?' },
      {
        role: 'assistant',
        content: 'I will run the profiler now.',
      },
      {
        role: 'tool_use',
        toolUseId: 'call_1',
        content: { toolName: 'run_profiler', input: { duration: 10 } },
      },
      {
        role: 'tool_result',
        toolUseId: 'call_1',
        content: { output: 'Profiler result: 60fps' },
      },
      {
        role: 'assistant',
        content: 'Profile complete: app runs at 60fps.',
      },
    ]);

    const host = new SessionExportHost({ getSessionRow, listMessages });
    const result = await host.exportSessionMarkdown({
      sessionId: 'sess-123',
      targetDir: exportDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.fileName).toMatch(/^\d{4}-\d{2}-\d{2}-analyze-performance\.md$/);
    expect(result.messageCount).toBe(3);
    expect(result.toolCallCount).toBe(1);

    const written = fs.readFileSync(result.path, 'utf8');
    expect(written).toContain('# Analyze Performance');
    expect(written).toContain('agent: "hermes"');
    expect(written).toContain('model: "deepseek-v4-pro"');
    expect(written).toContain('## User\n\nCan you profile the app?');
    expect(written).toContain('## Assistant\n\nI will run the profiler now.');
    expect(written).toContain('<details>\n<summary>Tool: run_profiler</summary>');
    expect(written).toContain('"duration": 10');
    expect(written).toContain('Profiler result: 60fps');
    expect(written).toContain('## Assistant\n\nProfile complete: app runs at 60fps.');
  });

  it('fails with invalid reason if sessionId or targetDir is missing', async () => {
    const host = new SessionExportHost({
      getSessionRow: vi.fn(),
      listMessages: vi.fn(),
    });

    const res1 = await host.exportSessionMarkdown({ sessionId: '', targetDir: exportDir });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('invalid');

    const res2 = await host.exportSessionMarkdown({ sessionId: 's1', targetDir: '' });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('invalid');
  });

  it('fails with no-session when session does not exist', async () => {
    const host = new SessionExportHost({
      getSessionRow: vi.fn(async () => null),
      listMessages: vi.fn(),
    });

    const res = await host.exportSessionMarkdown({ sessionId: 'missing-s', targetDir: exportDir });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('no-session');
      expect(res.message).toContain('missing-s');
    }
  });

  it('fails with no-messages when session has no messages', async () => {
    const host = new SessionExportHost({
      getSessionRow: vi.fn(async () => ({ title: 'Empty' })),
      listMessages: vi.fn(async () => []),
    });

    const res = await host.exportSessionMarkdown({ sessionId: 's1', targetDir: exportDir });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-messages');
  });

  it('picks folder using showOpenDialog', async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/chosen/path'] }));
    const host = new SessionExportHost({
      getSessionRow: vi.fn(),
      listMessages: vi.fn(),
      showOpenDialog,
    });

    const chosen = await host.pickFolder();
    expect(chosen).toBe('/chosen/path');
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory'],
    });
  });

  it('handles IPC registration and asserts trust', async () => {
    const harness = new IpcHarness();
    const getSessionRow = vi.fn(async () => ({ title: 'IPC Test' }));
    const listMessages = vi.fn(async () => [{ role: 'user', content: 'hi' }]);
    const host = new SessionExportHost({ getSessionRow, listMessages });

    let trustedChecked = false;
    registerSessionExportHandlers(harness, {
      host,
      assertTrusted: () => {
        trustedChecked = true;
      },
    });

    const res = (await harness.invoke(MAKER_INVOKE.SESSION_EXPORT_MARKDOWN, {
      sessionId: 's1',
      targetDir: exportDir,
    })) as { ok: boolean; path: string };

    expect(trustedChecked).toBe(true);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(res.path)).toBe(true);
  });
});
