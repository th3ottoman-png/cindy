import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyPluginState,
  readPluginState,
  setPluginEnabled,
  writePluginState,
} from '../plugin-state';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-state-'));
  file = path.join(dir, 'plugins.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('plugin state (ROADMAP 4.2b)', () => {
  it('a missing file is the empty state with no issue', () => {
    expect(readPluginState(file)).toEqual({ state: { disabled: [] } });
  });

  it('a corrupt file falls back to all-enabled with an issue, and never throws', () => {
    fs.writeFileSync(file, '{not json');
    const read = readPluginState(file);
    expect(read.state).toEqual({ disabled: [] });
    expect(read.issue).toContain('not valid JSON');

    fs.writeFileSync(file, '["disabled"]');
    expect(readPluginState(file).issue).toContain('must be an object');

    fs.writeFileSync(file, '{"disabled": "hello"}');
    expect(readPluginState(file).issue).toContain('"disabled" must be an array');
  });

  it('reads a hand-edited file, dropping entries that are not valid plugin names', () => {
    fs.writeFileSync(file, '{\n  "disabled": ["hello", "Bad Name", 42, "world"],\n  "extra": true\n}\n');
    const read = readPluginState(file);
    expect(read.state).toEqual({ disabled: ['hello', 'world'] });
    expect(read.issue).toContain('dropped 2');
  });

  it('setPluginEnabled is pure: disabling adds, enabling removes, both idempotent', () => {
    const start = emptyPluginState();
    const off = setPluginEnabled(start, 'hello', false);
    expect(off).toEqual({ disabled: ['hello'] });
    expect(start.disabled).toEqual([]); // the input is never mutated

    const offAgain = setPluginEnabled(off, 'hello', false);
    expect(offAgain.disabled).toEqual(['hello']); // no duplicate

    const two = setPluginEnabled(off, 'world', false);
    expect(two.disabled).toEqual(['hello', 'world']); // sorted, one per name

    const backOn = setPluginEnabled(two, 'hello', true);
    expect(backOn).toEqual({ disabled: ['world'] });
    expect(setPluginEnabled(backOn, 'hello', true).disabled).toEqual(['world']); // removing a non-member
  });

  it('setPluginEnabled refuses an invalid plugin name', () => {
    expect(() => setPluginEnabled(emptyPluginState(), 'Bad Name', false)).toThrow('invalid plugin name');
    expect(() => setPluginEnabled(emptyPluginState(), '../escape', false)).toThrow('invalid plugin name');
  });

  it('writePluginState writes sorted unique names atomically and reads back', () => {
    writePluginState(file, { disabled: ['world', 'hello', 'world'] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ disabled: ['hello', 'world'] });
    // Atomic write: no temp file is left next to the target.
    expect(fs.readdirSync(dir)).toEqual(['plugins.json']);
    expect(readPluginState(file)).toEqual({ state: { disabled: ['hello', 'world'] } });

    // A second write replaces the first (never appends).
    writePluginState(file, { disabled: [] });
    expect(readPluginState(file).state).toEqual({ disabled: [] });
  });

  it('writePluginState creates the directory when it does not exist', () => {
    const nested = path.join(dir, 'a', 'b', 'plugins.json');
    writePluginState(nested, { disabled: ['hello'] });
    expect(readPluginState(nested).state.disabled).toEqual(['hello']);
  });
});
