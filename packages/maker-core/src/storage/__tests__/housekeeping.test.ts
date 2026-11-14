import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  normalizeRetentionDays,
  planHousekeeping,
  type HousekeepingCandidate,
} from '../housekeeping.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOMES = '/home/.hermes-cindy/session-homes';
const BASE = '/home/.hermes-cindy';
const HARNESS = '/home/.cindy-harness';
const LOGS = '/repo/apps/desktop/logs';

function candidate(over: Partial<HousekeepingCandidate> = {}): HousekeepingCandidate {
  return {
    path: HOMES + '/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-0123456789',
    root: HOMES,
    kind: 'session-home',
    sizeBytes: 7_000_000,
    idleSinceMs: NOW - 40 * DAY,
    isSymlink: false,
    isDirectory: true,
    isRegularFile: false,
    ...over,
  };
}

function reasonOf(c: HousekeepingCandidate, protectedIds: string[] = []): string {
  return planHousekeeping([c], NOW, 30, protectedIds).decisions[0]!.reason;
}

describe('normalizeRetentionDays', () => {
  it('defaults to 30 for unusable input', () => {
    expect(normalizeRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(normalizeRetentionDays('14')).toBe(DEFAULT_RETENTION_DAYS);
    expect(normalizeRetentionDays(Number.NaN)).toBe(DEFAULT_RETENTION_DAYS);
  });
  it('clamps to the 7-day minimum', () => {
    expect(normalizeRetentionDays(1)).toBe(MIN_RETENTION_DAYS);
    expect(normalizeRetentionDays(0)).toBe(MIN_RETENTION_DAYS);
    expect(normalizeRetentionDays(-5)).toBe(MIN_RETENTION_DAYS);
  });
  it('floors a fractional value and keeps a valid one', () => {
    expect(normalizeRetentionDays(14.9)).toBe(14);
    expect(normalizeRetentionDays(90)).toBe(90);
  });
});

describe('planHousekeeping — Tier 3 refusals', () => {
  it('never follows or deletes a symlink, however old', () => {
    const c = candidate({ path: HOMES + '/x-0123456789/installs', kind: 'home-uv-cache', isSymlink: true, isDirectory: false });
    expect(reasonOf(c)).toBe('symlink-never-followed');
  });
  it('refuses a FIFO / socket (the dev-terminal fifo)', () => {
    const c = candidate({ path: LOGS + '/dev-terminal.log.fifo', root: LOGS, kind: 'dev-terminal-log', isDirectory: false, isRegularFile: false });
    expect(reasonOf(c)).toBe('not-a-regular-file-or-directory');
  });
  it('refuses a path outside its root', () => {
    expect(reasonOf(candidate({ path: '/elsewhere/home-0123456789' }))).toBe('outside-root');
  });
  it('refuses a parent-escape path', () => {
    expect(reasonOf(candidate({ path: HOMES + '/../config.yaml' }))).toBe('outside-root');
  });
  it('refuses the root itself', () => {
    expect(reasonOf(candidate({ path: HOMES }))).toBe('outside-root');
  });
  it('refuses a home directory that does not match the reaper name pattern', () => {
    expect(reasonOf(candidate({ path: HOMES + '/not-a-home' }))).toBe('unexpected-home-name');
  });
  it('never prunes the transcript, whatever kind it was labelled with', () => {
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm']) {
      const c = candidate({ path: HOMES + '/x-0123456789/' + name, kind: 'home-logs', isDirectory: false, isRegularFile: true });
      expect(reasonOf(c)).toBe('transcript-never-pruned');
    }
  });
  it('keeps an artifact dir that holds generated files', () => {
    const c = candidate({ path: HOMES + '/x-0123456789/cache/screenshots', kind: 'home-artifact-dir', containsFiles: true });
    expect(reasonOf(c)).toBe('artifact-dir-not-empty');
  });
});

