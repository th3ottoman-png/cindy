/**
 * Unit tests for redacted local incident bundles (ROADMAP 14.9, blueprint §9 & §11).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNodeContext } from '../context.js';
import { createIncidentBundle } from '../incident-bundle.js';
import type { DoctorPack } from '../types.js';

const tempDirs: string[] = [];

async function makeBundleFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-bundle-'));
  tempDirs.push(root);

  const home = path.join(root, 'users', 'alice');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'Library', 'Application Support', 'CindyGlobal-dev2-private');
  const repoRoot = path.join(home, 'dev', 'Cindy');
  const desktopLogsDir = path.join(repoRoot, 'apps', 'desktop', 'logs');
  const hermesLogsDir = path.join(hermesHome, 'logs');
  const fixLogDir = path.join(harnessDir, 'doctor');

  await Promise.all([
    fs.mkdir(hermesLogsDir, { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts', 'sql-coach'), { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(desktopLogsDir, { recursive: true }),
    fs.mkdir(fixLogDir, { recursive: true }),
  ]);

  // .env with secret values that must NEVER survive anywhere in the bundle
  await fs.writeFile(
    path.join(hermesHome, '.env'),
    [
      'DEEPSEEK_API_KEY="fixture-env-secret-alpha-9988"',
      'TOKENHUB_API_KEY=fixture-env-secret-beta-7766',
      'OPENAI_BASE_URL=https://custom.secret.host/v1/org-xyz-4433',
    ].join('\n'),
    'utf8',
  );

  // §3 config files with planted secrets, URL userinfo/query, and home path
  await fs.writeFile(
    path.join(harnessDir, 'providers.yaml'),
    [
      'providers:',
      '  - id: local-lm',
      '    kind: lmstudio',
      '    baseUrl: https://alice:hunter2pw@127.0.0.1:1234/v1?api_key=querysecret77',
      '    api_key: sk-planted-yaml-secret-1234567890abcdef',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'routing.yaml'),
    'routes:\n  local-small:\n    provider: local-lm\n    model: qwen3-8b\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'vault.json'),
    JSON.stringify({
      vaultPath: path.join(home, 'Documents', 'Vault'),
      apiToken: 'vault-secret-json-11223344',
      cookie: 'session-cookie-secret-5566',
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(harnessDir, 'experts', 'sql-coach', 'expert.md'),
    `---\nname: sql-coach\nroute: local-small\n---\nPrompt home ${home}/workspace\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(hermesHome, 'config.yaml'),
    [
      'model: custom:qwen3-8b',
      'oauth_tokens:',
      '  access: hermes-nested-access-secret-9999',
      '  refresh: hermes-nested-refresh-secret-8888',
    ].join('\n'),
    'utf8',
  );

  // Older main log (must be ignored in favor of newest main-*.log)
  await fs.writeFile(
    path.join(desktopLogsDir, 'main-2026-11-10.log'),
    'OLD_MAIN_LOG_MARKER should not appear\n',
    'utf8',
  );
  // Newest main log with 210 lines + secrets in the last 200 lines
  const newestMainLines: string[] = [];
  for (let i = 1; i <= 210; i += 1) {
    if (i === 15) {
      newestMainLines.push(
        `line-${i} Authorization: Bearer bearer-secret-main-log-99999 sk-proj-mainlogsecret1234567890 ghp_mainloggithubtoken123456 owner.test@example.com home=${home}/app fixture-env-secret-alpha-9988`,
      );
    } else {
      newestMainLines.push(`main-log-line-${String(i).padStart(3, '0')}`);
    }
  }
  const newestMainPath = path.join(desktopLogsDir, 'main-2026-11-15.log');
  await fs.writeFile(newestMainPath, `${newestMainLines.join('\n')}\n`, 'utf8');
  // Ensure mtime ordering explicitly
  const tOld = new Date('2026-11-10T10:00:00Z');
  const tNew = new Date('2026-11-15T10:00:00Z');
  await fs.utimes(path.join(desktopLogsDir, 'main-2026-11-10.log'), tOld, tOld);
  await fs.utimes(newestMainPath, tNew, tNew);

  // agent.log with 205 lines + JWT + env secret + home path
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const agentLines: string[] = [];
  for (let i = 1; i <= 205; i += 1) {
    if (i === 10) {
      agentLines.push(
        `agent-line-${i} jwt=${jwt} path=${home}/.hermes-cindy/cache token=fixture-env-secret-beta-7766`,
      );
    } else {
      agentLines.push(`agent-log-line-${String(i).padStart(3, '0')}`);
    }
  }
  await fs.writeFile(path.join(hermesLogsDir, 'agent.log'), `${agentLines.join('\n')}\n`, 'utf8');

  // fix-log.jsonl with 25 lines -> only last 20 kept & redacted
  const fixLogLines: string[] = [];
  for (let i = 1; i <= 25; i += 1) {
    fixLogLines.push(
      JSON.stringify({
        at: `2026-11-15T10:00:${String(i).padStart(2, '0')}Z`,
        fixId: `fix.test.${i}`,
        target: `${home}/.cindy-harness/routing.yaml`,
        ok: true,
        secretNote: 'sk-fixlog-secret-abcdef1234567890',
      }),
    );
  }
  await fs.writeFile(path.join(fixLogDir, 'fix-log.jsonl'), `${fixLogLines.join('\n')}\n`, 'utf8');

  return { root, home, hermesHome, harnessDir, userDataDir, repoRoot };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('createIncidentBundle (ROADMAP 14.9)', () => {
  it('writes a local bundle with all 6 blueprint sections and strips secrets, .env values, and home paths', async () => {
    const fx = await makeBundleFixture();
    const slowCheckRan = { ran: false };

    const pack: DoctorPack = {
      name: 'bundle-test-pack',
      checks: [
        {
          id: 'env.node',
          layer: 'environment',
          title: 'Node runtime',
          cost: 'instant',
          run: async () => ({
            severity: 'ok',
            summary: `Node ok at ${fx.home}/bin/node`,
            evidence: { node: '22.23.4' },
          }),
        },
        {
          id: 'runtime.hermes.present',
          layer: 'runtimes',
          title: 'Hermes CLI',
          cost: 'instant',
          run: async () => ({
            severity: 'ok',
            summary: 'Hermes present',
            evidence: { version: '0.23.0', path: `${fx.home}/.local/bin/hermes-cindy` },
          }),
        },
        {
          id: 'endpoint.slow-probe',
          layer: 'endpoints',
          title: 'Slow check included by --all',
          cost: 'slow',
          run: async () => {
            slowCheckRan.ran = true;
            return {
              severity: 'warn',
              summary: 'Slow check ran as expected for bundle',
              detail: 'bearer Bearer inline-check-bearer-99999',
            };
          },
        },
      ],
    };

    const ctx = createNodeContext({
      home: fx.home,
      hermesHome: fx.hermesHome,
      harnessDir: fx.harnessDir,
      userDataDir: fx.userDataDir,
      repoRoot: fx.repoRoot,
      env: {
        HOME: fx.home,
        PATH: '/usr/bin:/bin',
        MY_UNRELATED_API_KEY: 'env-api-key-secret-55443322',
      },
    });
    const fixedCtx = {
      ...ctx,
      now: () => new Date('2026-11-15T18:30:00.000Z'),
    };

    const result = await createIncidentBundle(fixedCtx, { packs: [pack] });

    // Bundle ran slow checks (--all) and wrote locally to ~/.cindy-harness/doctor/bundles/<stamp>.md
    expect(slowCheckRan.ran).toBe(true);
    expect(result.path).toBe(
      path.join(fx.harnessDir, 'doctor', 'bundles', '2026-11-15T18-30-00.000Z.md'),
    );
    expect(result.displayPath).toBe('~/.cindy-harness/doctor/bundles/2026-11-15T18-30-00.000Z.md');

    const diskContent = await fs.readFile(result.path, 'utf8');
    expect(diskContent).toBe(result.markdown);

    // Section 1: Agent header
    expect(diskContent).toContain('# Cindy Doctor Incident Bundle');
    expect(diskContent).toContain('AGENTS.md');
    expect(diskContent).toContain('HANDOVER.md');
    expect(diskContent).toContain('~/.hermes-cindy');

    // Section 2: Full --all report
    expect(diskContent).toContain('## Diagnostic Report (--all)');
    expect(diskContent).toContain('`endpoint.slow-probe`');

    // Section 3: versions.json
    expect(diskContent).toContain('## Versions (`versions.json`)');
    expect(diskContent).toContain('"version": "0.23.0"');
    expect(diskContent).toContain('"path": "~/.local/bin/hermes-cindy"');

    // Section 4: Configs redacted + .env key names only
    expect(diskContent).toContain('## Configs (§3, redacted)');
    expect(diskContent).toContain('### Environment files (key names only, values omitted)');
    expect(diskContent).toContain('`DEEPSEEK_API_KEY`');
    expect(diskContent).toContain('`TOKENHUB_API_KEY`');
    expect(diskContent).toContain('`OPENAI_BASE_URL`');
    expect(diskContent).toContain('### `harness/providers.yaml`');
    expect(diskContent).toContain('### `hermes/config.yaml`');
    expect(diskContent).toContain('https://127.0.0.1:1234/v1');

    // Section 5: Last 200 lines of newest main-*.log & agent.log
    expect(diskContent).toContain('### Desktop main log (`~/dev/Cindy/apps/desktop/logs/main-2026-11-15.log`)');
    expect(diskContent).not.toContain('OLD_MAIN_LOG_MARKER');
    expect(diskContent).not.toContain('main-log-line-010');
    expect(diskContent).toContain('main-log-line-011');
    expect(diskContent).toContain('main-log-line-210');

    expect(diskContent).toContain('### Hermes agent log (`~/.hermes-cindy/logs/agent.log`)');
    expect(diskContent).not.toContain('agent-log-line-005');
    expect(diskContent).toContain('agent-log-line-006');
    expect(diskContent).toContain('agent-log-line-205');

    // Section 6: Last 20 lines of fix-log.jsonl
    expect(diskContent).toContain('## Fix log (last 20 lines, `~/.cindy-harness/doctor/fix-log.jsonl`)');
    expect(diskContent).not.toContain('"fix.test.5"');
    expect(diskContent).toContain('"fix.test.6"');
    expect(diskContent).toContain('"fix.test.25"');

    // Planted secrets, .env values, tokens, emails, and real home paths MUST all be gone
    const forbidden = [
      fx.home,
      'fixture-env-secret-alpha-9988',
      'fixture-env-secret-beta-7766',
      'https://custom.secret.host/v1/org-xyz-4433',
      'hunter2pw',
      'querysecret77',
      'sk-planted-yaml-secret',
      'vault-secret-json-11223344',
      'session-cookie-secret-5566',
      'hermes-nested-access-secret-9999',
      'hermes-nested-refresh-secret-8888',
      'bearer-secret-main-log-99999',
      'sk-proj-mainlogsecret1234567890',
      'ghp_mainloggithubtoken123456',
      'owner.test@example.com',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'sk-fixlog-secret-abcdef1234567890',
      'inline-check-bearer-99999',
      'env-api-key-secret-55443322',
    ];
    for (const secret of forbidden) {
      expect(diskContent).not.toContain(secret);
    }
  });

  it('refuses daily Hermes home before reading any files', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bundle-refuse-'));
    tempDirs.push(tmp);
    const home = path.join(tmp, 'home');
    const dailyHermes = path.join(home, '.her' + 'mes');
    const ctx = createNodeContext({
      home,
      hermesHome: dailyHermes,
      harnessDir: path.join(home, '.cindy-harness'),
      userDataDir: path.join(home, 'userdata'),
      repoRoot: tmp,
    });

    await expect(createIncidentBundle(ctx)).rejects.toThrow(/daily Hermes home/i);
  });
});
