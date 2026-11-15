import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import {
  getWorkerAllowlistConfig,
  readWorkerAllowlistConfig,
  registerWorkerAllowlistHandlers,
  setWorkerAllowlistConfig,
  type WorkerAllowlistConfigView,
} from '../workerAllowlist';
import { IpcHarness } from './helpers/ipcHarness';

let dir: string;
let routingFile: string;
let providersFile: string;

const PROVIDERS = [
  'providers:',
  '  - id: lmstudio-local',
  '    kind: lmstudio',
  '    baseUrl: http://127.0.0.1:1234',
  '  - id: tokenhub',
  '    kind: openai-compatible',
  '    baseUrl: https://tokenhub.example/v1',
  '    keyEnv: TOKENHUB_API_KEY',
  '',
].join('\n');

const ROUTING = [
  '# owner header',
  'routes:',
  '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
  '  cheap-api: { provider: tokenhub, model: deepseek-v4.1-flash }',
  'rules:',
  '  title: local-small',
  '',
].join('\n');

const deps = () => ({ routingFile, providersFile });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-allowlist-'));
  routingFile = path.join(dir, 'routing.yaml');
  providersFile = path.join(dir, 'providers.yaml');
  fs.writeFileSync(providersFile, PROVIDERS);
  fs.writeFileSync(routingFile, ROUTING);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workerAllowlist host (ROADMAP 13.8)', () => {
  it('no managed block means no restriction, with routes marked local or API', () => {
    expect(readWorkerAllowlistConfig(routingFile, providersFile)).toBeNull();
    const view = getWorkerAllowlistConfig(deps());
    expect(view.present).toBe(false);
    expect(view.allowedRoutes).toEqual([]);
    expect(view.routes).toEqual([
      { name: 'local-small', provider: 'lmstudio-local', model: 'qwen3-8b', local: true },
      { name: 'cheap-api', provider: 'tokenhub', model: 'deepseek-v4.1-flash', local: false },
    ]);
  });

  it('saving writes only the managed block and preserves hand-written content', () => {
    const view = setWorkerAllowlistConfig(
      { enabled: true, allowModelChoice: true, allowedRoutes: ['cheap-api'] },
      deps(),
    );
    expect(view.present).toBe(true);
    expect(view.allowedRoutes).toEqual(['cheap-api']);
    const text = fs.readFileSync(routingFile, 'utf8');
    expect(text).toContain('# BEGIN cindy-workers');
    expect(text).toContain('allowed_routes: [cheap-api]');
    expect(text.startsWith(ROUTING.trimEnd())).toBe(true);
    expect(text).toContain('# owner header');
    expect(readWorkerAllowlistConfig(routingFile, providersFile)).toEqual({
      allowModelChoice: true,
      allowedRoutes: ['cheap-api'],
    });
  });

  it('a hand-written note outside the block survives repeated saves and removal', () => {
    setWorkerAllowlistConfig({ enabled: true, allowedRoutes: ['cheap-api'] }, deps());
    fs.appendFileSync(routingFile, '\n# hand-written note\n');
    setWorkerAllowlistConfig(
      { enabled: true, allowModelChoice: false, allowedRoutes: ['local-small'] },
      deps(),
    );
    let text = fs.readFileSync(routingFile, 'utf8');
    expect(text.match(/# BEGIN cindy-workers/g)).toHaveLength(1);
    expect(text).toContain('# hand-written note');
    expect(text).toContain('allow_model_choice: false');
    expect(text).toContain('allowed_routes: [local-small]');

    const off = setWorkerAllowlistConfig({ enabled: false }, deps());
    expect(off.present).toBe(false);
    text = fs.readFileSync(routingFile, 'utf8');
    expect(text).not.toContain('BEGIN cindy-workers');
    expect(text).not.toContain('workers:');
    expect(text).toContain('# owner header');
    expect(text).toContain('# hand-written note');
    expect(readWorkerAllowlistConfig(routingFile, providersFile)).toBeNull();
  });

  it('refuses to write an unknown route and reports the listed error', () => {
    const before = fs.readFileSync(routingFile, 'utf8');
    const view = setWorkerAllowlistConfig(
      { enabled: true, allowedRoutes: ['cheap-api', 'ghost'] },
      deps(),
    );
    expect(view.present).toBe(false);
    expect(view.issues.join('\n')).toContain('unknown route "ghost"');
    expect(fs.readFileSync(routingFile, 'utf8')).toBe(before);
  });

  it('a broken managed block fails closed: choice disabled, issues listed', () => {
    fs.appendFileSync(routingFile, [
      '# BEGIN cindy-workers (managed by Cindy; this block is rewritten)',
      'workers:',
      '  allow_model_choice: true',
      '  allowed_routes: [ghost]',
      '# END cindy-workers',
      '',
    ].join('\n'));
    const view = getWorkerAllowlistConfig(deps());
    expect(view.present).toBe(true);
    expect(view.allowModelChoice).toBe(false);
    expect(view.issues.join('\n')).toContain('unknown route "ghost"');
    expect(readWorkerAllowlistConfig(routingFile, providersFile)).toEqual({
      allowModelChoice: false,
      allowedRoutes: [],
    });
  });

  it('unparseable YAML fails closed rather than silently allowing every model', () => {
    fs.writeFileSync(routingFile, 'routes: [unclosed');
    expect(readWorkerAllowlistConfig(routingFile, providersFile)).toEqual({
      allowModelChoice: false,
      allowedRoutes: [],
    });
    expect(getWorkerAllowlistConfig(deps()).issues.join('\n')).toContain('invalid YAML');
  });
});

describe('workerAllowlist IPC handlers', () => {
  it('enforces the trust check, then reads and writes through the real handler', async () => {
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    registerWorkerAllowlistHandlers(harness, { ...deps(), assertTrusted });

    const empty = (await harness.invoke(MAKER_INVOKE.WORKERS_GET_CONFIG)) as WorkerAllowlistConfigView;
    expect(empty.present).toBe(false);
    expect(assertTrusted).toHaveBeenCalledTimes(1);

    const saved = (await harness.invoke(MAKER_INVOKE.WORKERS_SET_CONFIG, {
      enabled: true,
      allowModelChoice: true,
      allowedRoutes: ['local-small'],
    })) as WorkerAllowlistConfigView;
    expect(saved.present).toBe(true);
    expect(saved.allowedRoutes).toEqual(['local-small']);
    expect(assertTrusted).toHaveBeenCalledTimes(2);
    expect(readWorkerAllowlistConfig(routingFile, providersFile)).toEqual({
      allowModelChoice: true,
      allowedRoutes: ['local-small'],
    });
  });
});
