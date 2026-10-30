/**
 * Local plugin loader (ROADMAP 4.2a). A plugin is a directory `<root>/<name>/` holding
 * `manifest.yaml` and an entry module. The module's default export `activate(api)` registers
 * extensions on the unified registry (4.1a); everything it registers is tagged
 * `source: plugin:<name>`. Failure isolates to the plugin: a bad manifest, an entry that
 * escapes the plugin directory, a module that throws on import or in `activate`, or one that
 * hangs, produces a report row and leaves the other plugins (and anything the failed one
 * had registered) untouched. Loading at app start and the Settings toggle are 4.2b.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import matter from 'gray-matter';

import type { ExtensionDescriptor, ExtensionRegistry } from '../extensions/registry.js';

export type PluginStatus = 'active' | 'disabled' | 'invalid' | 'failed';

export interface PluginReport {
  /** Directory name. */
  name: string;
  status: PluginStatus;
  error?: string;
  /** Extensions it registered (0 unless active). */
  registered: number;
  version?: string;
  description?: string;
}

export interface PluginApi {
  register<T>(descriptor: ExtensionDescriptor<T>): () => void;
}

export interface LoadPluginsOptions {
  root: string;
  registry: ExtensionRegistry;
  /** Settings toggle. Default: every plugin enabled. */
  isEnabled?: (name: string) => boolean;
  /** Per-plugin import + activate budget. Default 5000 ms. */
  timeoutMs?: number;
  /** Injected so tests need not touch the real module loader. */
  importModule?: (file: string) => Promise<unknown>;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// A native `import()` that bundlers and vite-node leave alone: plugin files live outside the
// bundle, so the host's module graph must not try to resolve or rewrite them.
const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
const defaultImport = (file: string): Promise<unknown> => nativeImport(pathToFileURL(file).href);

interface Manifest {
  entry: string;
  version?: string;
  description?: string;
}

function parseManifest(dir: string): Manifest | string {
  const file = path.join(dir, 'manifest.yaml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 'manifest.yaml is missing';
  }
  let doc: unknown;
  try {
    doc = matter(`---\n${text}\n---\n`, {}).data;
  } catch (error) {
    return `invalid YAML: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'manifest must be a mapping';
  const m = doc as Record<string, unknown>;
  if (typeof m.entry !== 'string' || !m.entry.trim()) return '"entry" is required (a file inside the plugin directory)';
  return {
    entry: m.entry.trim(),
    version: typeof m.version === 'string' || typeof m.version === 'number' ? String(m.version) : undefined,
    description: typeof m.description === 'string' ? m.description : undefined,
  };
}

/** Resolve the entry inside the plugin directory, following symlinks, or explain why not. */
function resolveEntry(dir: string, entry: string): string | { error: string } {
  if (path.isAbsolute(entry)) return { error: '"entry" must be relative to the plugin directory' };
  try {
    const realDir = fs.realpathSync(dir);
    const real = fs.realpathSync(path.join(dir, entry));
    if (real !== realDir && !real.startsWith(realDir + path.sep)) return { error: '"entry" resolves outside the plugin directory' };
    return real;
  } catch {
    return { error: `entry file not found: ${entry}` };
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function loadOne(name: string, dir: string, opts: LoadPluginsOptions): Promise<PluginReport> {
  const manifest = parseManifest(dir);
  if (typeof manifest === 'string') return { name, status: 'invalid', error: manifest, registered: 0 };
  const info = { version: manifest.version, description: manifest.description };
  if (opts.isEnabled && !opts.isEnabled(name)) return { name, status: 'disabled', registered: 0, ...info };

  const entry = resolveEntry(dir, manifest.entry);
  if (typeof entry !== 'string') return { name, status: 'invalid', error: entry.error, registered: 0, ...info };

  const undo: Array<() => void> = [];
  const api: PluginApi = {
    register: (descriptor) => {
      const off = opts.registry.register({ ...descriptor, source: `plugin:${name}` });
      undo.push(off);
      return off;
    },
  };
  try {
    await withTimeout(
      (async () => {
        const mod = (await (opts.importModule ?? defaultImport)(entry)) as { default?: unknown };
        if (typeof mod.default !== 'function') throw new Error('entry module must default-export an activate(api) function');
        await (mod.default as (api: PluginApi) => unknown)(api);
      })(),
      opts.timeoutMs ?? 5000,
    );
    return { name, status: 'active', registered: undo.length, ...info };
  } catch (error) {
    for (const off of undo.reverse()) off();
    return { name, status: 'failed', error: error instanceof Error ? error.message : String(error), registered: 0, ...info };
  }
}

/** Load every plugin under `root`, one at a time, in name order. A missing root is no plugins. */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginReport[]> {
  let names: string[];
  try {
    names = fs
      .readdirSync(opts.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const reports: PluginReport[] = [];
  for (const name of names) {
    const dir = path.join(opts.root, name);
    if (!NAME.test(name)) {
      reports.push({ name, status: 'invalid', error: 'directory name must be lowercase letters, digits, ".", "_" or "-"', registered: 0 });
      continue;
    }
    reports.push(await loadOne(name, dir, opts));
  }
  return reports;
}
