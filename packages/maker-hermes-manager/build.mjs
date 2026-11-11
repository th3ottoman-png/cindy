// Bundle src/bin/hermes-mgr.ts into a self-contained ESM daemon deployable
// wherever the desktop (or a home server) runs it. Mirrors
// packages/maker-pi-manager/build.mjs — the pattern is intentionally copied,
// not shared, per the sibling packages' convention.

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Cross-platform deterministic bundle: force LF so macOS/Windows checkouts
// produce byte-identical bundles (see pi-manager build.mjs).
const normalizeEolPlugin = {
  name: 'normalize-eol-lf',
  setup(build) {
    build.onLoad({ filter: /\.(ts|js|mjs|cjs|json)$/ }, async (args) => {
      const raw = await readFile(args.path, 'utf8');
      const normalized = raw.replace(/\r\n/g, '\n');
      const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
      const loader = ext === 'ts' ? 'ts' : ext === 'json' ? 'json' : 'js';
      return { contents: normalized, loader };
    });
  },
};

const entry = fileURLToPath(new URL('./src/bin/hermes-mgr.ts', import.meta.url));
const defaultOut = fileURLToPath(new URL('./dist/hermes-mgr.mjs', import.meta.url));

export async function buildDaemon(outfile = defaultOut) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
    // gray-matter (pulled in by @cindy/maker-core/progressive-skills) is CJS and calls
    // require('fs'). An ESM bundle has no `require`, so esbuild's __require shim throws
    // "Dynamic require of fs is not supported". Give the bundle a real CommonJS require.
    banner: {
      js: [
        '#!/usr/bin/env node',
        'import { createRequire } from "node:module";',
        'const require = createRequire(import.meta.url);',
      ].join('\n'),
    },
    external: [],
    legalComments: 'none',
    minify: false, // keep stack traces readable in production logs
    sourcemap: false,
    plugins: [normalizeEolPlugin],
  });
  return outfile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`built ${await buildDaemon()}`);
}
