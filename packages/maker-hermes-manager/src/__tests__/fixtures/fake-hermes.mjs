#!/usr/bin/env node
/**
 * Test fixture: a tiny Hermes stand-in. Tolerates the full `hermes chat …`
 * flag set (ignores anything it doesn't know) and emits a scripted
 * stream-json session on stdout.
 *
 * Fixture flags (scan-only, values may appear anywhere):
 *   --behavior happy|slow|fail|missing-session|permission-scoped|compress   script (default happy)
 *   --session-id <id>            session_id reported by system/init
 *   --record <path>              write the full argv as JSON here (assertions)
 *   --fail-when-resumed          exit 5 if --resume is present
 *   FAKE_AGENT_LOG=1             (env) happy run appends per-call lines to logs/agent.log
 *
 * `FAKE_RECORD_LOG` appends one JSON line of argv per invocation, so a test can
 * inspect every attempt (e.g. the resume that failed and the fresh retry).
 */

import * as fs from 'node:fs';

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const behavior = flagValue('--behavior') ?? process.env.FAKE_BEHAVIOR ?? 'happy';
const sessionId = flagValue('--session-id') ?? 'fake-h-1';
// The installed CLI reports an empty session_id on init and the real id on
// result; FAKE_INIT_EMPTY reproduces that shape.
const initSessionId = process.env.FAKE_INIT_EMPTY ? '' : sessionId;
// The daemon builds argv (not the test), so tests that need to assert argv
// set FAKE_RECORD in the environment instead of passing --record.
const record = flagValue('--record') ?? process.env.FAKE_RECORD;
if (record) fs.writeFileSync(record, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_RECORD_LOG) {
  fs.appendFileSync(process.env.FAKE_RECORD_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
}

// FAKE_RECORD_ENV appends one JSON line per invocation with the HERMES_HOME and the CINDY_PROBE
// session env the daemon gave the child (per-session-home tests assert both).
if (process.env.FAKE_RECORD_ENV) {
  fs.appendFileSync(
    process.env.FAKE_RECORD_ENV,
    JSON.stringify({
      home: process.env.HERMES_HOME ?? null,
      probe: process.env.CINDY_PROBE ?? null,
      argv: process.argv.slice(2),
      // ROADMAP 1.13b: the auto-review hook endpoint the daemon handed this run.
      reviewSocket: process.env.CINDY_HERMES_REVIEW_SOCKET ?? null,
      reviewToken: process.env.CINDY_HERMES_REVIEW_TOKEN ?? null,
    }) + '\n',
  );
}

// The real CLI stamps every stream-json event with a ms timestamp
// (see real-hermes-transcript.ndjson).
const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, timestamp: Date.now() }) + '\n');

