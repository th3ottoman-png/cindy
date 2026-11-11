/**
 * The daemon bundle is ESM, but @cindy/maker-core/progressive-skills pulls in
 * gray-matter, which is CJS and calls require('fs'). Without a createRequire
 * banner esbuild's __require shim throws "Dynamic require of fs is not
 * supported", and the whole daemon dies before READY. Unit tests run the TS
 * source, so only a real bundle + spawn catches this.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// @ts-expect-error build script has no type declarations
import { buildDaemon } from '../../build.mjs';

describe('hermes-mgr daemon bundle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hermes-mgr-bundle-'));
  const outfile = path.join(dir, 'hermes-mgr.mjs');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts under plain Node and reaches argument parsing', async () => {
    await buildDaemon(outfile);

    const result = spawnSync(process.execPath, [outfile], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(combined).not.toContain('Dynamic require');
    expect(combined).toContain('--socket is required');
    expect(result.status).toBe(2);
  }, 60_000);
});
