import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_PACKS,
  createLkgSnapshot,
  createNodeContext,
  createRegistry,
  listLkgSnapshots,
  pruneLkgSnapshots,
  rollbackLkgSnapshot,
  runChecks,
  type DoctorContext,
} from '../index.js';

const tempDirs: string[] = [];

async function makeTempSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-lkg-'));
  tempDirs.push(root);

  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const repoRoot = path.join(root, 'repo');

  await Promise.all([
    fs.mkdir(hermesHome, { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts', 'reviewer'), { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(repoRoot, { recursive: true }),
  ]);

  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'cindy', packageManager: 'pnpm@10.33.2+sha512.abc' }),
    'utf8',
  );

  // Valid config-layer files matching Cindy schemas
  await fs.writeFile(
    path.join(harnessDir, 'providers.yaml'),
    'providers:\n  - id: lmstudio\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'routing.yaml'),
    'routes:\n  local-small:\n    provider: lmstudio\n    model: google/gemma-4-26b-a4b-qat\nrules:\n  title: local-small\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'guardrails.yaml'),
    'policy: enforce\ndisabled: []\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'web-budget.yaml'),
    'max_searches_per_session: 25\ntool_names: [web_search]\n',
    'utf8',
  );
  await fs.writeFile(path.join(harnessDir, 'plugins.json'), '{"disabled":[]}\n', 'utf8');
  await fs.writeFile(path.join(harnessDir, 'hermes-sessions.json'), '{"sessions":{}}\n', 'utf8');
  await fs.writeFile(
    path.join(harnessDir, 'experts', 'reviewer', 'expert.md'),
    '---\nname: Reviewer\nagent: hermes\nmodel: local-small\ntoolsets: [file]\n---\n\nReview code carefully.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'experts', 'reviewer', 'tools.yaml'),
    'mcp_servers:\n  allow: [cindy_docs]\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(hermesHome, 'config.yaml'),
    'model:\n  default: google/gemma-4-26b-a4b-qat\n  provider: lmstudio\ncustom_providers:\n  - name: lmstudio\n    base_url: http://127.0.0.1:1234/v1\n',
    'utf8',
  );

  // Secret / binary / excluded files that MUST NEVER be snapshotted
  await fs.writeFile(path.join(hermesHome, '.env'), 'OPENAI_API_KEY=sk-secret-12345\n', 'utf8');
  await fs.writeFile(path.join(hermesHome, 'auth.json'), '{"token":"secret"}\n', 'utf8');
  await fs.writeFile(path.join(hermesHome, 'state.db'), 'sqlite-bytes', 'utf8');
  await fs.writeFile(path.join(hermesHome, 'state.db-wal'), 'wal-bytes', 'utf8');
  await fs.writeFile(path.join(harnessDir, 'master.key'), 'private-key', 'utf8');
  await fs.writeFile(path.join(harnessDir, 'oauth-token.json'), '{"access":"abc"}\n', 'utf8');
  await fs.writeFile(path.join(harnessDir, 'api-credential.json'), '{"k":"v"}\n', 'utf8');
  await fs.writeFile(path.join(harnessDir, 'my-secret-sessions.json'), '{"k":"v"}\n', 'utf8');
  await fs.mkdir(path.join(harnessDir, 'session-homes', 's1'), { recursive: true });
  await fs.writeFile(path.join(harnessDir, 'session-homes', 's1', 'routing.yaml'), 'noise: 1\n', 'utf8');
  await fs.mkdir(path.join(harnessDir, 'cache'), { recursive: true });
  await fs.writeFile(path.join(harnessDir, 'cache', 'routing.yaml'), 'noise: 2\n', 'utf8');
  await fs.mkdir(path.join(harnessDir, 'logs'), { recursive: true });
  await fs.writeFile(path.join(harnessDir, 'logs', 'hermes.log'), 'log\n', 'utf8');

  return { root, home, hermesHome, harnessDir, userDataDir, repoRoot };
}

