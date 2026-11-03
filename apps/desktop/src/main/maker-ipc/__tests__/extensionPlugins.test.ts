import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExtensionRegistry, type ExtensionRegistry } from '@cindy/maker-core/extensions';
import { loadPlugins, type LoadPluginsOptions } from '@cindy/maker-core/plugins';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import {
  createExtensionPluginsHost,
  registerExtensionPluginsHandlers,
  type ExtensionPluginListView,
} from '../extensionPlugins';
import { IpcHarness } from './helpers/ipcHarness';

// Same constraint as the 4.2a loader tests: vitest cannot import files outside the repo, so
// the real loader runs against real files with Node's own require. The default native
// import() path is exercised by the live proof.
const nodeRequire = createRequire(import.meta.url);
const importModule: LoadPluginsOptions['importModule'] = async (file) => nodeRequire(file);
const load: typeof loadPlugins = (opts) => loadPlugins({ ...opts, importModule });

let dir: string;
let rootDir: string;
let stateFile: string;
let registry: ExtensionRegistry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-plugins-'));
  rootDir = path.join(dir, 'plugins');
  stateFile = path.join(dir, 'plugins.json');
  registry = createExtensionRegistry();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function plugin(name: string, files: Record<string, string>): void {
  fs.mkdirSync(path.join(rootDir, name), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(rootDir, name, file), text);
  }
}
const GOOD = (id: string): string =>
  `module.exports = { default: (api) => { api.register({ kind: 'tool', id: '${id}', value: 'v' }); } };\n`;

function host(): ReturnType<typeof createExtensionPluginsHost> {
  return createExtensionPluginsHost({ rootDir, stateFile, registry, load });
}

function names(view: ExtensionPluginListView): Array<[string, string, boolean]> {
  return view.plugins.map((p) => [p.name, p.status, p.enabled]);
}

describe('extension plugins host (ROADMAP 4.2b)', () => {
  it('loads every plugin at startup; a disabled one is listed but never imported', async () => {
    plugin('good-a', { 'manifest.yaml': 'entry: index.cjs\nversion: 1\ndescription: A\n', 'index.cjs': GOOD('a-tool') });
    plugin('off-b', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('b-tool') });
    fs.writeFileSync(stateFile, '{ "disabled": ["off-b"] }\n');

    const view = await host().list();

    expect(names(view)).toEqual([
      ['good-a', 'active', true],
      ['off-b', 'disabled', false],
    ]);
    expect(view.plugins[0]).toMatchObject({ registered: 1, version: '1', description: 'A' });
    expect(registry.get('tool', 'a-tool')).toBeDefined();
    expect(registry.get('tool', 'b-tool')).toBeUndefined();
    expect(view.stateIssue).toBeUndefined();
  });

  it('a throwing plugin is a row with its error; the others load and its partial registrations are gone', async () => {
    plugin('bad', {
      'manifest.yaml': 'entry: index.cjs\n',
      'index.cjs':
        "module.exports = { default: (api) => { api.register({ kind: 'tool', id: 'half', value: 1 }); throw new Error('boom'); } };\n",
    });
    plugin('good', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('good-tool') });

    const view = await host().list();

    expect(names(view)).toEqual([
      ['bad', 'failed', true],
      ['good', 'active', true],
    ]);
    expect(view.plugins[0].error).toBe('boom');
    expect(registry.get('tool', 'half')).toBeUndefined();
    expect(registry.get('tool', 'good-tool')).toBeDefined();
  });

  it('toggle off unregisters at once and persists; toggle on reloads just that plugin', async () => {
    plugin('aaa', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('a-tool') });
    plugin('bbb', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('b-tool') });
    const h = host();
    await h.start();

    const off = await h.setEnabled('aaa', false);
    expect(names(off)).toEqual([
      ['aaa', 'disabled', false],
      ['bbb', 'active', true],
    ]);
    expect(registry.get('tool', 'a-tool')).toBeUndefined();
    expect(registry.get('tool', 'b-tool')).toBeDefined();
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ disabled: ['aaa'] });

    const on = await h.setEnabled('aaa', true);
    expect(names(on)).toEqual([
      ['aaa', 'active', true],
      ['bbb', 'active', true],
    ]);
    expect(registry.get('tool', 'a-tool')).toBeDefined();
    expect(registry.get('tool', 'b-tool')).toBeDefined();
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ disabled: [] });
  });

  it('a hand edit of plugins.json between toggles is honoured, not overwritten', async () => {
    plugin('aaa', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('a-tool') });
    plugin('bbb', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('b-tool') });
    const h = host();
    await h.start();
    fs.writeFileSync(stateFile, '{ "disabled": ["aaa"] }\n');

    const view = await h.setEnabled('bbb', false);

    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ disabled: ['aaa', 'bbb'] });
    expect(names(view)).toEqual([
      ['aaa', 'disabled', false],
      ['bbb', 'disabled', false],
    ]);
  });

  it('enabling retries a failed plugin and picks up a fixed file', async () => {
    plugin('fixme', {
      'manifest.yaml': 'entry: index.cjs\n',
      'index.cjs': 'module.exports = (((\n',
    });
    const h = host();
    await h.start();
    expect((await h.list()).plugins[0].status).toBe('failed');

    fs.writeFileSync(path.join(rootDir, 'fixme', 'index.cjs'), GOOD('fixed-tool'));
    await h.setEnabled('fixme', false);
    const view = await h.setEnabled('fixme', true);

    expect(names(view)).toEqual([['fixme', 'active', true]]);
    expect(registry.get('tool', 'fixed-tool')).toBeDefined();
  });

  it('a corrupt plugins.json means all enabled, the issue is listed, and a toggle repairs the file', async () => {
    plugin('good', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('good-tool') });
    fs.writeFileSync(stateFile, '{not json');
    const h = host();

    const view = await h.list();
    expect(names(view)).toEqual([['good', 'active', true]]);
    expect(view.stateIssue).toContain('not valid JSON');

    const after = await h.setEnabled('good', false);
    expect(after.stateIssue).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ disabled: ['good'] });
  });

  it('setEnabled validates its input and touches nothing on a bad call', async () => {
    plugin('good', { 'manifest.yaml': 'entry: index.cjs\n', 'index.cjs': GOOD('good-tool') });
    const h = host();
    await h.start();

    await expect(h.setEnabled('Bad Name', false)).rejects.toThrow('valid plugin name');
    await expect(h.setEnabled('good', 'no')).rejects.toThrow('enabled (boolean)');
    await expect(h.setEnabled({}, false)).rejects.toThrow('valid plugin name');
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(registry.get('tool', 'good-tool')).toBeDefined();
  });

  it('a missing plugins directory is an empty list, not an error', async () => {
    expect((await host().list()).plugins).toEqual([]);
  });
});