describe('planHousekeeping — retention', () => {
  it('keeps anything newer than the retention window', () => {
    expect(reasonOf(candidate({ idleSinceMs: NOW - 29 * DAY }))).toBe('newer-than-retention');
  });
  it('deletes an orphan home once it is older than the window', () => {
    const plan = planHousekeeping([candidate({ idleSinceMs: NOW - 31 * DAY })], NOW, 30);
    expect(plan.decisions[0]).toMatchObject({ action: 'delete', reason: 'orphan-home' });
  });
  it('honours a shorter retention', () => {
    const plan = planHousekeeping([candidate({ idleSinceMs: NOW - 15 * DAY })], NOW, 14);
    expect(plan.decisions[0]!.action).toBe('delete');
  });
  it('uses the home idle time the host passes, not the file age', () => {
    const c = candidate({ path: HOMES + '/x-0123456789/models_dev_cache.json', kind: 'home-model-catalog', isDirectory: false, isRegularFile: true, idleSinceMs: NOW - 2 * DAY });
    expect(reasonOf(c)).toBe('newer-than-retention');
  });
});

describe('planHousekeeping — session homes', () => {
  it('keeps a home whose session is open / running / scheduled / pinned', () => {
    expect(reasonOf(candidate({ ownerSessionId: 'live' }), ['live'])).toBe('protected-session');
  });
  it('keeps a home whose conversation still exists', () => {
    expect(reasonOf(candidate({ ownerSessionId: 's1', conversationStatus: 'active' }))).toBe('conversation-still-exists');
    expect(reasonOf(candidate({ ownerSessionId: 's1', conversationStatus: 'archived' }))).toBe('conversation-still-exists');
  });
  it('keeps a soft-deleted conversation home because its messages survive', () => {
    expect(reasonOf(candidate({ ownerSessionId: 's1', conversationStatus: 'deleted' }))).toBe('soft-deleted-transcript-kept');
  });
  it('deletes an orphan home even when it is huge', () => {
    const plan = planHousekeeping([candidate({ sizeBytes: 1_100_000_000 })], NOW, 30);
    expect(plan.decisions[0]).toMatchObject({ action: 'delete', reason: 'orphan-home' });
    expect(plan.estimatedFreedBytes).toBe(1_100_000_000);
  });
  it('protects the bulk inside a protected home too', () => {
    const c = candidate({ path: HOMES + '/x-0123456789/cache/uv', kind: 'home-uv-cache', ownerSessionId: 'live' });
    expect(reasonOf(c, ['live'])).toBe('protected-session');
  });
});

describe('planHousekeeping — re-creatable bulk', () => {
  it('deletes an idle home catalog, uv cache, cache catalog and logs', () => {
    const kinds = ['home-model-catalog', 'home-uv-cache', 'home-cache-catalog', 'home-logs'] as const;
    for (const kind of kinds) {
      const c = candidate({ path: HOMES + '/x-0123456789/entry', kind, isDirectory: kind !== 'home-model-catalog', isRegularFile: kind === 'home-model-catalog' });
      expect(reasonOf(c)).toBe('recreatable-home-bulk');
    }
  });
  it('deletes an empty artifact dir in an idle home', () => {
    const c = candidate({ path: HOMES + '/x-0123456789/cache/images', kind: 'home-artifact-dir', containsFiles: false });
    expect(reasonOf(c)).toBe('recreatable-home-bulk');
  });
  it('deletes the base uv cache and base catalogs when idle', () => {
    expect(reasonOf(candidate({ path: BASE + '/cache/uv', root: BASE, kind: 'base-uv-cache' }))).toBe('recreatable-cache');
    expect(reasonOf(candidate({ path: BASE + '/cache/plugin-catalog.json', root: BASE, kind: 'base-cache-catalog', isDirectory: false, isRegularFile: true }))).toBe('recreatable-cache');
  });
  it('deletes an old dev-terminal log but keeps a recent one', () => {
    const old = candidate({ path: LOGS + '/dev-terminal (1).log', root: LOGS, kind: 'dev-terminal-log', isDirectory: false, isRegularFile: true });
    expect(reasonOf(old)).toBe('old-dev-terminal-log');
    expect(reasonOf({ ...old, idleSinceMs: NOW - DAY })).toBe('newer-than-retention');
  });
});