// `plugins enable|disable <name>`: FAKE_PLUGINS_FAIL makes it fail like a
// missing plugin. The argv is already recorded above (FAKE_RECORD_ENV).
if (process.argv.includes('plugins')) {
  if (process.env.FAKE_PLUGINS_FAIL) {
    process.stderr.write('simulated plugin toggle failure\n');
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv.includes('--version')) {
  if (process.env.FAKE_VERSION_ERROR) {
    process.stderr.write('simulated version failure\n');
    process.exit(1);
  }
  process.stdout.write(`Hermes Agent v${process.env.FAKE_VERSION ?? '0.22.7'} (test fixture)\n`);
  process.exit(0);
}

// FAKE_RECORD_TEXT appends one JSON line {argv, text} per invocation (stdin is
// read to EOF first; the daemon closes it after writing the query).
if (process.env.FAKE_RECORD_TEXT) {
  fs.appendFileSync(
    process.env.FAKE_RECORD_TEXT,
    JSON.stringify({ argv: process.argv.slice(2), text: fs.readFileSync(0, 'utf8') }) + '\n',
  );
}

// Consume stdin (the daemon writes the query then closes it) without parsing.
process.stdin.resume();

// FAKE_AGENT_LOG: write two per-API-call lines to $HERMES_HOME/logs/agent.log in the
// real CLI's format (Hermes 0.22.5), as the real CLI does before its `result`.
function writeAgentLog() {
  if (!process.env.FAKE_AGENT_LOG || !process.env.HERMES_HOME) return;
  const dir = `${process.env.HERMES_HOME}/logs`;
  fs.mkdirSync(dir, { recursive: true });
  const line = (n, inTokens) =>
    `2026-11-02 11:51:40,067 INFO [${sessionId}] agent.conversation_loop: API call #${n}: model=fake-model provider=fake-provider in=${inTokens} out=5 total=${inTokens + 5} latency=0.1s cache=0/${inTokens} (0%) id=x\n`;
  fs.appendFileSync(`${dir}/agent.log`, line(1, 7000) + line(2, 7300));
}

if (behavior === 'happy') {
  if (flagValue('--fail-when-resumed') && process.argv.includes('--resume')) process.exit(5);
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: initSessionId });
  emit({ type: 'text', text: 'Hello ' });
  emit({ type: 'text', text: 'world' });
  emit({ type: 'tool_use', name: 'terminal', tool_call_id: 't1', input: { cmd: 'ls' } });
  emit({ type: 'tool_result', name: 'terminal', tool_call_id: 't1', output: 'file.txt', duration_ms: 4, is_error: false });
  writeAgentLog();
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
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: initSessionId });
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
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: initSessionId });
  emit({ type: 'text', text: 'partial output then boom' });
  process.stderr.write('simulated hermes crash\n');
  process.exit(3);
} else if (behavior === 'permission-scoped') {
  // Mirrors Hermes 0.22.5 (live 2026-11-02): a `--yolo` session and a
  // `--safe-mode` session live in separate stores, so `--resume <id>` under the
  // other flag silently starts a fresh session (history=0) and exits 0.
  // FAKE_SESSION_STORE is a JSON file {id: flag} shared across invocations.
  const store = process.env.FAKE_SESSION_STORE;
  const sessions = store && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
  const flag = process.argv.includes('--yolo') ? 'yolo' : 'safe';
  const resumeId = flagValue('--resume');
  let id = resumeId && sessions[resumeId] === flag ? resumeId : undefined;
  if (!id) {
    id = `fake-h-${flag}-${Object.keys(sessions).length + 1}`;
    sessions[id] = flag;
    if (store) fs.writeFileSync(store, JSON.stringify(sessions));
  }
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: id });
  emit({ type: 'text', text: id === resumeId ? 'resumed' : 'fresh' });
  emit({
    type: 'result',
    session_id: id,
    exit_code: 0,
    text: id === resumeId ? 'resumed' : 'fresh',
    tokens: { input: 3, output: 2, total: 5, cache_read: 0, cache_write: 0 },
    duration_ms: 11,
  });
  process.exit(0);
} else if (behavior === 'compress') {
  // Mirrors Hermes 0.22.5 (probe 2026-11-03): after a tool call the run compresses
  // before its next API call. Compression is only logged to agent.log (nothing on
  // stream-json), and the summary call takes a while between the two lines.
  const log = `${process.env.HERMES_HOME}/logs/agent.log`;
  fs.mkdirSync(`${process.env.HERMES_HOME}/logs`, { recursive: true });
  const compressLine = (phase, at, field, tokens) =>
    `2026-11-03 ${at} INFO agent.conversation_compression: context compression ${phase}: session=${sessionId} messages=${phase === 'started' ? '57' : '57->29'} ${field}=~${tokens} model=fake-model\n`;
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: initSessionId });
  emit({ type: 'tool_use', name: 'read_file', tool_call_id: 't1', input: { path: 'big.txt' } });
  emit({ type: 'tool_result', name: 'read_file', tool_call_id: 't1', output: 'lots', duration_ms: 4, is_error: false });
  // The started line comes after the last stream event, so only a live log watch sees it in time.
  setTimeout(() => fs.appendFileSync(log, compressLine('started', '09:32:02,349', 'tokens', '56,110')), 300);
  setTimeout(() => {
    fs.appendFileSync(log, compressLine('done', '09:32:22,636', 'rough_tokens', '42,244'));
    emit({ type: 'text', text: 'after compression' });
    emit({
      type: 'result',
      session_id: sessionId,
      exit_code: 0,
      text: 'after compression',
      tokens: { input: 98000, output: 5, total: 98005, cache_read: 0, cache_write: 0 },
      duration_ms: 1600,
    });
    process.exit(0);
  }, 1_900);
} else if (behavior === 'missing-session') {
  // Mirrors the real CLI: `--resume <unknown>` emits init with an empty
  // session_id and a failed result carrying the lookup error, then exits 1.
  const resumeIndex = process.argv.indexOf('--resume');
  const resumeId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
  if (!resumeId) {
    emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: 'fake-h-fresh' });
    emit({ type: 'text', text: 'Fresh start' });
    emit({
      type: 'result',
      session_id: 'fake-h-fresh',
      exit_code: 0,
      text: 'Fresh start',
      tokens: { input: 3, output: 2, total: 5, cache_read: 0, cache_write: 0 },
      duration_ms: 11,
    });
    process.exit(0);
  }
  const error = `No session found matching '${resumeId}'. Use 'hermes sessions list' to see available sessions, or pass -c <name> --create-if-missing to start a new session with that title.`;
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: '' });
  emit({
    type: 'result',
    session_id: '',
    exit_code: 1,
    text: '',
    tokens: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 },
    error,
  });
  process.stderr.write(`Error: ${error}\n\nsession_id:\n`);
  process.exit(1);
} else {
  process.stderr.write(`unknown behavior: ${behavior}\n`);
  process.exit(2);
}
