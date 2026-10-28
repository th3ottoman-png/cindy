/**
 * RpcClient — NDJSON RPC over any Duplex stream (unix socket / TCP / SSH exec).
 * Mirrors packages/maker-cc-manager/src/client.ts semantics: caller owns the
 * stream, hello() gates other requests, per-request opt-in timeouts, and
 * close subscribers fire exactly once (including immediately when the stream
 * already closed) so waiters never wedge on a dead daemon.
 */

import type { Duplex } from 'node:stream';

import { NDJSONDecoder, encodeMessage } from './codec.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  type HelloParams,
  type HelloResult,
  type RpcError,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from './protocol.js';

export interface RpcClientOptions {
  onNotification?: (n: RpcNotification) => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
  clientId?: string;
  onCorruptLine?: (line: string, err: Error) => void;
}

export interface RpcRequestOptions {
  timeoutMs?: number;
}

export class RpcClientError extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(`[${rpcError.code}] ${rpcError.message}`);
    this.name = 'RpcClientError';
  }
}

interface PendingEntry {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export type NotificationSubscriber = (n: RpcNotification) => void;
export type CloseSubscriber = () => void;
export type ServerRequestHandler = (params: unknown) => Promise<unknown> | unknown;

export class RpcClient {
  private nextId: RpcId = 1;
  private readonly pending = new Map<RpcId, PendingEntry>();
  private readonly decoder: NDJSONDecoder;
  private readonly onNotificationCtor?: (n: RpcNotification) => void;
  private readonly onClose?: () => void;
  private readonly onError?: (err: Error) => void;
  private readonly clientId?: string;
  private readonly listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private readonly subscribers = new Set<NotificationSubscriber>();
  private readonly closeSubscribers = new Set<CloseSubscriber>();
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();
  private closedFired = false;
  private disposed = false;

  constructor(
    private readonly stream: Duplex,
    opts: RpcClientOptions = {},
  ) {
    this.onNotificationCtor = opts.onNotification;
    this.onClose = opts.onClose;
    this.onError = opts.onError;
    this.clientId = opts.clientId;
    this.decoder = new NDJSONDecoder({ onCorruptLine: opts.onCorruptLine });
    this.attach();
  }

  /**
   * Send protocol/hello and validate the version. Pass opts.timeoutMs — a
   * hung daemon otherwise blocks the client forever.
   */
  async hello(opts: RpcRequestOptions = {}): Promise<HelloResult> {
    const params: HelloParams = {
      protocolVersion: PROTOCOL_VERSION,
      ...(this.clientId ? { clientId: this.clientId } : {}),
    };
    return await this.request<HelloResult>(METHODS.PROTOCOL_HELLO, params, opts);
  }

  async request<R = unknown>(
    method: string,
    params: unknown,
    opts: RpcRequestOptions = {},
  ): Promise<R> {
    if (this.disposed || this.closedFired || this.stream.destroyed) {
      throw new Error('RpcClient is disposed or stream closed');
    }
    const id = this.nextId++;
    return await new Promise<R>((resolve, reject) => {
      const entry: PendingEntry = { resolve: resolve as (v: unknown) => void, reject };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`RPC ${method} timed out after ${opts.timeoutMs}ms`));
          }
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.stream.write(encodeMessage({ type: 'request', id, method, params }));
      } catch (err) {
        if (this.pending.delete(id)) {
          if (entry.timer) clearTimeout(entry.timer);
          reject(err as Error);
        }
      }
    });
  }

  subscribe(handler: NotificationSubscriber): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  subscribeClose(handler: CloseSubscriber): () => void {
    if (this.closedFired) {
      try {
        handler();
      } catch {
        /* */
      }
      return () => undefined;
    }
    this.closeSubscribers.add(handler);
    return () => {
      this.closeSubscribers.delete(handler);
    };
  }

  isClosed(): boolean {
    return this.closedFired;
  }

  notify(method: string, params: unknown): void {
    if (this.disposed || this.closedFired || this.stream.destroyed) {
      throw new Error('RpcClient is disposed or stream closed');
    }
    this.stream.write(encodeMessage({ type: 'notification', method, params }));
  }

  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Detach listeners and reject pending requests. Does NOT close the stream. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { event, fn } of this.listeners) {
      this.stream.off(event, fn);
    }
    this.listeners.length = 0;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error('RpcClient disposed'));
    }
    this.pending.clear();
    this.fireClose();
  }

  private attach(): void {
    const onData = (chunk: Buffer | string): void => {
      for (const msg of this.decoder.push(chunk)) {
        this.handleIncoming(msg);
      }
    };
    const onClose = (): void => {
      for (const [, entry] of this.pending) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error('RPC stream closed'));
      }
      this.pending.clear();
      this.onClose?.();
      this.fireClose();
    };
    const onError = (err: Error): void => {
      this.onError?.(err);
    };
    this.stream.on('data', onData);
    this.stream.on('close', onClose);
    this.stream.on('error', onError);
    this.listeners.push({ event: 'data', fn: onData as (...args: unknown[]) => void });
    this.listeners.push({ event: 'close', fn: onClose as (...args: unknown[]) => void });
    this.listeners.push({ event: 'error', fn: onError as (...args: unknown[]) => void });
  }

  private handleIncoming(msg: RpcMessage): void {
    if (isRpcResponse(msg)) {
      this.handleResponse(msg);
      return;
    }
    if (isRpcNotification(msg)) {
      this.onNotificationCtor?.(msg);
      for (const sub of this.subscribers) {
        try {
          sub(msg);
        } catch {
          /* ignore subscriber errors */
        }
      }
      return;
    }
    if (isRpcRequest(msg)) {
      void this.handleServerRequest(msg);
    }
  }

  private async handleServerRequest(req: RpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    if (!handler) {
      const response: RpcResponse = {
        type: 'response',
        id: req.id,
        error: { code: 'UNKNOWN_METHOD', message: `no client handler for ${req.method}` },
      };
      if (!this.disposed) this.stream.write(encodeMessage(response));
      return;
    }
    try {
      const result = await handler(req.params);
      const response: RpcResponse = { type: 'response', id: req.id, result };
      if (!this.disposed) this.stream.write(encodeMessage(response));
    } catch (err) {
      const response: RpcResponse = {
        type: 'response',
        id: req.id,
        error: { code: 'INTERNAL', message: (err as Error)?.message ?? 'handler error' },
      };
      if (!this.disposed) this.stream.write(encodeMessage(response));
    }
  }

  private fireClose(): void {
    if (this.closedFired) return;
    this.closedFired = true;
    for (const sub of this.closeSubscribers) {
      try {
        sub();
      } catch {
        /* */
      }
    }
    this.closeSubscribers.clear();
  }

  private handleResponse(msg: RpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return; // late response after timeout — drop
    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new RpcClientError(msg.error));
    } else {
      entry.resolve(msg.result);
    }
  }
}
