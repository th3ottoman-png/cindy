// Bundle src/bin/hermes-mgr.ts into a self-contained ESM daemon deployable
// wherever the desktop (or a home server) runs it. Mirrors
// packages/maker-pi-manager/build.mjs — the pattern is intentionally copied,
// not shared, per the sibling packages' convention.

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

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

await esbuild.build({
  entryPoints: ['src/bin/hermes-mgr.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/hermes-mgr.mjs',
  banner: { js: '#!/usr/bin/env node' },
  external: [],
  legalComments: 'none',
  minify: false, // keep stack traces readable in production logs
  sourcemap: false,
  plugins: [normalizeEolPlugin],
});

console.log('built dist/hermes-mgr.mjs');
