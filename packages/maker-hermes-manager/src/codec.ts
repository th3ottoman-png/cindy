/**
 * NDJSON line codec: parses a stream of chunks into RpcMessage[], one per line.
 *
 * Chunk boundaries do NOT align with line boundaries — the partial tail is
 * buffered across pushes. A JSON.parse failure on one line is reported via
 * onCorruptLine and skipped; the stream itself stays alive.
 *
 * UTF-8 safety: SSH/TCP/pipe chunks can split a multi-byte character across
 * buffer boundaries. Per-chunk toString('utf8') would turn the partial
 * sequence into U+FFFD garbage (corrupting CJK text and emoji), so Buffer
 * input goes through StringDecoder, which holds incomplete multi-byte
 * sequences until the continuation bytes arrive.
 */

import { StringDecoder } from 'node:string_decoder';

import { isRpcMessage, type RpcMessage } from './protocol.js';

export interface NDJSONDecoderOptions {
  /** Called when a non-empty line fails JSON.parse OR fails isRpcMessage. */
  onCorruptLine?: (line: string, error: Error) => void;
}

export class NDJSONDecoder {
  /**
   * Hard cap on the unparsed buffer (chars). A stream that never sends '\n'
   * (corrupt peer, truncated giant frame) would otherwise grow the buffer
   * without bound and OOM the host process. Legitimate single frames (even a
   * message with inline base64 images) sit far below this; hitting the cap
   * means the stream is junk — drop it and report.
   */
  private static readonly MAX_BUFFER_CHARS = 64 * 1024 * 1024;

  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly onCorruptLine?: (line: string, error: Error) => void;

  constructor(opts: NDJSONDecoderOptions = {}) {
    this.onCorruptLine = opts.onCorruptLine;
  }

  /**
   * Feed a chunk of incoming bytes/string. Returns complete RpcMessages
   * extracted; the trailing partial line is buffered for the next push.
   */
  push(chunk: string | Buffer): RpcMessage[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer += text;
    if (this.buffer.length > NDJSONDecoder.MAX_BUFFER_CHARS) {
      const sample = this.buffer.slice(0, 256);
      this.buffer = '';
      this.onCorruptLine?.(
        sample,
        new Error(
          `NDJSON buffer exceeded ${NDJSONDecoder.MAX_BUFFER_CHARS} chars without a complete line; discarded to prevent OOM`,
        ),
      );
      return [];
    }
    if (!this.buffer.includes('\n')) {
      return [];
    }
    const lines = this.buffer.split('\n');
    // Last element is '' (chunk ended on \n) or a partial line — buffer it.
    this.buffer = lines.pop() ?? '';
    const out: RpcMessage[] = [];
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.onCorruptLine?.(line, err as Error);
        continue;
      }
      if (!isRpcMessage(parsed)) {
        this.onCorruptLine?.(line, new Error('not a valid RpcMessage shape'));
        continue;
      }
      out.push(parsed);
    }
    return out;
  }

  /**
   * Drop buffered state. Use on reconnect so a stale partial line (and any
   * held multi-byte tail) cannot merge into the new stream's first frame.
   */
  reset(): void {
    this.buffer = '';
    this.decoder.end();
  }
}

/**
 * Encode an RpcMessage as a single NDJSON line (with trailing '\n').
 * Caller writes the returned string verbatim to the underlying stream.
 */
export function encodeMessage(msg: RpcMessage): string {
  return JSON.stringify(msg) + '\n';
}