describe('extension plugins IPC (ROADMAP 4.2b)', () => {
  it('list and set-enabled require a trusted sender; an untrusted call never reaches the host', async () => {
    const hostStub = {
      start: vi.fn(),
      list: vi.fn().mockRejectedValue(new Error('host must not be called')),
      setEnabled: vi.fn().mockRejectedValue(new Error('host must not be called')),
    };
    const harness = new IpcHarness();
    registerExtensionPluginsHandlers(harness, {
      host: hostStub,
      assertTrusted: () => {
        throw new Error('untrusted sender');
      },
      broadcast: vi.fn(),
    });

    await expect(harness.invoke(MAKER_INVOKE.EXT_PLUGINS_LIST)).rejects.toThrow('untrusted sender');
    await expect(
      harness.invoke(MAKER_INVOKE.EXT_PLUGINS_SET_ENABLED, { name: 'a', enabled: false }),
    ).rejects.toThrow('untrusted sender');
    expect(hostStub.list).not.toHaveBeenCalled();
    expect(hostStub.setEnabled).not.toHaveBeenCalled();
  });

  it('set-enabled forwards the payload, returns the fresh list and broadcasts it', async () => {
    const fresh: ExtensionPluginListView = {
      plugins: [{ name: 'good', enabled: false, status: 'disabled', registered: 0 }],
    };
    const hostStub = {
      start: vi.fn(),
      list: vi.fn().mockResolvedValue(fresh),
      setEnabled: vi.fn().mockResolvedValue(fresh),
    };
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    registerExtensionPluginsHandlers(harness, { host: hostStub, assertTrusted, broadcast });

    const result = await harness.invoke(MAKER_INVOKE.EXT_PLUGINS_SET_ENABLED, {
      name: 'good',
      enabled: false,
    });

    expect(assertTrusted).toHaveBeenCalledOnce();
    expect(hostStub.setEnabled).toHaveBeenCalledWith('good', false);
    expect(result).toEqual(fresh);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXT_PLUGINS_CHANGED, fresh);
  });
});
