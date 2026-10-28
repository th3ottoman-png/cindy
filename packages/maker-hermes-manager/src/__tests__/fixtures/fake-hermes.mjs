#!/usr/bin/env node
/**
 * Test fixture: a tiny Hermes stand-in. Tolerates the full `hermes chat …`
 * flag set (ignores anything it doesn't know) and emits a scripted
 * stream-json session on stdout.
 *
 * Fixture flags (scan-only, values may appear anywhere):
 *   --behavior happy|slow|fail   script to run (default happy)
 *   --session-id <id>            session_id reported by system/init
 *   --record <path>              write the full argv as JSON here (assertions)
 *   --fail-when-resumed          exit 5 if --resume is present
 */

import * as fs from 'node:fs';

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const behavior = flagValue('--behavior') ?? process.env.FAKE_BEHAVIOR ?? 'happy';
const sessionId = flagValue('--session-id') ?? 'fake-h-1';
// The daemon builds argv (not the test), so tests that need to assert argv
// set FAKE_RECORD in the environment instead of passing --record.
const record = flagValue('--record') ?? process.env.FAKE_RECORD;
if (record) fs.writeFileSync(record, JSON.stringify(process.argv.slice(2)));

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Consume stdin (the daemon writes the query then closes it) without parsing.
process.stdin.resume();

if (behavior === 'happy') {
  if (flagValue('--fail-when-resumed') && process.argv.includes('--resume')) process.exit(5);
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: sessionId });
  emit({ type: 'text', text: 'Hello ' });
  emit({ type: 'text', text: 'world' });
  emit({ type: 'tool_use', name: 'terminal', tool_call_id: 't1', input: { cmd: 'ls' } });
  emit({ type: 'tool_result', name: 'terminal', tool_call_id: 't1', output: 'file.txt', duration_ms: 4, is_error: false });
  emit({
    type: 'result',
    session_id: sessionId,
    exit_code: 0,
    text: 'Hello world',
    tokens: { input: 10, output: 5, total: 15, cache_read: 0, cache_write: 0 },
    duration_ms: 42,
  });
  process.exit(0);
} else if (behavior === 'slow') {
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: sessionId });
  const keepAlive = setInterval(() => {}, 1000);
  process.on('SIGINT', () => {
    emit({ type: 'result', session_id: sessionId, exit_code: 0, text: 'interrupted cleanly' });
    clearInterval(keepAlive);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(keepAlive);
    process.exit(9);
  });
} else if (behavior === 'fail') {
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: sessionId });
  emit({ type: 'text', text: 'partial output then boom' });
  process.stderr.write('simulated hermes crash\n');
  process.exit(3);
} else {
  process.stderr.write(`unknown behavior: ${behavior}\n`);
  process.exit(2);
}
