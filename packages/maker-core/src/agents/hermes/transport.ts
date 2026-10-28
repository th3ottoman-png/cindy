/**
 * HermesTransport — NDJSON client for the `hermes-mgr` daemon's local socket.
 *
 * The host owns the daemon's lifecycle (spawn/ensure/hello) and injects its
 * socket path; this transport only connects (unix socket, or a Windows named
 * pipe via the same API), speaks the mirrored protocol from `./protocol.ts`,
 * and tears the connection down. It never spawns a process.
 *
 * Failure model:
 *   - connection refused / socket absent before hello surfaces as
 *     `HermesDaemonUnreachableError` (the daemon is confirmed not started).
 *   - `request()` rejects when the write fails, the daemon answers with an RPC
 *     error, the request times out, or the socket closes first (close rejects
 *     every pending request).
 *   - a corrupt stdout line is logged and dropped; the reader loop never
 *     throws.
 *   - `close()` destroys the socket and is idempotent.
 */

import * as net from 'node:net';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { Logger } from '../../interfaces/logger.js';
import {
  HERMES_METHODS,
  HERMES_MGR_PROTOCOL_VERSION,
  HermesNdjsonDecoder,
  HermesProtocolMismatchError,
  HermesRpcRequestError,
  HermesRpcTimeoutError,
  encodeHermesMessage,
  isHermesRpcNotification,
  isHermesRpcRequest,
  isHermesRpcResponse,
  type HermesHelloResult,
  type HermesRpcMessage,
  type HermesRpcNotification,
  type HermesRpcResponse,
} from './protocol.js';

export interface HermesTransportOptions {
  /** Absolute path to the daemon's unix socket (Windows named pipe path on win32). */
  socketPath: string;
  logger: Logger;
  /** Per-request deadline; the startup hello uses this same budget. */
  requestTimeoutMs?: number;
}

export interface HermesTransportCloseInfo {
  reason: string;
}

export type HermesNotificationHandler = (notification: HermesRpcNotification) => void;
export type HermesCloseHandler = (info: HermesTransportCloseInfo) => void;

/** The local daemon is not listening (or its socket vanished) before the handshake. */
export class HermesDaemonUnreachableError extends Error {
  readonly code = 'HERMES_MGR_UNREACHABLE';

  constructor(
    public readonly socketPath: string,
    public readonly cause: unknown,
  ) {
    super(
      `hermes-mgr daemon unreachable at ${socketPath}: `
      + (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = 'HermesDaemonUnreachableError';
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class HermesTransport {
  private readonly socket: net.Socket;
  private readonly decoder: HermesNdjsonDecoder;
  private readonly logger: Logger;
  private readonly requestTimeoutMs: number;
  private readonly socketPath: string;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<HermesNotificationHandler>();
  private readonly closeHandlers = new Set<HermesCloseHandler>();
  private readonly ready: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private nextRequestId = 1;
  private connected = false;
  private closed = false;
  private closing = false;
  private connectError: Error | null = null;
  private closeError: Error | null = null;
  private closeInfo: HermesTransportCloseInfo | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(opts: HermesTransportOptions) {
    this.logger = opts.logger;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.socketPath = opts.socketPath;
    this.decoder = new HermesNdjsonDecoder({
      onCorruptLine: (line, error) => {
        this.logger.warn('hermes-mgr: corrupt NDJSON line dropped', {
          error: error.message,
          line: redactSensitiveText(line).slice(0, 500),
        });
      },
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // hello() awaits `ready`; keep an unobserved rejection from surfacing as an
    // unhandled rejection if the caller never reaches hello().
    void this.ready.catch(() => undefined);

    this.socket = net.connect({ path: opts.socketPath });
    this.socket.on('connect', () => {
      this.connected = true;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
    });
    this.socket.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) this.handleMessage(message);
    });
    this.socket.on('error', (error) => {
      this.logger.warn('hermes-mgr socket error', { message: error.message });
      if (!this.connected) {
        this.connectError = new HermesDaemonUnreachableError(this.socketPath, error);
        this.fireClose(this.connectError.message);
      }
    });
    this.socket.on('close', () => {
      this.fireClose('hermes-mgr socket closed');
    });
  }

  isClosed(): boolean {
    return this.closed || this.closing;
  }

  /** protocol/hello with the mirrored version gate. */
  async hello(): Promise<HermesHelloResult> {
    await this.ready;
    let result: HermesHelloResult;
    try {
      result = await this.request<HermesHelloResult>(
        HERMES_METHODS.PROTOCOL_HELLO,
        { protocolVersion: HERMES_MGR_PROTOCOL_VERSION },
      );
    } catch (error) {
      // The daemon gates mismatched hellos itself; its rejection is the same
      // upgrade error, not a startup failure.
      if (error instanceof HermesRpcRequestError && error.code === 'INVALID_PROTOCOL_VERSION') {
        throw new HermesProtocolMismatchError(undefined);
      }
      throw error;
    }
    if (typeof result?.protocolVersion !== 'number'
      || result.protocolVersion !== HERMES_MGR_PROTOCOL_VERSION) {
      throw new HermesProtocolMismatchError(
        typeof result?.protocolVersion === 'number' ? result.protocolVersion : undefined,
      );
    }
    return result;
  }

  request<R = unknown>(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<R> {
    if (this.closed || this.closing) {
      return Promise.reject(this.closeError ?? new Error('hermes-mgr transport is closed'));
    }
    const id = this.nextRequestId++;
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new HermesRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      const line = encodeHermesMessage({ type: 'request', id, method, params });
      this.socket.write(line, (error?: Error | null) => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  onNotification(handler: HermesNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onClose(handler: HermesCloseHandler): () => void {
    if (this.closeInfo) {
      try {
        handler(this.closeInfo);
      } catch {
        // Subscriber failures must not break late registration.
      }
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<void>((resolve) => {
      const onClose = (): void => {
        this.closeHandlers.delete(onClose);
        resolve();
      };
      this.closeHandlers.add(onClose);
      try {
        this.socket.destroy();
      } catch {
        // The socket's close event is the only settlement path; a destroyed
        // socket still emits it.
      }
    });
    return this.closePromise;
  }

  private fireClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = { reason };
    const error = this.connectError ?? new Error(reason);
    this.closeError = error;
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler({ reason });
      } catch {
        // Subscriber failures must not break transport teardown.
      }
    }
  }

  private handleMessage(message: HermesRpcMessage): void {
    if (this.closed) return;
    if (isHermesRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (isHermesRpcNotification(message)) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(message);
        } catch {
          // Notification subscribers own their failure handling.
        }
      }
      return;
    }
    if (isHermesRpcRequest(message)) {
      // v1 reserves daemon→client requests for M3 approvals; the daemon treats
      // an UNKNOWN_METHOD answer as a deny.
      if (this.closing || this.closed) return;
      this.socket.write(encodeHermesMessage({
        type: 'response',
        id: message.id,
        error: { code: 'UNKNOWN_METHOD', message: `no client handler for ${message.method}` },
      }));
    }
  }

  private handleResponse(response: HermesRpcResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) {
      this.logger.debug('hermes-mgr: unmatched response', { id: response.id });
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.id);
    if (response.error) {
      entry.reject(new HermesRpcRequestError(
        response.error.code,
        response.error.message,
        response.error.data,
      ));
      return;
    }
    entry.resolve(response.result);
  }
}

export function createHermesTransport(opts: HermesTransportOptions): HermesTransport {
  return new HermesTransport(opts);
}
