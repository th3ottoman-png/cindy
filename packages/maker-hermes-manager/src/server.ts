/**
 * Manager server skeleton — NDJSON RPC over a unix socket (Windows named pipe
 * supported). Mirrors packages/maker-cc-manager/src/server.ts semantics:
 * versioned hello handshake gates every other method, handlers are pluggable,
 * and server→client reverse-requests use negative ids.
 */

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { NDJSONDecoder, encodeMessage } from './codec.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  isRpcRequest,
  isRpcResponse,
  makeRpcError,
  type HelloParams,
  type HelloResult,
  type RpcErrorCode,
  type RpcId,
  type RpcMessage,
  type RpcRequest,
} from './protocol.js';

export interface ManagerServerOptions {
  /** Absolute socket path (or \\.\pipe\name). Parent dir is created if missing. */
  socketPath: string;
  managerVersion?: string;
  logger?: ManagerLogger;
}

export interface ManagerLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const defaultLogger: ManagerLogger = {
  debug: () => undefined,
  info: (msg, ctx) => console.error('[hermes-mgr][info]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.error('[hermes-mgr][warn]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[hermes-mgr][error]', msg, ctx ?? ''),
};

export interface ClientCtx {
  socket: net.Socket;
  decoder: NDJSONDecoder;
  /** True after a successful PROTOCOL_HELLO. */
  initialized: boolean;
  clientId?: string;
}

export type MethodHandler = (params: unknown, ctx: ClientCtx) => Promise<unknown> | unknown;

interface PendingServerRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  ctx: ClientCtx;
}

export class ManagerServer {
  private readonly server: net.Server;
  private readonly logger: ManagerLogger;
  private readonly socketPath: string;
  private readonly managerVersion?: string;
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly clients = new Set<ClientCtx>();
  private readonly pendingServerRequests = new Map<RpcId, PendingServerRequest>();
  private readonly clientCloseListeners: Array<(ctx: ClientCtx) => void> = [];
  private nextServerRequestId: RpcId = -1;
  private started = false;

  constructor(opts: ManagerServerOptions) {
    this.socketPath = opts.socketPath;
    this.managerVersion = opts.managerVersion;
    this.logger = opts.logger ?? defaultLogger;
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.registerBuiltinHandlers();
  }

