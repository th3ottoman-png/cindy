import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExtensionRegistry } from '../../extensions/registry';
import { loadPlugins, type LoadPluginsOptions } from '../plugin-loader';

// vitest's module graph cannot import files outside the repo, so the tests load the real files
// from disk with Node's own require (CommonJS plugins). The default native `import()` path is
// exercised by the 4.2b live proof.
const nodeRequire = createRequire(import.meta.url);
const importModule: LoadPluginsOptions['importModule'] = async (file) => nodeRequire(file);

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function plugin(name: string, files: Record<string, string>): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name, file), text);
}
const GOOD = (id: string): string => `module.exports = { default: (api) => { api.register({ kind: 'tool', id: '${id}', value: 'v' }); } };\n`;

describe('plugin loader', () => {
  it('loads a real plugin module from disk and registers what it declares, tagged with its source', async () => {
    plugin('hello', { 'manifest.yaml': 'entry: index.cjs\nversion: 1.2\ndescription: says hi\n', 'index.cjs': GOOD('hello-tool') });
    const registry = createExtensionRegistry();
    const reports = await loadPlugins({ root, registry, importModule });

    expect(reports).toEqual([{ name: 'hello', status: 'active', registered: 1, version: '1.2', description: 'says hi' }]);
    expect(registry.get('tool', 'hello-tool')).toMatchObject({ value: 'v', source: 'plugin:hello' });
  });

  it('a broken plugin is isolated: the others still load and its partial registrations are rolled back', async () => {
    plugin('a-good', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('good-tool') });
    plugin('b-throws', {
      'manifest.yaml': 'entry: index.cjs\n',
      'index.cjs': "module.exports = { default: (api) => { api.register({ kind: 'tool', id: 'half', value: 1 }); throw new Error('boom'); } };\n",
    });
    plugin('c-syntax', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': 'module.exports = (((\n' });
    plugin('d-not-a-function', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': 'module.exports = { default: 42 };\n' });
    plugin('e-good', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('other-tool') });
    const registry = createExtensionRegistry();
    const reports = await loadPlugins({ root, registry, importModule });

    expect(reports.map((r) => [r.name, r.status])).toEqual([
      ['a-good', 'active'],
      ['b-throws', 'failed'],
      ['c-syntax', 'failed'],
      ['d-not-a-function', 'failed'],
      ['e-good', 'active'],
    ]);
    expect(reports[1].error).toBe('boom');
    expect(registry.list().map((e) => e.id)).toEqual(['good-tool', 'other-tool']);
  });

  it('a plugin that hangs is cut off by the timeout', async () => {
    plugin('hangs', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': 'module.exports = { default: () => new Promise(() => {}) };\n' });
    const [report] = await loadPlugins({ root, registry: createExtensionRegistry(), timeoutMs: 100, importModule });
    expect(report).toMatchObject({ status: 'failed', error: 'timed out after 100 ms' });
  });

  it('reports bad manifests and bad entries as invalid without importing anything', async () => {
    plugin('no-manifest', { 'index.cjs': GOOD('x') });
    plugin('bad-yaml', { 'manifest.yaml': 'entry: [unclosed\n' });
    plugin('no-entry', { 'manifest.yaml': 'version: 1\n' });
    plugin('missing-file', { 'manifest.yaml': 'entry: nope.mjs\n' });
    plugin('absolute', { 'manifest.yaml': 'entry: /etc/hosts\n' });
    plugin('Bad Name', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('y') });
    const imported: string[] = [];
    const reports = await loadPlugins({
      root,
      registry: createExtensionRegistry(),
      importModule: async (f) => {
        imported.push(f);
        return {};
      },
    });
    expect(reports.every((r) => r.status === 'invalid')).toBe(true);
    expect(reports).toHaveLength(6);
    expect(imported).toEqual([]);
  });

  it('refuses an entry that escapes the plugin directory, including through a symlink', async () => {
    fs.writeFileSync(path.join(root, 'outside.mjs'), GOOD('escaped'));
    plugin('dotdot', { 'manifest.yaml': 'entry: ../outside.mjs\n' });
    plugin('linked', { 'manifest.yaml': 'entry: link.mjs\n' });
    fs.symlinkSync(path.join(root, 'outside.mjs'), path.join(root, 'linked', 'link.mjs'));
    const registry = createExtensionRegistry();
    const reports = await loadPlugins({ root, registry, importModule });
    expect(reports.map((r) => [r.name, r.status, r.error])).toEqual([
      ['dotdot', 'invalid', '"entry" resolves outside the plugin directory'],
      ['linked', 'invalid', '"entry" resolves outside the plugin directory'],
    ]);
    expect(registry.list()).toEqual([]);
  });

  it('a disabled plugin is listed but never imported', async () => {
    plugin('off', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('off-tool') });
    const imported: string[] = [];
    const registry = createExtensionRegistry();
    const reports = await loadPlugins({
      root,
      registry,
      isEnabled: (n) => n !== 'off',
      importModule: async (f) => {
        imported.push(f);
        return {};
      },
    });
    expect(reports).toEqual([{ name: 'off', status: 'disabled', registered: 0 }]);
    expect(imported).toEqual([]);
  });

  it('a missing plugins directory is no plugins, not an error', async () => {
    expect(await loadPlugins({ root: path.join(root, 'nope'), registry: createExtensionRegistry() })).toEqual([]);
  });
});
