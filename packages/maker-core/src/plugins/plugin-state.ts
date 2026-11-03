/**
 * Persisted enable/disable state for local plugins (ROADMAP 4.2b). The state lives in a
 * hand-editable JSON file (`~/.cindy-harness/plugins.json` in production; AGENTS §6.1) of
 * the shape `{ "disabled": ["name", ...] }` — every plugin is enabled unless listed. A
 * missing file is the empty state; a corrupt file falls back to all-enabled with an issue
 * the caller can show, so one bad hand edit never hides the plugins (fail open on
 * convenience, §6.3). Writes are atomic (temp file in the same directory, then rename).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isValidPluginName } from './plugin-loader.js';

export interface PluginState {
  /** Names of disabled plugins. Sorted, unique, all valid plugin names. */
  disabled: string[];
}

export interface PluginStateRead {
  state: PluginState;
  /** Why the file's contents were not fully honoured. Absent when it read clean. */
  issue?: string;
}

export function emptyPluginState(): PluginState {
  return { disabled: [] };
}

/** Read the state file. Never throws: any problem becomes the empty state plus an issue. */
export function readPluginState(file: string): PluginStateRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyPluginState() };
    return { state: emptyPluginState(), issue: `cannot read the file: ${error instanceof Error ? error.message : String(error)}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { state: emptyPluginState(), issue: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { state: emptyPluginState(), issue: 'the file must be an object like { "disabled": ["name"] }' };
  }
  const raw = (doc as Record<string, unknown>).disabled;
  if (raw === undefined) return { state: emptyPluginState() };
  if (!Array.isArray(raw)) {
    return { state: emptyPluginState(), issue: '"disabled" must be an array of plugin names' };
  }
  const valid: string[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (typeof entry === 'string' && isValidPluginName(entry)) {
      if (!valid.includes(entry)) valid.push(entry);
    } else {
      dropped += 1;
    }
  }
  valid.sort();
  return dropped > 0
    ? { state: { disabled: valid }, issue: `dropped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} that are not valid plugin names` }
    : { state: { disabled: valid } };
}

/** Pure transition. Throws on an invalid plugin name; never mutates the input. */
export function setPluginEnabled(state: PluginState, name: string, enabled: boolean): PluginState {
  if (!isValidPluginName(name)) throw new Error(`invalid plugin name: ${JSON.stringify(name)}`);
  const set = new Set(state.disabled.filter((n) => n !== name));
  if (!enabled) set.add(name);
  return { disabled: [...set].sort() };
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writePluginState(file: string, state: PluginState): void {
  const disabled = [...new Set(state.disabled.filter(isValidPluginName))].sort();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ disabled }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
