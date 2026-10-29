import { describe, expect, it } from 'vitest';

import { encodeMessage } from '../codec.js';
import {
  HERMES_MGR_BUNDLE_VERSION,
  METHODS,
  NOTIFICATIONS,
  PROTOCOL_VERSION,
  isRpcMessage,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  makeRpcError,
  type HermesQueryEventNotification,
  type HermesQuerySendParams,
  type HermesQueryStartParams,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from '../protocol.js';

function roundtrip(value: unknown): unknown {
  return JSON.parse(encodeMessage(value as never).trim());
}

describe('protocol constants', () => {
  it('pins the wire version and bundle version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(HERMES_MGR_BUNDLE_VERSION).toBe('0.2.0');
  });

  it('keeps method names namespaced', () => {
    for (const method of Object.values(METHODS)) {
      expect(method).toMatch(/^(protocol|query|session|config)\//);
    }
    for (const name of Object.values(NOTIFICATIONS)) {
      expect(name).toMatch(/^(query|session|client)\//);
    }
  });
});

describe('isRpcMessage type guards', () => {
  it('accepts a well-formed request', () => {
    const msg: RpcRequest = { type: 'request', id: 1, method: METHODS.QUERY_SEND, params: {} };
    expect(isRpcMessage(msg)).toBe(true);
    expect(isRpcRequest(msg)).toBe(true);
    expect(isRpcResponse(msg)).toBe(false);
    expect(isRpcNotification(msg)).toBe(false);
  });

  it('accepts a well-formed response', () => {
    const msg: RpcResponse = { type: 'response', id: 2, result: { ok: true } };
    expect(isRpcMessage(msg)).toBe(true);
    expect(isRpcResponse(msg)).toBe(true);
  });

  it('accepts a response carrying only an error', () => {
    const msg: RpcResponse = { type: 'response', id: 3, error: makeRpcError('INTERNAL', 'boom') };
    expect(isRpcMessage(msg)).toBe(true);
  });

  it('accepts a well-formed notification', () => {
    const msg: RpcNotification = { type: 'notification', method: NOTIFICATIONS.QUERY_EVENT, params: {} };
    expect(isRpcMessage(msg)).toBe(true);
    expect(isRpcNotification(msg)).toBe(true);
  });

  it('rejects malformed shapes', () => {
    expect(isRpcMessage(null)).toBe(false);
    expect(isRpcMessage('request')).toBe(false);
    expect(isRpcMessage({ type: 'request', id: 'not-a-number', method: 'x' })).toBe(false);
    expect(isRpcMessage({ type: 'request', method: 'x' })).toBe(false);
    expect(isRpcMessage({ type: 'response' })).toBe(false);
    expect(isRpcMessage({ type: 'notification', id: 1 })).toBe(false);
    expect(isRpcMessage({ type: 'bogus' })).toBe(false);
  });
});

describe('makeRpcError', () => {
  it('omits data when absent and includes it when present', () => {
    expect(makeRpcError('SESSION_NOT_FOUND', 'nope')).toEqual({
      code: 'SESSION_NOT_FOUND',
      message: 'nope',
    });
    expect(makeRpcError('HERMES_ERROR', 'exit 1', { stderrTail: 'boom' })).toEqual({
      code: 'HERMES_ERROR',
      message: 'exit 1',
      data: { stderrTail: 'boom' },
    });
  });
});

describe('encodeMessage roundtrip', () => {
  it('preserves a query/start payload byte-for-byte through JSON', () => {
    const params: HermesQueryStartParams = {
      sessionId: 'cindy-session-1',
      resumeHermesSessionId: 'hermes-abc',
      cwd: '/tmp/proj',
      permissionMode: 'bypassPermissions',
      maxTurns: 20,
      runBudgetSeconds: 600,
    };
    const decoded = roundtrip({ type: 'request', id: 7, method: METHODS.QUERY_START, params });
    expect(decoded).toEqual({ type: 'request', id: 7, method: METHODS.QUERY_START, params });
  });

  it('preserves verbatim Hermes events with unicode content', () => {
    const notification: HermesQueryEventNotification = {
      sessionId: 'cindy-session-1',
      seq: 3,
      ts: '2026-10-27T01:00:00.000Z',
      event: { type: 'text', text: '你好 🌏 world' },
    };
    const decoded = roundtrip({
      type: 'notification',
      method: NOTIFICATIONS.QUERY_EVENT,
      params: notification,
    });
    expect(decoded).toEqual({
      type: 'notification',
      method: NOTIFICATIONS.QUERY_EVENT,
      params: notification,
    });
  });

  it('emits exactly one trailing newline', () => {
    const line = encodeMessage({ type: 'request', id: 1, method: METHODS.PROTOCOL_HELLO, params: {} });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
  });

  it('keeps send params with reserved image field serializable', () => {
    const params: HermesQuerySendParams = { sessionId: 's1', text: 'do the thing' };
    const decoded = roundtrip({ type: 'request', id: 9, method: METHODS.QUERY_SEND, params });
    expect(decoded).toEqual({ type: 'request', id: 9, method: METHODS.QUERY_SEND, params });
  });
});
