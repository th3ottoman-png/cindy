// Bundle src/hermes-bridge-shim/bin.ts into a self-contained ESM script that
// Hermes can spawn with plain `node`. Same pattern as
// packages/maker-hermes-manager/build.mjs (copied, not shared).

import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

const entry = fileURLToPath(new URL('./src/hermes-bridge-shim/bin.ts', import.meta.url));
const defaultOut = fileURLToPath(new URL('./dist/hermes-bridge-shim.mjs', import.meta.url));

export async function buildShim(outfile = defaultOut) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'none',
    minify: false,
    sourcemap: false,
  });
  return outfile;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`built ${await buildShim()}`);
}