  setHandler(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Send a request FROM daemon TO client and await the response. Negative ids
   * avoid collision with client→daemon request ids. Rejects on timeout or
   * client disconnect.
   */
  async sendRequest<R = unknown>(
    ctx: ClientCtx,
    method: string,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<R> {
    const id = this.nextServerRequestId--;
    return await new Promise<R>((resolve, reject) => {
      const entry: PendingServerRequest = { resolve: resolve as (v: unknown) => void, reject, ctx };
      const timeoutMs = opts.timeoutMs ?? 120_000;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pendingServerRequests.delete(id)) {
            reject(new Error(`server request ${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      this.pendingServerRequests.set(id, entry);
      const request: RpcRequest = { type: 'request', id, method, params };
      if (!ctx.socket.destroyed) {
        ctx.socket.write(encodeMessage(request));
      } else {
        this.pendingServerRequests.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new Error('client socket already destroyed'));
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!isWindowsNamedPipe(this.socketPath)) {
      await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
      // Clean stale socket file from a prior crash (unix pattern).
      await fs.rm(this.socketPath, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.socketPath);
    });
    this.started = true;
    this.logger.info('manager started', { socketPath: this.socketPath });
  }

  onClientClose(listener: (ctx: ClientCtx) => void): void {
    this.clientCloseListeners.push(listener);
  }

  /** Notify every initialized client; best-effort, ignores dead sockets. */
  broadcast(method: string, params: unknown): void {
    for (const ctx of this.clients) {
      if (!ctx.initialized || ctx.socket.destroyed) continue;
      ctx.socket.write(
        encodeMessage({ type: 'notification', method, params }),
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    for (const ctx of this.clients) {
      try {
        ctx.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (!isWindowsNamedPipe(this.socketPath)) {
      await fs.rm(this.socketPath, { force: true });
    }
    this.started = false;
    this.logger.info('manager stopped');
  }

  private registerBuiltinHandlers(): void {
    this.handlers.set(METHODS.PROTOCOL_HELLO, async (params, ctx) => {
      const p = (params ?? {}) as Partial<HelloParams>;
      if (typeof p.protocolVersion !== 'number') {
        throw makeServerError('INVALID_PARAMS', 'protocolVersion is required (number)');
      }
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw makeServerError(
          'INVALID_PROTOCOL_VERSION',
          `client version ${p.protocolVersion} != server version ${PROTOCOL_VERSION}`,
        );
      }
      ctx.initialized = true;
      ctx.clientId = p.clientId;
      const result: HelloResult = {
        protocolVersion: PROTOCOL_VERSION,
        ...(this.managerVersion ? { managerVersion: this.managerVersion } : {}),
      };
      return result;
    });
  }

  private onConnection(socket: net.Socket): void {
    const ctx: ClientCtx = {
      socket,
      decoder: new NDJSONDecoder({
        onCorruptLine: (line, err) =>
          this.logger.warn('corrupt ndjson line', { error: err.message, line: line.slice(0, 200) }),
      }),
      initialized: false,
    };
    this.clients.add(ctx);
    socket.on('data', (chunk: Buffer) => {
      for (const msg of ctx.decoder.push(chunk)) {
        void this.dispatch(ctx, msg);
      }
    });
    socket.on('close', () => {
      this.clients.delete(ctx);
      this.rejectPendingForCtx(ctx);
      for (const listener of this.clientCloseListeners) {
        try { listener(ctx); } catch { /* */ }
      }
    });
    socket.on('error', (err) => {
      this.logger.warn('client socket error', { error: err.message });
    });
  }

  private async dispatch(ctx: ClientCtx, msg: RpcMessage): Promise<void> {
    if (isRpcResponse(msg)) {
      this.handleServerRequestResponse(msg);
      return;
    }
    if (!isRpcRequest(msg)) {
      return; // client notifications are not used in v1
    }
    const request = msg as RpcRequest;
    if (!ctx.initialized && request.method !== METHODS.PROTOCOL_HELLO) {
      this.sendResponse(ctx, request.id, undefined, {
        code: 'NOT_INITIALIZED',
        message: 'send protocol/hello first',
      });
      return;
    }
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.sendResponse(ctx, request.id, undefined, {
        code: 'UNKNOWN_METHOD',
        message: `no handler for method ${request.method}`,
      });
      return;
    }
    try {
      const result = await handler(request.params, ctx);
      this.sendResponse(ctx, request.id, result, undefined);
    } catch (err) {
      const e = err as { code?: RpcErrorCode; message?: string; data?: unknown };
      const code: RpcErrorCode = e.code && isValidErrorCode(e.code) ? e.code : 'INTERNAL';
      this.sendResponse(ctx, request.id, undefined, {
        code,
        message: e.message ?? 'internal error',
        ...(e.data !== undefined ? { data: e.data } : {}),
      });
    }
  }

  private rejectPendingForCtx(ctx: ClientCtx): void {
    for (const [id, entry] of this.pendingServerRequests) {
      if (entry.ctx === ctx) {
        this.pendingServerRequests.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error('client disconnected before responding'));
      }
    }
  }

  private handleServerRequestResponse(msg: RpcMessage): void {
    if (!isRpcResponse(msg)) return;
    const entry = this.pendingServerRequests.get(msg.id);
    if (!entry) return;
    this.pendingServerRequests.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  private sendResponse(
    ctx: ClientCtx,
    id: number,
    result: unknown,
    error: { code: RpcErrorCode; message: string; data?: unknown } | undefined,
  ): void {
    const response = {
      type: 'response' as const,
      id,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error: makeRpcError(error.code, error.message, error.data) } : {}),
    };
    if (!ctx.socket.destroyed) {
      ctx.socket.write(encodeMessage(response));
    }
  }
}

interface ServerError extends Error {
  code: RpcErrorCode;
  data?: unknown;
}

function makeServerError(code: RpcErrorCode, message: string, data?: unknown): ServerError {
  const err = new Error(message) as ServerError;
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

const ERROR_CODES = new Set<RpcErrorCode>([
  'INVALID_PROTOCOL_VERSION',
  'UNKNOWN_METHOD',
  'INVALID_PARAMS',
  'NOT_INITIALIZED',
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_EXISTS',
  'TURN_ALREADY_RUNNING',
  'SESSION_KILL_PENDING',
  'SESSION_KILL_TIMEOUT',
  'HERMES_ERROR',
  'INTERNAL',
]);

function isValidErrorCode(code: string): code is RpcErrorCode {
  return ERROR_CODES.has(code as RpcErrorCode);
}

function isWindowsNamedPipe(p: string): boolean {
  return /^\\\\[.?]\\pipe\\/.test(p);
}
