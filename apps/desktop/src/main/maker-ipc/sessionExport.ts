/**
 * Session export to Markdown host and IPC handlers (ROADMAP 5.2b).
 *
 * Adapts stored session rows to the pure ExportSession transcript model and
 * writes the Markdown file into the destination folder (e.g. notes vault or custom path).
 */

import * as path from 'node:path';
import { dialog } from 'electron';

import {
  buildExportSession,
  writeSessionExport,
  type StoredMessageInput,
} from '@cindy/maker-core/session-export';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface SessionExportMarkdownRequest {
  sessionId: string;
  targetDir: string;
  maxToolChars?: number;
}

export type SessionExportMarkdownResult =
  | {
      ok: true;
      path: string;
      fileName: string;
      messageCount: number;
      toolCallCount: number;
    }
  | {
      ok: false;
      reason: 'invalid' | 'no-session' | 'no-messages' | 'write-failed';
      message: string;
    };

export interface SessionExportHostDeps {
  getSessionRow: (sessionId: string) => Promise<{
    title?: string | null;
    agentKind?: string | null;
    model?: string | null;
  } | null>;
  listMessages: (sessionId: string) => Promise<StoredMessageInput[]>;
  showOpenDialog?: (options: {
    properties: ('openDirectory' | 'createDirectory')[];
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
}

export class SessionExportHost {
  constructor(private readonly deps: SessionExportHostDeps) {}

  async exportSessionMarkdown(request: unknown): Promise<SessionExportMarkdownResult> {
    const req = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const sessionId = typeof req.sessionId === 'string' ? req.sessionId.trim() : '';
    const targetDir = typeof req.targetDir === 'string' ? req.targetDir.trim() : '';
    const maxToolChars =
      typeof req.maxToolChars === 'number' && req.maxToolChars > 0 ? req.maxToolChars : undefined;

    if (!sessionId) {
      return { ok: false, reason: 'invalid', message: 'sessionId is required' };
    }
    if (!targetDir) {
      return { ok: false, reason: 'invalid', message: 'targetDir is required' };
    }

    let sessionRow;
    try {
      sessionRow = await this.deps.getSessionRow(sessionId);
    } catch (err) {
      return {
        ok: false,
        reason: 'no-session',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (!sessionRow) {
      return { ok: false, reason: 'no-session', message: `Session "${sessionId}" was not found` };
    }

    let rows;
    try {
      rows = await this.deps.listMessages(sessionId);
    } catch (err) {
      return {
        ok: false,
        reason: 'no-messages',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (!rows || rows.length === 0) {
      return { ok: false, reason: 'no-messages', message: 'Session has no messages to export' };
    }

    const exportSession = buildExportSession(
      {
        title: sessionRow.title ?? '',
        agent: sessionRow.agentKind ?? '',
        model: sessionRow.model ?? undefined,
      },
      rows,
    );

    if (exportSession.messages.length === 0) {
      return { ok: false, reason: 'no-messages', message: 'Session has no messages to export' };
    }

    try {
      const result = writeSessionExport(targetDir, exportSession, {
        exportedAt: new Date(),
        maxToolChars,
      });
      const toolCallCount = exportSession.messages.reduce(
        (acc, m) => acc + (m.toolCalls?.length ?? 0),
        0,
      );
      return {
        ok: true,
        path: result.path,
        fileName: path.basename(result.path),
        messageCount: exportSession.messages.length,
        toolCallCount,
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'write-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async pickFolder(): Promise<string | null> {
    const show =
      this.deps.showOpenDialog ??
      (typeof dialog !== 'undefined' && dialog?.showOpenDialog ? dialog.showOpenDialog : undefined);
    if (!show) return null;
    const res = await show({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  }
}

export function registerSessionExportHandlers(
  registry: IpcHandlerRegistry,
  deps: {
    host: SessionExportHost;
    assertTrusted: (event: unknown) => void;
  },
): void {
  registry.handle(MAKER_INVOKE.SESSION_EXPORT_MARKDOWN, (event, request: unknown) => {
    deps.assertTrusted(event);
    return deps.host.exportSessionMarkdown(request);
  });
  registry.handle(MAKER_INVOKE.SESSION_EXPORT_PICK_FOLDER, (event) => {
    deps.assertTrusted(event);
    return deps.host.pickFolder();
  });
}
