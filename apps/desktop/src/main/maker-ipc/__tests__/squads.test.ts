/**
 * Squads discovery + IPC (ROADMAP 12.4b). Real temp directory trees; the watcher is faked
 * (real fs.watch inside a vitest worker risks the threads-pool teardown SIGSEGV, ROADMAP Debt —
 * same convention as importedAgents.test.ts). The roster check is injected, so no expert store
 * or native binary is needed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import {
  discoverSquads,
  registerSquadsHandlers,
  SQUADS_DIR_CAP,
  type SquadsHandlerHandle,
} from '../squads';
import { IpcHarness } from './helpers/ipcHarness';

let squadsRoot: string;
let handle: SquadsHandlerHandle | undefined;

const ROSTER = ['expert:orchestrator', 'expert:reviewer', 'imported:claude-user:security.md'];

const GOOD = [
  'name: Review squad',
  'description: Reviews a diff.',
  'lead: expert:orchestrator',
  'members:',
  '  - expert:reviewer',
  '  - imported:claude-user:security.md',
  'worker_permission_mode: bypassPermissions',
  'max_turns: 20',
  '',
].join('\n');

beforeEach(() => {
  squadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squads-root-'));
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  fs.rmSync(squadsRoot, { recursive: true, force: true });
});

function writeSquad(slug: string, body: string): string {
  const dir = path.join(squadsRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'squad.yaml');
  fs.writeFileSync(file, body);
  return file;
}

function fakeWatch() {
  const close = vi.fn();
  const watch = vi.fn(() => ({ close }));
  return { watch, close };
}

function setup(overrides: Partial<Parameters<typeof registerSquadsHandlers>[1]> = {}) {
  const broadcast = vi.fn();
  const assertTrusted = vi.fn();
  const harness = new IpcHarness();
  const resolveRosterEntry = vi.fn((rosterId: string) => {
    if (rosterId === 'expert:cc-only') return { ok: false, message: 'agent "claude-code" cannot run on Hermes' };
    if (ROSTER.includes(rosterId)) return { ok: true, name: rosterId.split(':').pop() };
    return { ok: false, message: 'not in the roster' };
  });
  handle = registerSquadsHandlers(harness, {
    squadsRoot,
    assertTrusted,
    broadcast,
    listRosterIds: () => ROSTER,
    resolveRosterEntry,
    watch: fakeWatch().watch,
    ...overrides,
  });
  return { harness, broadcast, assertTrusted, resolveRosterEntry };
}

describe('discoverSquads', () => {
  it('finds valid squads with their fields', () => {
    writeSquad('review-squad', GOOD);
    const { squads, capped } = discoverSquads(squadsRoot);
    expect(capped).toBe(false);
    expect(squads).toHaveLength(1);
    expect(squads[0].slug).toBe('review-squad');
    expect(squads[0].name).toBe('Review squad');
    expect(squads[0].lead).toBe('expert:orchestrator');
    expect(squads[0].members).toEqual(['expert:reviewer', 'imported:claude-user:security.md']);
    expect(squads[0].error).toBeUndefined();
  });

  it('lists malformed files with their error instead of crashing', () => {
    writeSquad('bad', 'name: [unclosed');
    writeSquad('good', GOOD);
    const { squads } = discoverSquads(squadsRoot);
    expect(squads).toHaveLength(2);
    const bad = squads.find((s) => s.slug === 'bad');
    expect(bad?.error).toBeTruthy();
    expect(squads.find((s) => s.slug === 'good')?.error).toBeUndefined();
  });

  it('skips dot-dirs, non-slug names and directories without squad.yaml', () => {
    writeSquad('.hidden', GOOD);
    writeSquad('has space', GOOD);
    fs.mkdirSync(path.join(squadsRoot, 'empty-dir'), { recursive: true });
    writeSquad('real', GOOD);
    const { squads } = discoverSquads(squadsRoot);
    expect(squads.map((s) => s.slug)).toEqual(['real']);
  });

  it('skips symlink escapes but keeps symlinks inside the root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'squads-outside-'));
    fs.writeFileSync(path.join(outside, 'squad.yaml'), GOOD);
    fs.symlinkSync(outside, path.join(squadsRoot, 'escape'));
    writeSquad('real', GOOD);
    fs.symlinkSync(path.join(squadsRoot, 'real'), path.join(squadsRoot, 'alias'));
    const { squads } = discoverSquads(squadsRoot);
    expect(squads.map((s) => s.slug).sort()).toEqual(['alias', 'real']);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('caps the directory count and says so', () => {
    for (let i = 0; i < SQUADS_DIR_CAP + 1; i += 1) {
      writeSquad('squad-' + String(i).padStart(4, '0'), GOOD);
    }
    const { squads, capped } = discoverSquads(squadsRoot);
    expect(capped).toBe(true);
    expect(squads).toHaveLength(SQUADS_DIR_CAP);
  });

  it('missing root is an empty list, not an error', () => {
    fs.rmSync(squadsRoot, { recursive: true, force: true });
    expect(discoverSquads(squadsRoot)).toEqual({ squads: [], capped: false });
  });
});

describe('squads IPC', () => {
  it('lists after a trust check and refuses an untrusted caller', async () => {
    writeSquad('review-squad', GOOD);
    const { harness, assertTrusted } = setup();
    const result = (await harness.invoke(MAKER_INVOKE.SQUADS_LIST)) as { squads: unknown[] };
    expect(assertTrusted).toHaveBeenCalledOnce();
    expect(result.squads).toHaveLength(1);

    const strict = new IpcHarness();
    const h2 = registerSquadsHandlers(strict, {
      squadsRoot,
      assertTrusted: () => { throw new Error('untrusted sender'); },
      broadcast: vi.fn(),
      listRosterIds: () => ROSTER,
      resolveRosterEntry: () => ({ ok: true, name: 'x' }),
      watch: fakeWatch().watch,
    });
    await expect(strict.invoke(MAKER_INVOKE.SQUADS_LIST)).rejects.toThrow('untrusted sender');
    h2.dispose();
  });

  it('reads one squad raw yaml and refuses unknown slugs', async () => {
    writeSquad('review-squad', GOOD);
    const { harness } = setup();
    const ok = (await harness.invoke(MAKER_INVOKE.SQUADS_READ, 'review-squad')) as { ok: boolean; yaml?: string };
    expect(ok.ok).toBe(true);
    expect(ok.yaml).toContain('Review squad');
    const missing = (await harness.invoke(MAKER_INVOKE.SQUADS_READ, 'nope')) as { ok: boolean; reason?: string };
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not-found');
  });

  it('creates a squad atomically and broadcasts the change', async () => {
    const { harness, broadcast } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_SAVE, {
      op: 'create',
      fields: { name: 'New Squad', description: 'd', lead: 'expert:orchestrator', members: ['expert:reviewer'], workerPermissionMode: 'bypassPermissions', maxTurns: 20 },
    })) as { ok: boolean; slug?: string };
    expect(res.ok).toBe(true);
    expect(res.slug).toBe('new-squad');
    const file = path.join(squadsRoot, 'new-squad', 'squad.yaml');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.join(squadsRoot, 'new-squad'))).toEqual(['squad.yaml']);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.SQUADS_CHANGED, expect.objectContaining({ squads: expect.any(Array) }));
  });

  it('create never overwrites an existing slug', async () => {
    writeSquad('new-squad', GOOD);
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_SAVE, {
      op: 'create', slug: 'new-squad',
      fields: { name: 'Other', lead: 'expert:orchestrator', members: ['expert:reviewer'], maxTurns: 20 },
    })) as { ok: boolean; reason?: string };
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('exists');
  });

  it('rejects invalid fields without writing', async () => {
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_SAVE, {
      op: 'create', fields: { name: 'Bad', lead: 'not-an-id', members: ['expert:reviewer'], maxTurns: 20 },
    })) as { ok: boolean; reason?: string };
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid');
    expect(fs.readdirSync(squadsRoot)).toEqual([]);
  });

  it('edit keeps unknown keys from the file on disk', async () => {
    writeSquad('review-squad', GOOD + 'tags:\n  - keep-me\n');
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_SAVE, {
      op: 'edit', slug: 'review-squad',
      fields: { name: 'Renamed', description: 'Reviews a diff.', lead: 'expert:orchestrator', members: ['expert:reviewer'], workerPermissionMode: 'bypassPermissions', maxTurns: 30 },
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const text = fs.readFileSync(path.join(squadsRoot, 'review-squad', 'squad.yaml'), 'utf8');
    expect(text).toContain('keep-me');
    expect(text).toContain('Renamed');
    expect(text).toContain('max_turns: 30');
  });

  it('deletes a squad and refuses unknown slugs', async () => {
    writeSquad('review-squad', GOOD);
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_SAVE, { op: 'delete', slug: 'review-squad' })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(squadsRoot, 'review-squad'))).toBe(false);
    const missing = (await harness.invoke(MAKER_INVOKE.SQUADS_SAVE, { op: 'delete', slug: 'nope' })) as { ok: boolean; reason?: string };
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not-found');
  });
});

describe('squads resolve-launch', () => {
  it('builds a fail-closed plan with binding ids and names', async () => {
    writeSquad('review-squad', GOOD);
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_RESOLVE_LAUNCH, 'review-squad', null, 'Review the diff.')) as {
      ok: boolean; plan?: { leadBindingId: string; members: Array<{ bindingId: string }>; kickoffMessage: string }; leadName?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.plan?.leadBindingId).toBe('orchestrator');
    expect(res.plan?.members.map((m) => m.bindingId)).toEqual(['reviewer', 'imported:claude-user:security.md']);
    expect(res.plan?.kickoffMessage).toContain('@agent:expert:reviewer');
    expect(res.plan?.kickoffMessage).toContain('Review the diff.');
    expect(res.leadName).toBe('orchestrator');
  });

  it('refuses an unknown roster id and never launches', async () => {
    writeSquad('ghost-squad', GOOD.replace('expert:reviewer', 'expert:ghost'));
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_RESOLVE_LAUNCH, 'ghost-squad', null, '')) as { ok: boolean; errors?: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors?.join(' ')).toMatch(/ghost/);
  });

  it('refuses an entry that cannot run on Hermes', async () => {
    writeSquad('cc-squad', GOOD.replace('expert:reviewer', 'expert:cc-only'));
    // In the roster (so the membership check passes) but not Hermes-runnable.
    const { harness } = setup({ listRosterIds: () => [...ROSTER, 'expert:cc-only'] });
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_RESOLVE_LAUNCH, 'cc-squad', null, '')) as { ok: boolean; errors?: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors?.join(' ')).toMatch(/Hermes/);
  });

  it('refuses a malformed squad file', async () => {
    writeSquad('bad', 'name: [unclosed');
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_RESOLVE_LAUNCH, 'bad', null, '')) as { ok: boolean; errors?: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('refuses a permission ceiling below Full access', async () => {
    writeSquad('auto-squad', GOOD.replace('bypassPermissions', 'auto'));
    const { harness } = setup();
    const res = (await harness.invoke(MAKER_INVOKE.SQUADS_RESOLVE_LAUNCH, 'auto-squad', null, '')) as { ok: boolean; errors?: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors?.join(' ')).toMatch(/Full access/);
  });
});
