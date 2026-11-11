/**
 * Hermes Auto-review, Cindy side (ROADMAP 1.13c): the tool mapping and the
 * `approval/request` flow against a minimal fake hermes-mgr that can send
 * daemon → client requests and read the answers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { AgentEvent, InteractionRequest } from '../../../types/events.js';
import type { AutoReviewDelegate, AutoReviewRequest } from '../../shared/auto-review-decision.js';
import { HermesAgent } from '../agent.js';
import { normalizeHermesToolForAutoReview } from '../auto-review-policy.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

describe('normalizeHermesToolForAutoReview', () => {
  it('maps known Hermes tools to their review kinds', () => {
    expect(normalizeHermesToolForAutoReview('read_file', { path: 'a.txt' })).toEqual({ kind: 'read', path: 'a.txt', scope: 'file' });
    expect(normalizeHermesToolForAutoReview('search_files', { pattern: 'x' })).toEqual({ kind: 'read', path: '.', scope: 'tree' });
    expect(normalizeHermesToolForAutoReview('write_file', { path: 'b.txt', content: 'hi' })).toEqual({ kind: 'file-write', path: 'b.txt' });
    expect(normalizeHermesToolForAutoReview('patch', { path: 'c.ts' })).toEqual({ kind: 'file-write', path: 'c.ts' });
    expect(normalizeHermesToolForAutoReview('terminal', { command: 'ls -la' })).toEqual({ kind: 'exec', command: 'ls -la' });
    expect(normalizeHermesToolForAutoReview('todo', { todos: [] })).toEqual({ kind: 'session-state' });
    expect(normalizeHermesToolForAutoReview('clarify', { question: 'which?' })).toEqual({ kind: 'session-state' });
  });

  it('sends a terminal call with a workdir to the reviewer as other', () => {
    for (const workdir of ['/tmp', ' ', '']) {
      const action = normalizeHermesToolForAutoReview('terminal', { command: 'ls', workdir });
      expect(action.kind).toBe('other');
      expect(JSON.parse((action as { description: string }).description)).toEqual({ toolName: 'terminal', input: { command: 'ls', workdir } });
    }
  });

  it('keeps missing evidence visible instead of inventing it', () => {
    expect(normalizeHermesToolForAutoReview('write_file', {})).toEqual({ kind: 'file-write', path: undefined });
    expect(normalizeHermesToolForAutoReview('terminal', {})).toEqual({ kind: 'exec', command: '' });
  });

  it('sends every other tool (MCP, code, memory, …) to the reviewer with its full name and input', () => {
    for (const tool of ['mcp_cindy_docs_search', 'execute_code', 'memory', 'delegate_task', 'browser_click', 'web_search', 'web_extract']) {
      const action = normalizeHermesToolForAutoReview(tool, { a: 1 });
      expect(action.kind).toBe('other');
      expect(JSON.parse((action as { description: string }).description)).toEqual({ toolName: tool, input: { a: 1 } });
    }
  });
});

interface FakeDaemon {
  /** Sends `approval/request` like hermes-mgr and resolves with the client's answer. */
  askApproval(params: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: string } }>;
  permissionModes: string[];
  startParams: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startFakeDaemon(socketPath: string): Promise<FakeDaemon> {
  let client: net.Socket | null = null;
  let sessionId = '';
  let nextId = -1;
  const pending = new Map<number, (msg: { result?: unknown; error?: { code: string } }) => void>();
  const permissionModes: string[] = [];
  const startParams: Array<Record<string, unknown>> = [];
  const write = (m: unknown): void => {
    if (client && !client.destroyed) client.write(`${JSON.stringify(m)}\n`);
  };
  const server = net.createServer((socket) => {
    client = socket;
    socket.on('error', () => undefined);
    createInterface({ input: socket }).on('line', (line) => {
      const m = JSON.parse(line) as { type: string; id: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: string } };
      if (m.type === 'response') {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
        return;
      }
      if (m.type !== 'request') return;
      switch (m.method) {
        case 'protocol/hello':
          write({ type: 'response', id: m.id, result: { protocolVersion: 1 } });
          return;
        case 'query/start':
          startParams.push({ ...(m.params ?? {}) });
          sessionId = String(m.params?.sessionId ?? '');
          write({ type: 'response', id: m.id, result: { sessionId } });
          return;
        case 'query/setPermissionMode':
          permissionModes.push(String(m.params?.mode));
          write({ type: 'response', id: m.id, result: {} });
          return;
        default:
          write({ type: 'response', id: m.id, result: { sessionId } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    permissionModes,
    startParams,
    askApproval(params) {
      const id = nextId--;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        write({ type: 'request', id, method: 'approval/request', params: { sessionId, kind: 'permission', ...params } });
      });
    },
    close: () => new Promise<void>((resolve) => {
      client?.destroy();
      server.close(() => resolve());
    }),
  };
}

describe('HermesAgent auto mode', () => {
  let dir = '';
  let socketPath = '';
  let daemon: FakeDaemon | null = null;
  let handle: AgentSessionHandle | null = null;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hermes-ar-'));
    socketPath = path.join(dir, 'm.sock');
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await daemon?.close();
    handle = null;
    daemon = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function startAuto(
    reviewer: AutoReviewDelegate | undefined,
    permissionMode: 'auto' | 'bypassPermissions' = 'auto',
  ): Promise<{ events: AgentEvent[] }> {
    daemon = await startFakeDaemon(socketPath);
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => undefined,
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {},
      binaryPath: path.join(dir, 'unused'),
      logger: noopLogger,
      resolveHermesManagerSocketPath: () => socketPath,
      preflightHermesRoute: async () => ({ ok: true }),
      ...(reviewer ? { reviewAutoPermissionAction: reviewer } : {}),
    };
    handle = await new HermesAgent(deps).startSession({
      sessionId: 'cindy-1', workingDir: dir, model: 'hermes-default', permissionMode,
    });
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const e of handle!.events()) events.push(e);
    })();
    return { events };
  }

  const reviewerReturning = (
    verdict: 'allow' | 'block' | 'ask',
    seen: AutoReviewRequest[],
    reason?: string,
  ): AutoReviewDelegate => Object.assign(async (req: AutoReviewRequest) => {
    seen.push(req);
    return { verdict, ...(reason ? { reason } : {}) };
  }, {});

  it('offers Auto-review and starts the daemon session in auto', async () => {
    await startAuto(undefined);
    expect(daemon!.startParams[0]?.permissionMode).toBe('auto');
  });

  it('allows a read inside the task folder without asking anyone', async () => {
    const seen: AutoReviewRequest[] = [];
    await startAuto(reviewerReturning('block', seen));
    const answer = await daemon!.askApproval({ requestId: 'c1', toolName: 'read_file', input: { path: 'notes.md' } });
    expect(answer.result).toEqual({ kind: 'permission', behavior: 'allow' });
    expect(seen).toHaveLength(0);
  });

  it('judges a command against the owner words and the task folder, and shows a block in the chat', async () => {
    const seen: AutoReviewRequest[] = [];
    const { events } = await startAuto(reviewerReturning('block', seen, 'deletes outside the project'));
    await handle!.send({ role: 'user', content: 'tidy up the build folder' });
    const answer = await daemon!.askApproval({ requestId: 'c2', toolName: 'terminal', input: { command: 'rm -rf ~/Documents' } });
    expect(answer.result).toEqual({ kind: 'permission', behavior: 'deny', reason: 'deletes outside the project' });
    expect(seen[0]).toMatchObject({
      agentKind: 'hermes',
      sessionId: 'cindy-1',
      workspaceRoots: [dir],
      writableRoots: [dir],
      action: { kind: 'exec', command: 'rm -rf ~/Documents' },
    });
    expect(JSON.stringify(seen[0]!.userIntent)).toContain('tidy up the build folder');
    const shown = events.filter((e) => e.type === 'tool_use' || e.type === 'tool_result_full');
    expect(shown).toEqual([
      expect.objectContaining({ type: 'tool_use', data: expect.objectContaining({ toolName: 'terminal', toolUseId: 'auto-review-c2' }) }),
      expect.objectContaining({
        type: 'tool_result_full',
        data: expect.objectContaining({ isError: true, fullText: 'Blocked by Auto-review: deletes outside the project' }),
      }),
    ]);
  });

  it('asks the owner when the reviewer says ask, and follows the answer', async () => {
    const seen: AutoReviewRequest[] = [];
    await startAuto(reviewerReturning('ask', seen, 'pushes to a remote'));
    const asked: InteractionRequest[] = [];
    let allow = true;
    handle!.setInteractionResolver(async (req) => {
      asked.push(req);
      return { kind: 'permission', behavior: allow ? 'allow' : 'deny' };
    });
    const yes = await daemon!.askApproval({ requestId: 'c3', toolName: 'terminal', input: { command: 'git push' } });
    expect(yes.result).toEqual({ kind: 'permission', behavior: 'allow' });
    expect(asked[0]).toMatchObject({ kind: 'permission', toolName: 'terminal', input: { command: 'git push' }, metadata: { autoReviewReason: 'pushes to a remote' } });
    allow = false;
    const no = await daemon!.askApproval({ requestId: 'c4', toolName: 'terminal', input: { command: 'git push' } });
    expect(no.result).toMatchObject({ kind: 'permission', behavior: 'deny' });
  });

  it('propagates __cindy_risk to autoReviewRisk in metadata (11.9)', async () => {
    const seen: AutoReviewRequest[] = [];
    await startAuto(reviewerReturning('ask', seen, 'unused'));
    const asked: InteractionRequest[] = [];
    handle!.setInteractionResolver(async (req) => {
      asked.push(req);
      return { kind: 'permission', behavior: 'deny' };
    });
    // Simulate the daemon's askClientToReview: __cindy_guard + __cindy_risk in input
    await daemon!.askApproval({
      requestId: 'risk1',
      toolName: 'write_file',
      input: {
        path: '~/.cindy-harness/providers.yaml',
        content: 'x',
        __cindy_guard: 'High-risk system file: ~/.cindy-harness/providers.yaml\nBlast radius: Harness configuration.',
        __cindy_risk: true,
      },
    });
    expect(asked).toHaveLength(1);
    const meta = asked[0].metadata as Record<string, unknown> | undefined;
    expect(meta?.autoReviewRisk).toBe(true);
    expect(meta?.autoReviewReason).toContain('High-risk system file');
  });

  it('does not set autoReviewRisk when __cindy_risk is absent (11.3 guard)', async () => {
    const seen: AutoReviewRequest[] = [];
    await startAuto(reviewerReturning('ask', seen, 'unused'));
    const asked: InteractionRequest[] = [];
    handle!.setInteractionResolver(async (req) => {
      asked.push(req);
      return { kind: 'permission', behavior: 'deny' };
    });
    await daemon!.askApproval({
      requestId: 'guard1',
      toolName: 'terminal',
      input: {
        command: 'git push --force origin main',
        __cindy_guard: 'Cindy guardrail blocked this command: Force-pushing rewrites remote history. (git-force-push). Allow once to override.',
      },
    });
    expect(asked).toHaveLength(1);
    const meta = asked[0].metadata as Record<string, unknown> | undefined;
    expect(meta?.autoReviewRisk).toBeUndefined();
    expect(meta?.autoReviewReason).toContain('guardrail blocked');
  });

  it('fails closed: no reviewer means ask, and no one to ask means deny', async () => {
    const { events } = await startAuto(undefined);
    const answer = await daemon!.askApproval({ requestId: 'c5', toolName: 'terminal', input: { command: 'npm install' } });
    expect(answer.result).toMatchObject({ kind: 'permission', behavior: 'deny' });
    expect(events.some((e) => e.type === 'error' && String((e.data as { message?: string }).message).includes('AUTO_REVIEW_UNAVAILABLE'))).toBe(true);
  });

  it('denies once the task leaves auto, and refuses unreadable requests', async () => {
    await startAuto(undefined);
    await handle!.setPermissionMode('default');
    expect(daemon!.permissionModes).toEqual(['default']);
    const left = await daemon!.askApproval({ requestId: 'c6', toolName: 'read_file', input: { path: 'a' } });
    expect(left.result).toMatchObject({ behavior: 'deny', reason: 'This task is no longer in Auto-review mode.' });
    const bad = await daemon!.askApproval({ requestId: 'c7' });
    expect(bad.result).toMatchObject({ behavior: 'deny' });
  });
});