function makeDoctorContext(
  sandbox: Awaited<ReturnType<typeof makeTempSandbox>>,
  opts: { now?: Date; appRunning?: boolean } = {},
): DoctorContext {
  const base = createNodeContext({
    home: sandbox.home,
    hermesHome: sandbox.hermesHome,
    harnessDir: sandbox.harnessDir,
    userDataDir: sandbox.userDataDir,
    repoRoot: sandbox.repoRoot,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: sandbox.home,
    },
    hermesPinnedVersion: '0.22.7',
    pnpmPinnedVersion: '10.33.2',
  });
  return {
    ...base,
    now: () => opts.now ?? new Date('2026-11-15T14:00:00.000Z'),
    appRunning: opts.appRunning ?? false,
    exec: async (cmd, args) => {
      if (path.basename(cmd) === 'pnpm' && args[0] === '--version') {
        return { code: 0, stdout: '10.33.2\n', stderr: '' };
      }
      if (path.basename(cmd) === 'hermes-cindy' && args[0] === '--version') {
        return { code: 0, stdout: 'Hermes Agent v0.23.0\n', stderr: '' };
      }
      return { code: 127, stdout: '', stderr: 'not mocked' };
    },
  };
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('14.5 LKG snapshots + rollback', () => {
  it('snapshots config-layer files byte-for-byte with manifest sha256/bytes and versions.json while excluding secrets and runtime dirs', async () => {
    const sandbox = await makeTempSandbox();
    const ctx = makeDoctorContext(sandbox);

    const created = await createLkgSnapshot(ctx, { reason: 'unit-test' });
    expect(created.manifest.reason).toBe('unit-test');
    expect(created.manifest.stamp).toBe('2026-11-15T14-00-00.000Z');
    expect(created.manifest.createdAt).toBe('2026-11-15T14:00:00.000Z');
    expect(created.manifest.reportCounts).toMatchObject({ ok: expect.any(Number), warn: expect.any(Number), fail: expect.any(Number) });

    const rels = created.manifest.files.map((f) => f.rel);
    expect(rels).toContain('harness/providers.yaml');
    expect(rels).toContain('harness/routing.yaml');
    expect(rels).toContain('harness/guardrails.yaml');
    expect(rels).toContain('harness/web-budget.yaml');
    expect(rels).toContain('harness/plugins.json');
    expect(rels).toContain('harness/hermes-sessions.json');
    expect(rels).toContain('harness/experts/reviewer/expert.md');
    expect(rels).toContain('harness/experts/reviewer/tools.yaml');
    expect(rels).toContain('hermes/config.yaml');

    // Verify excluded files NEVER appear in manifest or anywhere inside snapshot directory
    const serializedRels = rels.join('\n');
    expect(serializedRels).not.toMatch(/\.env|auth\.json|\.key|token|credential|secret|\.db|session-homes|cache|logs/i);

    const walkFiles = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walkFiles(p)));
        else out.push(path.relative(created.dir, p));
      }
      return out;
    };
    const diskFiles = await walkFiles(path.join(created.dir, 'files'));
    expect(diskFiles.join('\n')).not.toMatch(/\.env|auth\.json|\.key|token|credential|secret|\.db|session-homes|cache|logs/i);

    // Verify byte-exact hashes and sizes match live source files
    for (const entry of created.manifest.files) {
      const snapBytes = await fs.readFile(path.join(created.dir, 'files', entry.rel));
      expect(snapBytes.byteLength).toBe(entry.bytes);
      expect(sha256Hex(snapBytes)).toBe(entry.sha256);
    }

    const versionsRaw = JSON.parse(await fs.readFile(path.join(created.dir, 'versions.json'), 'utf8'));
    expect(versionsRaw).toHaveProperty('node');
    expect(versionsRaw).toHaveProperty('pnpm');
    expect(versionsRaw).toHaveProperty('hermes');
  });

  it('enforces retention (keep newest 20 + younger than 14 days), honors doctor.yaml, and ignores non-stamp dirs and symlinks', async () => {
    const sandbox = await makeTempSandbox();
    const lkgDir = path.join(sandbox.harnessDir, 'doctor', 'lkg');
    await fs.mkdir(lkgDir, { recursive: true });

    const baseMs = Date.parse('2026-11-15T14:00:00.000Z');
    // Create 25 directories, all > 20 days old so only lkg_keep (20) keeps them
    for (let i = 0; i < 25; i++) {
      const d = new Date(baseMs - (20 + i) * 86_400_000);
      const stamp = d.toISOString().replace(/:/g, '-');
      const dir = path.join(lkgDir, stamp);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          formatVersion: 1,
          stamp,
          createdAt: d.toISOString(),
          reason: `snap-${i}`,
          reportCounts: { ok: 1, warn: 0, fail: 0 },
          files: [],
        }),
        'utf8',
      );
    }
    // Add a recent dir (< 14 days old) + 1 non-stamp dir + 1 symlinked dir
    const recentDate = new Date(baseMs - 2 * 86_400_000);
    const recentStamp = recentDate.toISOString().replace(/:/g, '-');
    await fs.mkdir(path.join(lkgDir, recentStamp), { recursive: true });
    await fs.mkdir(path.join(lkgDir, 'manual-notes'), { recursive: true });

    const externalTarget = path.join(sandbox.root, 'external-dir');
    await fs.mkdir(externalTarget, { recursive: true });
    await fs.writeFile(path.join(externalTarget, 'keep.txt'), 'safe', 'utf8');
    await fs.symlink(externalTarget, path.join(lkgDir, '2020-01-01T00-00-00.000Z'));

    const ctx = makeDoctorContext(sandbox, { now: new Date(baseMs) });
    const pruned = await pruneLkgSnapshots(ctx);

    // 26 valid non-symlink stamp dirs (25 old + 1 recent); newest 20 kept -> oldest 6 removed.
    expect(pruned.removed.length).toBe(6);
    expect(await fs.stat(path.join(lkgDir, 'manual-notes'))).toBeTruthy();
    expect(await fs.readFile(path.join(externalTarget, 'keep.txt'), 'utf8')).toBe('safe');

    // Now test younger-than-min-days preservation even when > lkg_keep via doctor.yaml
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'doctor', 'doctor.yaml'),
      'lkg_keep: 2\nlkg_min_days: 14\n',
      'utf8',
    );
    const youngDir = path.join(lkgDir, new Date(baseMs - 5 * 86_400_000).toISOString().replace(/:/g, '-'));
    const youngDir2 = path.join(lkgDir, new Date(baseMs - 6 * 86_400_000).toISOString().replace(/:/g, '-'));
    await Promise.all([fs.mkdir(youngDir, { recursive: true }), fs.mkdir(youngDir2, { recursive: true })]);

    await pruneLkgSnapshots(ctx);
    const listed = await listLkgSnapshots(ctx);
    // All 3 directories younger than 14 days (2d, 5d, 6d) MUST survive even though lkg_keep=2!
    const keptStamps = listed.map((s) => s.stamp);
    expect(keptStamps).toContain(recentStamp);
    expect(keptStamps).toContain(path.basename(youngDir));
    expect(keptStamps).toContain(path.basename(youngDir2));
    expect(listed.length).toBe(3);
  });

  it('rolls back harness/routing.yaml atomically with .pre-rollback-<stamp>, verifies sha256, and enforces app-closed for hermes/config.yaml', async () => {
    const sandbox = await makeTempSandbox();
    const ctxSnap = makeDoctorContext(sandbox, {
      now: new Date('2026-11-15T14:00:00.000Z'),
      appRunning: false,
    });
    const originalRouting = await fs.readFile(path.join(sandbox.harnessDir, 'routing.yaml'));
    const originalHermes = await fs.readFile(path.join(sandbox.hermesHome, 'config.yaml'));

    const snap = await createLkgSnapshot(ctxSnap, { reason: 'before-edit' });

    // Break both files
    const brokenRouting = Buffer.from('default: [unclosed\n', 'utf8');
    await fs.writeFile(path.join(sandbox.harnessDir, 'routing.yaml'), brokenRouting);
    await fs.writeFile(path.join(sandbox.hermesHome, 'config.yaml'), 'broken: :\n', 'utf8');

    // App running MUST refuse restoring hermes/config.yaml
    const ctxRunning = makeDoctorContext(sandbox, {
      now: new Date('2026-11-15T14:05:00.000Z'),
      appRunning: true,
    });
    const refused = await rollbackLkgSnapshot(ctxRunning, { stamp: snap.manifest.stamp });
    expect(refused.ok).toBe(false);
    expect(refused.refusedReason).toBe('app-running');
    expect(await fs.readFile(path.join(sandbox.hermesHome, 'config.yaml'), 'utf8')).toBe('broken: :\n');

    // App running MAY restore harness/routing.yaml specifically (--file harness/routing.yaml)
    const harnessOnly = await rollbackLkgSnapshot(ctxRunning, {
      stamp: snap.manifest.stamp,
      fileRel: 'harness/routing.yaml',
    });
    expect(harnessOnly.ok).toBe(true);
    expect(await fs.readFile(path.join(sandbox.harnessDir, 'routing.yaml'))).toEqual(originalRouting);
    expect(harnessOnly.movedAside.some((p) => path.basename(p).startsWith('routing.yaml.pre-rollback-'))).toBe(true);
    const asideRouting = harnessOnly.movedAside.find((p) => path.basename(p).startsWith('routing.yaml.pre-rollback-'))!;
    expect(await fs.readFile(asideRouting)).toEqual(brokenRouting);
    expect(harnessOnly.configReport?.counts.fail).toBe(1); // hermes/config.yaml still broken!

    // Now close app and restore hermes/config.yaml
    const ctxClosed = makeDoctorContext(sandbox, {
      now: new Date('2026-11-15T14:06:00.000Z'),
      appRunning: false,
    });
    const hermesRes = await rollbackLkgSnapshot(ctxClosed, {
      stamp: snap.manifest.stamp,
      fileRel: 'hermes/config.yaml',
    });
    expect(hermesRes.ok).toBe(true);
    expect(await fs.readFile(path.join(sandbox.hermesHome, 'config.yaml'))).toEqual(originalHermes);
    expect(hermesRes.configReport?.counts.fail).toBe(0);

    // Tampered snapshot copy must fail closed
    await fs.writeFile(path.join(snap.dir, 'files', 'harness', 'routing.yaml'), 'tampered: true\n', 'utf8');
    const tamperedRes = await rollbackLkgSnapshot(ctxClosed, {
      stamp: snap.manifest.stamp,
      fileRel: 'harness/routing.yaml',
    });
    expect(tamperedRes.ok).toBe(false);
    expect(tamperedRes.error).toMatch(/sha256|mismatch|integrity/i);
    expect(await fs.readFile(path.join(sandbox.harnessDir, 'routing.yaml'))).toEqual(originalRouting);
 
    // Daily hermes home path MUST always be refused
    const dailyPath = path.join(sandbox.home, ['.her', 'mes'].join(''));
    const dailyCtx = {
      ...ctxClosed,
      paths: { ...ctxClosed.paths, hermesHome: dailyPath },
    };
    await expect(createLkgSnapshot(dailyCtx, { reason: 'should-refuse' })).rejects.toThrow(/daily/i);
    await expect(
      rollbackLkgSnapshot(dailyCtx, { stamp: snap.manifest.stamp, fileRel: 'hermes/config.yaml' }),
    ).rejects.toThrow(/daily/i);
  });

  it('reports config.lkg-diff ok cleanly when no snapshot exists or matching, and warns with changed files when diverged', async () => {
    const sandbox = await makeTempSandbox();
    const ctx = makeDoctorContext(sandbox);
    const registry = createRegistry(ALL_PACKS);

    const beforeSnap = await runChecks(registry, ctx, { only: ['config.lkg-diff'] });
    expect(beforeSnap.results[0]).toMatchObject({
      id: 'config.lkg-diff',
      severity: 'ok',
    });

    await createLkgSnapshot(ctx, { reason: 'baseline' });
    const matchSnap = await runChecks(registry, ctx, { only: ['config.lkg-diff'] });
    expect(matchSnap.results[0]).toMatchObject({
      id: 'config.lkg-diff',
      severity: 'ok',
    });

    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      'default:\n  provider: lmstudio\n  model: changed-model\nroles: {}\n',
      'utf8',
    );
    const diffSnap = await runChecks(registry, ctx, { only: ['config.lkg-diff'] });
    expect(diffSnap.results[0]).toMatchObject({
      id: 'config.lkg-diff',
      severity: 'warn',
    });
    expect(diffSnap.results[0]?.summary).toContain('harness/routing.yaml');
  });
});