describe('planHousekeeping — newest backup per base file is always kept', () => {
  const backup = (name: string, base: string, ageDays: number): HousekeepingCandidate => candidate({
    path: HARNESS + '/' + name,
    root: HARNESS,
    kind: 'harness-backup',
    backupBase: base,
    idleSinceMs: NOW - ageDays * DAY,
    isDirectory: false,
    isRegularFile: true,
    sizeBytes: 1000,
  });

  it('keeps the newest and deletes the older ones', () => {
    const plan = planHousekeeping([
      backup('routing.yaml.bak-a', 'routing.yaml', 60),
      backup('routing.yaml.bak-b', 'routing.yaml', 45),
      backup('routing.yaml.bak-c', 'routing.yaml', 31),
    ], NOW, 30);
    expect(plan.decisions.map((d) => [d.path.split('/').pop(), d.action, d.reason])).toEqual([
      ['routing.yaml.bak-a', 'delete', 'old-backup'],
      ['routing.yaml.bak-b', 'delete', 'old-backup'],
      ['routing.yaml.bak-c', 'keep', 'newest-backup-kept'],
    ]);
  });
  it('keeps the newest even when it is older than the retention window', () => {
    const plan = planHousekeeping([backup('providers.yaml.bak-old', 'providers.yaml', 200)], NOW, 30);
    expect(plan.decisions[0]).toMatchObject({ action: 'keep', reason: 'newest-backup-kept' });
  });
  it('treats each base file independently', () => {
    const plan = planHousekeeping([
      backup('routing.yaml.bak-1', 'routing.yaml', 90),
      backup('providers.yaml.bak-1', 'providers.yaml', 90),
    ], NOW, 30);
    expect(plan.decisions.every((d) => d.action === 'keep')).toBe(true);
  });
  it('keeps a recent backup on age alone', () => {
    expect(reasonOf(backup('routing.yaml.bak-new', 'routing.yaml', 2))).toBe('newer-than-retention');
  });
  it('breaks an mtime tie deterministically regardless of scan order', () => {
    const a = backup('x.bak-a', 'x', 50);
    const b = backup('x.bak-b', 'x', 50);
    const first = planHousekeeping([a, b], NOW, 30).decisions.find((d) => d.action === 'keep')!.path;
    const second = planHousekeeping([b, a], NOW, 30).decisions.find((d) => d.action === 'keep')!.path;
    expect(first).toBe(second);
    expect(first).toBe(HARNESS + '/x.bak-b');
  });
  it('keeps a backup whose base is unknown', () => {
    expect(reasonOf({ ...backup('orphan.bak', 'x', 90), backupBase: undefined })).toBe('backup-base-unknown');
  });
  it('keeps a backup directory that is a symlink', () => {
    expect(reasonOf({ ...backup('experts.bak-x', 'experts', 90), isSymlink: true, isDirectory: false })).toBe('symlink-never-followed');
  });
});

describe('planHousekeeping — plan totals', () => {
  it('counts deletes and keeps and sums the estimated freed bytes', () => {
    const plan = planHousekeeping([
      candidate({ path: HOMES + '/a-0123456789', sizeBytes: 100 }),
      candidate({ path: HOMES + '/b-0123456789', sizeBytes: 200, ownerSessionId: 's', conversationStatus: 'active' }),
      candidate({ path: BASE + '/cache/uv', root: BASE, kind: 'base-uv-cache', sizeBytes: 300 }),
    ], NOW, 30);
    expect(plan.deleteCount).toBe(2);
    expect(plan.keepCount).toBe(1);
    expect(plan.estimatedFreedBytes).toBe(400);
    expect(plan.decisions).toHaveLength(3);
  });
  it('returns an empty plan for no candidates', () => {
    expect(planHousekeeping([], NOW, 30)).toEqual({ decisions: [], deleteCount: 0, keepCount: 0, estimatedFreedBytes: 0 });
  });
  it('does not mutate the candidates it is given', () => {
    const c = candidate();
    const snapshot = { ...c };
    planHousekeeping([c], NOW, 30);
    expect(c).toEqual(snapshot);
  });
});
