import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  extractEventShapes,
  parseNdjsonEvents,
  sortedTokenKeys,
  type HermesStreamEvent,
} from '@cindy/maker-core/hermes-event-shapes';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(dir, 'fixtures');
const FIXTURE = path.join(FIXTURE_DIR, 'fake-hermes.mjs');

/**
 * The installed Hermes CLI the current parity claim is anchored to (ROADMAP 0.7).
 * Each capture's file name carries the version it was taken on, so a CLI upgrade shows up here
 * as a missing capture instead of silently passing against a stale transcript. Re-capture (and
 * move this constant) when the installed CLI moves. This is deliberately *not* the repo pin
 * (`HERMES_CLI_PINNED_VERSION`), which only moves once every pinned behaviour is re-probed.
 */
const PARITY_CLI_VERSION = '0.23.0';

const captures = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => /^real-hermes-.*\.ndjson$/.test(f))
  .sort();

type Ev = HermesStreamEvent;

function captureTexts(): { file: string; real: Ev[] }[] {
  return captures.map((file) => ({
    file,
    real: parseNdjsonEvents(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')),
  }));
}

function runFake(): Ev[] {
  // FAKE_INIT_EMPTY reproduces the real CLI: empty session_id on init.
  const r = spawnSync(process.execPath, [FIXTURE, 'chat', '--format', 'stream-json'], {
    env: { ...process.env, FAKE_INIT_EMPTY: '1' },
    input: 'hi',
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return parseNdjsonEvents(r.stdout);
}

const fake = runFake();

describe('fixture parity with real `hermes chat` transcripts', () => {
  it('has a capture from the CLI version the parity claim is anchored to', () => {
    expect(captures).toContain(`real-hermes-${PARITY_CLI_VERSION}.ndjson`);
  });

  for (const { file, real } of captureTexts()) {
    describe(file, () => {
      it('has the shape the daemon depends on', () => {
        const init = real.find((e) => e.type === 'system' && e.subtype === 'init')!;
        const result = real.find((e) => e.type === 'result')!;
        expect(init.session_id).toBe('');
        expect(typeof result.session_id).toBe('string');
        expect((result.session_id as string).length).toBeGreaterThan(0);
      });

      it('emits every event kind the real CLI emitted, with identical keys and value types', () => {
        const realShapes = extractEventShapes(real);
        const fakeShapes = extractEventShapes(fake);
        for (const [kind, shape] of realShapes) {
          expect(fakeShapes.get(kind), `fixture lacks ${kind}`).toEqual(shape);
        }
      });

      it('result carries the same token and exit-code keys', () => {
        const realResult = real.find((e) => e.type === 'result')!;
        const fakeResult = fake.find((e) => e.type === 'result')!;
        expect(sortedTokenKeys(fakeResult)).toEqual(
          sortedTokenKeys(realResult),
        );
        expect(fakeResult.exit_code).toBe(0);
      });

      it('is redacted', () => {
        const raw = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
        expect(raw).not.toMatch(/sk-|api[_-]?key|bearer/i);
        expect(raw).toContain('local-REDACTED');
        expect(raw).toContain('call_REDACTED');
        expect(raw).not.toMatch(/local-[0-9a-f]{32,}/);
      });
    });
  }

  it('puts the real session_id on result and leaves it empty on init', () => {
    const init = fake.find((e) => e.type === 'system' && e.subtype === 'init')!;
    const result = fake.find((e) => e.type === 'result')!;
    expect(init.session_id).toBe('');
    expect(result.session_id).toBe('fake-h-1');
  });
});
