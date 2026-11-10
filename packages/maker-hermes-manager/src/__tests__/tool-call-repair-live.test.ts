import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { startHermesRun } from '../hermes-run.js';

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE_HERMES = nodePath.resolve(__dirname, 'fixtures/fake-hermes.mjs');

describe('tool-call-repair live execution', () => {
  it('automatically repairs malformed JSON arguments emitted by local LLMs before tool dispatch', async () => {
    const receivedEvents: Array<Record<string, unknown>> = [];

    const handle = startHermesRun(
      {
        hermesBin: process.execPath,
        hermesHome: '/tmp/test-hermes-home',
        cwd: process.cwd(),
        text: 'Please inspect README.md',
        extraArgs: [FAKE_HERMES, '--behavior', 'malformed-tool-call'],
      },
      (event) => {
        receivedEvents.push(event as Record<string, unknown>);
      },
    );

    const result = await handle.result;

    expect(result.code).toBe(0);
    expect(result.sawResult).toBe(true);

    const toolUseEvent = receivedEvents.find((e) => e.type === 'tool_use');
    expect(toolUseEvent).toBeDefined();

    // Proven: malformed single quotes, unquoted keys, trailing comma, and Python boolean True
    // was normalized and repaired before dispatch
    expect(toolUseEvent?.input).toEqual({
      path: 'README.md',
      limit: 10,
      verbose: true,
    });

    const toolResultEvent = receivedEvents.find((e) => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.is_error).toBe(false);
  });
});
