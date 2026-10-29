import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(dir, 'fixtures', 'fake-hermes.mjs');
const REAL = path.join(dir, 'fixtures', 'real-hermes-transcript.ndjson');

type Ev = Record<string, unknown> & { type: string };

function parse(text: string): Ev[] {
  return text.trim().split('\n').map((l) => JSON.parse(l) as Ev);
}

function runFake(): Ev[] {
  // FAKE_INIT_EMPTY reproduces the real CLI: empty session_id on init.
  const r = spawnSync(process.execPath, [FIXTURE, 'chat', '--format', 'stream-json'], {
    env: { ...process.env, FAKE_INIT_EMPTY: '1' },
    input: 'hi',
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return parse(r.stdout);
}

/** event kind → sorted key list + JS type of each value. */
function shapes(events: Ev[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const e of events) {
    const kind = e.type === 'system' ? `system/${String(e.subtype)}` : e.type;
    const shape: Record<string, string> = {};
    for (const k of Object.keys(e).sort()) shape[k] = typeof e[k];
    if (!out.has(kind)) out.set(kind, shape);
  }
  return out;
}

describe('fake-hermes fixture parity with a real `hermes chat` transcript', () => {
  const real = parse(fs.readFileSync(REAL, 'utf8'));
  const fake = runFake();

  it('the real transcript has the shape the daemon depends on', () => {
    const init = real.find((e) => e.type === 'system' && e.subtype === 'init')!;
    const result = real.find((e) => e.type === 'result')!;
    expect(init.session_id).toBe('');
    expect(typeof result.session_id).toBe('string');
    expect((result.session_id as string).length).toBeGreaterThan(0);
  });

  it('emits every event kind the real CLI emitted, with identical keys and value types', () => {
    const realShapes = shapes(real);
    const fakeShapes = shapes(fake);
    for (const [kind, shape] of realShapes) {
      expect(fakeShapes.get(kind), `fixture lacks ${kind}`).toEqual(shape);
    }
  });

  it('puts the real session_id on result and leaves it empty on init', () => {
    const init = fake.find((e) => e.type === 'system' && e.subtype === 'init')!;
    const result = fake.find((e) => e.type === 'result')!;
    expect(init.session_id).toBe('');
    expect(result.session_id).toBe('fake-h-1');
  });

  it('result carries the same token and exit-code keys', () => {
    const realResult = real.find((e) => e.type === 'result')!;
    const fakeResult = fake.find((e) => e.type === 'result')!;
    expect(Object.keys(fakeResult.tokens as object).sort())
      .toEqual(Object.keys(realResult.tokens as object).sort());
    expect(fakeResult.exit_code).toBe(0);
  });

  it('keeps the real transcript redacted', () => {
    const raw = fs.readFileSync(REAL, 'utf8');
    expect(raw).not.toMatch(/sk-|api[_-]?key|bearer/i);
    expect(raw).toContain('local-REDACTED');
  });
});
