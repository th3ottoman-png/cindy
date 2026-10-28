import { describe, expect, it, vi } from 'vitest';

import { NDJSONDecoder, encodeMessage } from '../codec.js';
import { METHODS, NOTIFICATIONS, type RpcMessage } from '../protocol.js';

function request(id: number): RpcMessage {
  return { type: 'request', id, method: METHODS.QUERY_SEND, params: { sessionId: 's', text: 'x' } };
}

describe('NDJSONDecoder', () => {
  it('decodes multiple complete lines from one chunk', () => {
    const decoder = new NDJSONDecoder();
    const input = encodeMessage(request(1)) + encodeMessage(request(2));
    const out = decoder.push(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'request', id: 1 });
    expect(out[1]).toMatchObject({ type: 'request', id: 2 });
  });

  it('buffers a partial line across pushes until the newline arrives', () => {
    const decoder = new NDJSONDecoder();
    const full = encodeMessage(request(5));
    const cut = Math.floor(full.length / 2);
    expect(decoder.push(full.slice(0, cut))).toEqual([]);
    const out = decoder.push(full.slice(cut));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'request', id: 5 });
  });

  it('reassembles multi-byte UTF-8 characters split across chunk boundaries', () => {
    const decoder = new NDJSONDecoder();
    const bytes = Buffer.from(encodeMessage(request(3)).replace('"x"', '"你好🌏"'), 'utf8');
    // Split in the middle of the multibyte sequence, not at a char boundary.
    const cutA = bytes.indexOf(Buffer.from('你', 'utf8')) + 1;
    const out1 = decoder.push(bytes.subarray(0, cutA));
    expect(out1).toEqual([]);
    const out2 = decoder.push(bytes.subarray(cutA));
    expect(out2).toHaveLength(1);
    const params = (out2[0] as { params: { text: string } }).params;
    expect(params.text).toBe('你好🌏');
  });

  it('tolerates CRLF line endings', () => {
    const decoder = new NDJSONDecoder();
    const out = decoder.push(encodeMessage(request(1)).replace('\n', '\r\n'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1 });
  });

  it('skips empty lines and reports corrupt lines without dying', () => {
    const onCorruptLine = vi.fn();
    const decoder = new NDJSONDecoder({ onCorruptLine });
    const input = '\n' + encodeMessage(request(1)) + 'not-json\n' + '{"nope":1}\n';
    const out = decoder.push(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1 });
    expect(onCorruptLine).toHaveBeenCalledTimes(2);
  });

  it('keeps the stream usable after a corrupt line', () => {
    const onCorruptLine = vi.fn();
    const decoder = new NDJSONDecoder({ onCorruptLine });
    decoder.push('garbage\n');
    const out = decoder.push(encodeMessage(request(2)));
    expect(out).toHaveLength(1);
    expect(onCorruptLine).toHaveBeenCalledTimes(1);
  });

  it('discards the buffer and reports when no newline ever arrives (OOM guard)', () => {
    const onCorruptLine = vi.fn();
    const decoder = new NDJSONDecoder({ onCorruptLine });
    // Patch the cap rather than allocating 64M chars in the test.
    const original = Object.getOwnPropertyDescriptor(NDJSONDecoder, 'MAX_BUFFER_CHARS');
    Object.defineProperty(NDJSONDecoder, 'MAX_BUFFER_CHARS', { value: 64, configurable: true });
    try {
      expect(decoder.push('a'.repeat(100))).toEqual([]);
      expect(onCorruptLine).toHaveBeenCalledTimes(1);
      expect(onCorruptLine.mock.calls[0][1].message).toContain('OOM');
    } finally {
      if (original) Object.defineProperty(NDJSONDecoder, 'MAX_BUFFER_CHARS', original);
    }
    // With the real cap restored, a well-formed frame after the flush decodes
    // normally (in production the 64M cap exceeds any legitimate frame, so a
    // real frame can never re-trip the guard the way the patched one does).
    const out = decoder.push(encodeMessage(request(4)));
    expect(out).toHaveLength(1);
  });

  it('reset() drops the stale partial line so it cannot merge into a new stream', () => {
    const decoder = new NDJSONDecoder();
    const full = encodeMessage(request(6));
    decoder.push(full.slice(0, 4));
    decoder.reset();
    expect(decoder.push(full)).toHaveLength(1);
  });
});

describe('encodeMessage / decoder integration', () => {
  it('roundtrips every message kind through the decoder', () => {
    const decoder = new NDJSONDecoder();
    const messages: RpcMessage[] = [
      { type: 'request', id: 1, method: METHODS.PROTOCOL_HELLO, params: { protocolVersion: 1 } },
      { type: 'response', id: 1, result: { protocolVersion: 1 } },
      { type: 'notification', method: NOTIFICATIONS.SESSION_CLOSED, params: { sessionId: 's', reason: 'completed' } },
    ];
    const out = decoder.push(messages.map(encodeMessage).join(''));
    expect(out).toEqual(messages);
  });
});
